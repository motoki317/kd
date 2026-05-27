package store

import (
	"context"
	"slices"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/motoki317/kd/internal/kube/graph"
)

func ns(name string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

func pod(namespace, name, node string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: name, UID: types.UID(name)},
		Spec:       corev1.PodSpec{NodeName: node},
	}
}

func startTestStore(t *testing.T, objs ...runtime.Object) *Cache {
	t.Helper()
	c := New(fake.NewSimpleClientset(objs...), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("start store: %v", err)
	}
	return c
}

func TestStoreListNamespaces(t *testing.T) {
	c := startTestStore(t, ns("alpha"), ns("beta"))
	got := c.ListNamespaces()
	if want := []string{"alpha", "beta"}; !slices.Equal(got, want) {
		t.Errorf("ListNamespaces() = %v, want %v", got, want)
	}
}

func TestStoreSnapshotNamespace(t *testing.T) {
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-1", UID: "node1"}}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "alpha", Name: "web", UID: "dep1"}}
	c := startTestStore(t,
		ns("alpha"), ns("beta"),
		node,
		dep,
		pod("alpha", "web-1", "node-1"),
		pod("beta", "other-1", "node-1"),
	)

	g := graph.Build(c.SnapshotNamespace("alpha"))

	kinds := map[string]int{}
	for _, n := range g.Nodes {
		kinds[n.Kind]++
		if n.Namespace == "beta" {
			t.Errorf("snapshot of alpha leaked a beta resource: %s/%s", n.Kind, n.Name)
		}
	}
	if kinds["Deployment"] != 1 {
		t.Errorf("want 1 Deployment in alpha snapshot, got %d", kinds["Deployment"])
	}
	if kinds["Pod"] != 1 {
		t.Errorf("want 1 Pod in alpha snapshot, got %d", kinds["Pod"])
	}
	if kinds["Node"] != 1 {
		t.Errorf("want cluster-scoped Node included, got %d", kinds["Node"])
	}
}
