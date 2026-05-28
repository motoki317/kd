package registry_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/motoki317/kd/internal/kube/registry"
)

func TestInClusterServesSingleContext(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}})
	r := registry.NewInCluster(client, 0)

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
	if got := cache.ListNamespaces(); len(got) != 1 || got[0] != "shop" {
		t.Errorf("cache namespaces = %v, want [shop]", got)
	}
	// Unknown context name is rejected, even in in-cluster mode.
	if _, err := r.Get(ctx, "prod"); !errors.Is(err, registry.ErrUnknownContext) {
		t.Errorf("Get unknown context error = %v, want ErrUnknownContext", err)
	}
}

// TestConcurrentGetBuildsOnce verifies that concurrent first-callers share a single build —
// the registry must not double-instantiate a store.Cache (which would spawn duplicate informers).
func TestConcurrentGetBuildsOnce(t *testing.T) {
	var builds int32
	client := fake.NewSimpleClientset()
	r := registry.NewWithBuilder("alpha", []string{"alpha"}, 0, func(name string) (kubernetes.Interface, error) {
		atomic.AddInt32(&builds, 1)
		return client, nil
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
	loader := registry.NewWithBuilder("alpha", []string{"alpha", "beta"}, 0, func(string) (kubernetes.Interface, error) {
		return fake.NewSimpleClientset(), nil
	})
	if _, err := loader.Get(context.Background(), "gamma"); !errors.Is(err, registry.ErrUnknownContext) {
		t.Errorf("err = %v, want ErrUnknownContext", err)
	}
}

func TestBuildErrorSurfacesInList(t *testing.T) {
	want := errors.New("boom")
	r := registry.NewWithBuilder("alpha", []string{"alpha"}, 0, func(string) (kubernetes.Interface, error) {
		return nil, want
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
