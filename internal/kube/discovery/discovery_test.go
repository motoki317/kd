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
