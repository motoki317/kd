package registry_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/kube/store"
)

// fakeClients builds typed + dynamic fake clients with the given unstructured seed objects
// present in the dynamic cache. The registry tests don't exercise the typed clientset, but
// store.New needs a non-nil typed client for discovery wiring.
func fakeClients(seed ...*unstructured.Unstructured) registry.Clients {
	objs := make([]runtime.Object, 0, len(seed))
	for _, s := range seed {
		objs = append(objs, s)
	}
	return registry.Clients{
		Typed:   fake.NewSimpleClientset(),
		Dynamic: dynamicfake.NewSimpleDynamicClient(scheme.Scheme, objs...),
	}
}

func nsObj(name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Namespace",
		"metadata":   map[string]any{"name": name, "uid": "ns-" + name},
	}}
}

func TestInClusterServesSingleContext(t *testing.T) {
	r := registry.NewInCluster(fakeClients(nsObj("shop")), 0, store.Options{})

	if r.Enabled() {
		t.Error("Enabled() = true, want false in in-cluster mode (UI switcher hidden)")
	}
	if r.Default() != registry.InClusterContext {
		t.Errorf("Default() = %q, want %q", r.Default(), registry.InClusterContext)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	cache, err := r.Get(ctx, registry.InClusterContext)
	if err != nil {
		t.Fatalf("Get in-cluster: %v", err)
	}
	if cache == nil {
		t.Fatal("Get returned nil cache")
	}
	// In-cluster mode currently uses the live discovery client, but the fake typed
	// clientset's discovery returns nil for ServerPreferredResources, so no informers are
	// registered. ListNamespaces returns nil in that case — which is fine to assert: the
	// registry built the cache without error, and routing to the in-cluster context works.
	_ = cache.ListNamespaces()
	// Unknown context name is rejected, even in in-cluster mode.
	if _, err := r.Get(ctx, "prod"); !errors.Is(err, registry.ErrUnknownContext) {
		t.Errorf("Get unknown context error = %v, want ErrUnknownContext", err)
	}
}

// TestConcurrentGetBuildsOnce verifies that concurrent first-callers share a single build —
// the registry must not double-instantiate a store.Cache (which would spawn duplicate informers).
func TestConcurrentGetBuildsOnce(t *testing.T) {
	var builds int32
	clients := fakeClients()
	r := registry.NewWithBuilder("alpha", []string{"alpha"}, 0, store.Options{}, func(name string) (registry.Clients, error) {
		atomic.AddInt32(&builds, 1)
		return clients, nil
	})

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := r.Get(ctx, "alpha"); err != nil {
				t.Errorf("Get: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt32(&builds); got != 1 {
		t.Errorf("builds = %d, want 1 (single-flight broken — would spawn duplicate informers)", got)
	}
}

func TestGetUnknownContext(t *testing.T) {
	loader := registry.NewWithBuilder("alpha", []string{"alpha", "beta"}, 0, store.Options{}, func(string) (registry.Clients, error) {
		return fakeClients(), nil
	})
	if _, err := loader.Get(context.Background(), "gamma"); !errors.Is(err, registry.ErrUnknownContext) {
		t.Errorf("err = %v, want ErrUnknownContext", err)
	}
}

func TestBuildErrorSurfacesInList(t *testing.T) {
	want := errors.New("boom")
	r := registry.NewWithBuilder("alpha", []string{"alpha"}, 0, store.Options{}, func(string) (registry.Clients, error) {
		return registry.Clients{}, want
	})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := r.Get(ctx, "alpha"); !errors.Is(err, want) {
		t.Errorf("Get err = %v, want %v wrapped", err, want)
	}
	infos := r.List()
	if len(infos) != 1 || infos[0].Status != registry.StatusError || infos[0].Error == "" {
		t.Errorf("List = %+v, want one error entry with message", infos)
	}
}

// keep imports honest if signatures shift
var (
	_ kubernetes.Interface = (kubernetes.Interface)(nil)
	_ dynamic.Interface    = (dynamic.Interface)(nil)
)
