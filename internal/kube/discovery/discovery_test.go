package discovery

import (
	"context"
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// stubDiscovery satisfies the only DiscoveryInterface method clientDiscoverer calls. The
// stock client-go FakeDiscovery returns nil for ServerPreferredResources, which is what
// kd actually uses (we want preferred versions, not every version).
type stubDiscovery struct {
	discovery.DiscoveryInterface
	resources []*metav1.APIResourceList
}

func (s *stubDiscovery) ServerPreferredResources() ([]*metav1.APIResourceList, error) {
	return s.resources, nil
}

func TestFromClientFiltersAndSorts(t *testing.T) {
	stub := &stubDiscovery{resources: []*metav1.APIResourceList{
		{
			GroupVersion: "v1",
			APIResources: []metav1.APIResource{
				{Name: "pods", Kind: "Pod", Namespaced: true, ShortNames: []string{"po"}, Verbs: metav1.Verbs{"get", "list", "watch"}},
				{Name: "pods/log", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"get"}},
				{Name: "nodes", Kind: "Node", Namespaced: false, Verbs: metav1.Verbs{"get", "list", "watch"}},
				{Name: "componentstatuses", Kind: "ComponentStatus", Namespaced: false, Verbs: metav1.Verbs{"get", "list"}},
			},
		},
		{
			GroupVersion: "argoproj.io/v1alpha1",
			APIResources: []metav1.APIResource{
				{Name: "workflows", Kind: "Workflow", Namespaced: true, Verbs: metav1.Verbs{"get", "list", "watch"}},
			},
		},
	}}

	got, err := FromClient(stub).Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}

	want := []Resource{
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}, Kind: "Node", Namespaced: false},
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true, ShortNames: []string{"po"}},
		{GVR: schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "workflows"}, Kind: "Workflow", Namespaced: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Discover() filtered/sorted result mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestStatic(t *testing.T) {
	res := []Resource{
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
	}
	d := Static(res)
	got, err := d.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if !reflect.DeepEqual(got, res) {
		t.Errorf("Static().Discover() = %v, want %v", got, res)
	}
}

func TestCachedDelegates(t *testing.T) {
	res := []Resource{
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
	}
	c := NewCached(Static(res))
	got, err := c.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if !reflect.DeepEqual(got, res) {
		t.Errorf("Discover() = %v, want %v", got, res)
	}
}

func TestCachedSerializes(t *testing.T) {
	// Two concurrent Discover calls on the same Cached must not race in the underlying
	// discoverer; the mutex serializes them. We assert by observing that the inner
	// discoverer's call counter increments cleanly under -race.
	var calls int
	c := NewCached(counterDiscoverer{calls: &calls})
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, _ = c.Discover(context.Background())
			done <- struct{}{}
		}()
	}
	<-done
	<-done
	if calls != 2 {
		t.Errorf("Cached.Discover should delegate each call: got %d, want 2", calls)
	}
}

type counterDiscoverer struct{ calls *int }

func (c counterDiscoverer) Discover(context.Context) ([]Resource, error) {
	*c.calls++
	return nil, nil
}

// isSubresource keys solely on a "/" in the resource name — "pods/status", "deployments/scale" are
// subresources kd must not list/watch as top-level objects; a bare name is a real resource.
func TestIsSubresource(t *testing.T) {
	cases := map[string]bool{
		"pods":              false,
		"deployments":       false,
		"pods/status":       true,
		"pods/log":          true,
		"deployments/scale": true,
	}
	for name, want := range cases {
		if got := isSubresource(metav1.APIResource{Name: name}); got != want {
			t.Errorf("isSubresource(%q) = %v, want %v", name, got, want)
		}
	}
}
