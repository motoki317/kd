package graph

import (
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
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

// AsTyped / AsTypedSlice are the exported entry points used by the events/log handlers that walk
// a snapshot directly (not through Build). Pin their contract head-on: a known unstructured kind
// converts to its typed struct, an already-typed object and an unknown CR both pass through by
// identity, nil maps to nil, and the input slice is never mutated.
func TestAsTypedSlice(t *testing.T) {
	podU := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "web", "namespace": "shop", "uid": "pod-uid"},
		"status":   map[string]any{"phase": "Running"},
	}}
	crU := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{"name": "wf", "namespace": "shop", "uid": "wf-uid"},
	}}
	alreadyTyped := &corev1.Service{}
	in := []runtime.Object{podU, crU, alreadyTyped}

	out := AsTypedSlice(in)
	if len(out) != 3 {
		t.Fatalf("AsTypedSlice len = %d, want 3", len(out))
	}
	if _, ok := out[0].(*corev1.Pod); !ok {
		t.Errorf("known unstructured Pod = %T, want *corev1.Pod", out[0])
	}
	if u, ok := out[1].(*unstructured.Unstructured); !ok || u != crU {
		t.Errorf("unknown CR = %T (want the same *Unstructured passed through)", out[1])
	}
	if out[2] != alreadyTyped {
		t.Error("an already-typed object must pass through by identity")
	}
	// The input slice's elements must be untouched (AsTypedSlice returns a new slice).
	if in[0] != podU {
		t.Error("AsTypedSlice mutated its input slice")
	}
	if AsTypedSlice(nil) != nil {
		t.Error("AsTypedSlice(nil) must be nil")
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
