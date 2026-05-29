package store

import (
	"context"
	"slices"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/motoki317/kd/internal/kube/discovery"
)

// fixedResources is the closed set of GVRs the store tests pretend the cluster exposes —
// just enough to exercise namespace listing, namespace snapshots, ride-along, and change
// notifications without dragging in the live discovery API.
var fixedResources = []discovery.Resource{
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}, Kind: "Namespace", Namespaced: false},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}, Kind: "Node", Namespaced: false},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, Kind: "Deployment", Namespaced: true},
}

// uns builds a *unstructured.Unstructured with the given GVK + metadata + extra fields, so
// tests don't have to spell out the boilerplate map structure.
func uns(apiVersion, kind, namespace, name, uid string, extra map[string]any) *unstructured.Unstructured {
	obj := map[string]any{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata": map[string]any{
			"name": name,
		},
	}
	if namespace != "" {
		obj["metadata"].(map[string]any)["namespace"] = namespace
	}
	if uid != "" {
		obj["metadata"].(map[string]any)["uid"] = uid
	}
	for k, v := range extra {
		obj[k] = v
	}
	return &unstructured.Unstructured{Object: obj}
}

func ns(name string) *unstructured.Unstructured {
	return uns("v1", "Namespace", "", name, "ns-"+name, nil)
}

func pod(namespace, name, nodeName string) *unstructured.Unstructured {
	return uns("v1", "Pod", namespace, name, "pod-"+name, map[string]any{
		"spec": map[string]any{"nodeName": nodeName},
	})
}

func node(name string) *unstructured.Unstructured {
	return uns("v1", "Node", "", name, "node-"+name, nil)
}

func deployment(namespace, name string) *unstructured.Unstructured {
	return uns("apps/v1", "Deployment", namespace, name, "dep-"+name, nil)
}

// startTestStore wires up a Cache against a fake dynamic client + a static discoverer that
// reports only fixedResources, then waits for the initial sync.
func startTestStore(t *testing.T, objs ...runtime.Object) *Cache {
	t.Helper()
	// Use the cluster scheme so the dynamic fake knows how to list/watch each GVR.
	dynClient := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, objs...)
	c := New(fake.NewSimpleClientset(), dynClient, discovery.Static(fixedResources), Options{})
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

func TestStoreSnapshotNamespaceFiltersByNamespace(t *testing.T) {
	c := startTestStore(t,
		ns("alpha"), ns("beta"),
		deployment("alpha", "web"),
		pod("alpha", "web-1", "node-1"),
		pod("beta", "other-1", "node-1"),
	)
	objs := c.SnapshotNamespace("alpha")

	kinds := kindCounts(objs)
	if kinds["Deployment"] != 1 {
		t.Errorf("want 1 Deployment in alpha snapshot, got %d", kinds["Deployment"])
	}
	if kinds["Pod"] != 1 {
		t.Errorf("want 1 Pod in alpha snapshot, got %d", kinds["Pod"])
	}
	for _, o := range objs {
		u := o.(*unstructured.Unstructured)
		if u.GetNamespace() == "beta" {
			t.Errorf("snapshot of alpha leaked a beta resource: %s/%s", u.GetKind(), u.GetName())
		}
	}
}

func TestStoreSnapshotRideAlongNodeViaPodNodeName(t *testing.T) {
	// A Node ride-alongs into a per-namespace snapshot only when a Pod in that namespace
	// references it via spec.nodeName — the explicit reference policy that replaces the
	// old "always include every Node" behavior. A Node unreferenced by any pod here stays
	// out, even though it's in the cluster cache.
	c := startTestStore(t,
		ns("alpha"),
		node("node-1"),
		node("orphan-node"),
		pod("alpha", "web-1", "node-1"),
	)
	objs := c.SnapshotNamespace("alpha")

	var nodeNames []string
	for _, o := range objs {
		u := o.(*unstructured.Unstructured)
		if u.GetKind() == "Node" {
			nodeNames = append(nodeNames, u.GetName())
		}
	}
	if want := []string{"node-1"}; !slices.Equal(nodeNames, want) {
		t.Errorf("ride-along node names = %v, want %v (orphan-node should not appear)", nodeNames, want)
	}
}

func TestStoreSnapshotCluster(t *testing.T) {
	c := startTestStore(t,
		ns("alpha"),
		node("node-1"),
		pod("alpha", "web-1", "node-1"),
	)
	clusterObjs := c.SnapshotCluster()
	kinds := kindCounts(clusterObjs)
	if kinds["Node"] != 1 {
		t.Errorf("want 1 Node in cluster snapshot, got %d", kinds["Node"])
	}
	if kinds["Namespace"] != 1 {
		t.Errorf("want 1 Namespace in cluster snapshot, got %d", kinds["Namespace"])
	}
	if kinds["Pod"] != 0 {
		t.Errorf("Pods are namespaced and should not appear in cluster snapshot, got %d", kinds["Pod"])
	}
}

func TestStoreSnapshotClusterSentinel(t *testing.T) {
	// SnapshotNamespace(ClusterScope) is the same as SnapshotCluster — API handlers use
	// the sentinel namespace name to route into the cluster scope.
	c := startTestStore(t, ns("alpha"), node("node-1"))
	if len(c.SnapshotNamespace(ClusterScope)) == 0 {
		t.Error("SnapshotNamespace(ClusterScope) returned empty; want cluster-scoped objects")
	}
}

func TestStoreSubscribeReceivesChange(t *testing.T) {
	dynClient := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, ns("alpha"))
	c := New(fake.NewSimpleClientset(), dynClient, discovery.Static(fixedResources), Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}

	ch, unsubscribe := c.Subscribe()
	defer unsubscribe()

	// Creating a pod via the dynamic client should fan a change signal out.
	podGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	if _, err := dynClient.Resource(podGVR).Namespace("alpha").Create(ctx, pod("alpha", "new", "node-1"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("create pod: %v", err)
	}
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("did not receive change signal after pod creation")
	}

	unsubscribe()
	if _, ok := <-ch; ok {
		t.Error("channel should be closed after unsubscribe")
	}
}

func TestStoreSkipKindsExcludesFromEager(t *testing.T) {
	// Resources whose name appears in SkipKinds (on top of DefaultSkipKinds) do not get
	// an informer at startup, so their objects are absent from snapshots.
	dynClient := dynamicfake.NewSimpleDynamicClient(scheme.Scheme,
		ns("alpha"), deployment("alpha", "web"),
	)
	c := New(fake.NewSimpleClientset(), dynClient, discovery.Static(fixedResources),
		Options{SkipKinds: []string{"deployments"}},
	)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	if err := c.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	objs := c.SnapshotNamespace("alpha")
	if got := kindCounts(objs)["Deployment"]; got != 0 {
		t.Errorf("Deployment in SkipKinds should not appear in snapshot, got %d", got)
	}
}

// TestStoreGroupForKindDeterministic locks the security-relevant invariant that two
// registered resources sharing a Kind always resolve to the same group across calls (and
// map iteration orders). Without sorting, a malicious CRD registering "Pod" in a foreign
// group could intermittently shadow the core group's Pod for policy decisions.
//
// We populate c.resources directly instead of going through Start — the dynamic fake
// doesn't know about the synthetic evil.example.com Pod GVR, and the property under test
// is independent of informer wiring.
func TestStoreGroupForKindDeterministic(t *testing.T) {
	c := New(fake.NewSimpleClientset(), dynamicfake.NewSimpleDynamicClient(scheme.Scheme), discovery.Static(nil), Options{})
	for _, gvr := range []schema.GroupVersionResource{
		{Group: "evil.example.com", Version: "v1", Resource: "pods"},
		{Group: "", Version: "v1", Resource: "pods"},
	} {
		c.resources[gvr] = Resource{GVR: gvr, Kind: "Pod", Namespaced: true}
	}
	// Repeated calls must agree, and the result must be the lexicographically smallest
	// group ("" sorts before "evil.example.com").
	for i := 0; i < 50; i++ {
		got, ok := c.GroupForKind("Pod")
		if !ok || got != "" {
			t.Fatalf("GroupForKind(Pod) iter %d = (%q, %v), want (\"\", true)", i, got, ok)
		}
	}
}

// TestStoreKindShortNames checks the client-facing kind→short-name map: kinds with API short
// names appear (first short wins), kinds without are omitted, and a Kind collision resolves to
// the lexicographically smallest group like GroupForKind. Populated directly for the same reason
// as the determinism test — the property is independent of informer wiring.
func TestStoreKindShortNames(t *testing.T) {
	c := New(fake.NewSimpleClientset(), dynamicfake.NewSimpleDynamicClient(scheme.Scheme), discovery.Static(nil), Options{})
	c.resources[schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}] =
		Resource{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}, Kind: "ConfigMap", ShortNames: []string{"cm"}}
	c.resources[schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}] =
		Resource{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}, Kind: "Secret"} // no short name
	// Collision: a foreign group also claims "ConfigMap" with a different short name. The core
	// group ("") sorts first and must win deterministically.
	c.resources[schema.GroupVersionResource{Group: "evil.example.com", Version: "v1", Resource: "configmaps"}] =
		Resource{GVR: schema.GroupVersionResource{Group: "evil.example.com", Version: "v1", Resource: "configmaps"}, Kind: "ConfigMap", ShortNames: []string{"evilcm"}}

	for i := 0; i < 50; i++ {
		got := c.KindShortNames()
		if got["ConfigMap"] != "cm" {
			t.Fatalf("iter %d: ConfigMap short = %q, want %q", i, got["ConfigMap"], "cm")
		}
		if _, ok := got["Secret"]; ok {
			t.Fatalf("iter %d: Secret should be omitted (no API short name), got %q", i, got["Secret"])
		}
	}
}

// kindCounts tallies kinds across a snapshot, so assertions stay terse.
func kindCounts(objs []runtime.Object) map[string]int {
	out := map[string]int{}
	for _, o := range objs {
		u, ok := o.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		out[u.GetKind()]++
	}
	return out
}

var _ dynamic.Interface = (dynamic.Interface)(nil) // keep dynamic import used even if test names change
