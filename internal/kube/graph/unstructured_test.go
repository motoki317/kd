package graph

import (
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// TestBuildUnstructuredParity proves that feeding Build a snapshot of
// *unstructured.Unstructured (the shape the dynamic-informer store yields in production)
// produces the same Graph as feeding it the equivalent typed objects (the shape YAML
// fixtures decode into). The conversion shim at the top of Build is the only thing
// keeping the typed per-kind logic working under the dynamic-informer store.
func TestBuildUnstructuredParity(t *testing.T) {
	typed := decodeFixture(t, ownershipFixture)
	uns := toUnstructuredSlice(t, typed)
	wantG := Build(typed)
	gotG := Build(uns)

	if !reflect.DeepEqual(gotG, wantG) {
		t.Errorf("Build(unstructured) != Build(typed)\ngot:  %#v\nwant: %#v", gotG, wantG)
	}
}

// TestBuildCRPassesThroughAsUnstructured proves that a CR (kind kd has no typed factory
// for) keeps its unstructured shape through Build, so the CR-specific code paths (health
// heuristic, edge inferrer) can run on it. We check the resulting node has the right kind
// and that no panic happens on a status-less object.
func TestBuildCRPassesThroughAsUnstructured(t *testing.T) {
	cr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Workflow",
		"metadata":   map[string]any{"name": "hello", "namespace": "shop", "uid": "wf-uid"},
		"spec":       map[string]any{},
	}}
	g := Build([]runtime.Object{cr})
	if len(g.Nodes) != 1 {
		t.Fatalf("Build CR: got %d nodes, want 1", len(g.Nodes))
	}
	n := g.Nodes[0]
	if n.Kind != "Workflow" || n.APIVersion != "argoproj.io/v1alpha1" || n.Namespace != "shop" || n.Name != "hello" {
		t.Errorf("CR node = %+v, want a Workflow argoproj.io/v1alpha1 shop/hello", n)
	}
}

// TestPersistentVolumeUnstructuredRoundTrip verifies that a PV coming through the dynamic
// store (as *unstructured.Unstructured) is correctly converted back to *corev1.PersistentVolume
// so pvHealth and pvStatus can run their typed path rather than falling through to crHealth.
func TestPersistentVolumeUnstructuredRoundTrip(t *testing.T) {
	pvU := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "PersistentVolume",
		"metadata":   map[string]any{"name": "pv-1", "uid": "pv-uid"},
		"spec": map[string]any{
			"capacity": map[string]any{"storage": "20Gi"},
		},
		"status": map[string]any{"phase": "Bound"},
	}}
	g := Build([]runtime.Object{pvU})
	if len(g.Nodes) != 1 {
		t.Fatalf("PV Build: got %d nodes, want 1", len(g.Nodes))
	}
	n := g.Nodes[0]
	if n.Kind != "PersistentVolume" {
		t.Errorf("PV node.Kind = %q, want PersistentVolume", n.Kind)
	}
	if n.Health != HealthHealthy {
		t.Errorf("PV health = %q, want Healthy (Bound phase)", n.Health)
	}
	if n.Status != "Bound 20Gi" {
		t.Errorf("PV status = %q, want \"Bound 20Gi\"", n.Status)
	}
}

// toUnstructuredSlice converts typed objects to their unstructured-map form via the
// default converter, mirroring what an informer's reflector would yield through the
// dynamic factory.
func toUnstructuredSlice(t *testing.T, typed []runtime.Object) []runtime.Object {
	t.Helper()
	out := make([]runtime.Object, 0, len(typed))
	for _, obj := range typed {
		m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
		if err != nil {
			t.Fatalf("ToUnstructured: %v", err)
		}
		// The converter drops apiVersion/kind when TypeMeta is empty (which is the
		// case for scheme-decoded fixtures): re-stamp from the Go type so the round-trip
		// preserves them, matching what an informer would produce.
		u := &unstructured.Unstructured{Object: m}
		if u.GetKind() == "" {
			apiVersion, kind := GVKOf(obj)
			u.SetAPIVersion(apiVersion)
			u.SetKind(kind)
		}
		out = append(out, u)
	}
	return out
}
