package store

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/cache"
)

func TestStripForCacheRemovesManagedFieldsAndLastApplied(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name":          "cm",
			"managedFields": []any{map[string]any{"manager": "kubectl"}},
			"annotations": map[string]any{
				"kubectl.kubernetes.io/last-applied-configuration": "{...}",
				"keep": "me",
			},
		},
		"data": map[string]any{"k": "v"},
	}}
	out, err := stripForCache(u)
	if err != nil {
		t.Fatalf("stripForCache: %v", err)
	}
	got := out.(*unstructured.Unstructured)
	md := got.Object["metadata"].(map[string]any)
	if _, ok := md["managedFields"]; ok {
		t.Error("managedFields should be stripped")
	}
	ann := md["annotations"].(map[string]any)
	if _, ok := ann["kubectl.kubernetes.io/last-applied-configuration"]; ok {
		t.Error("last-applied-configuration should be stripped")
	}
	if ann["keep"] != "me" {
		t.Error("unrelated annotations must be preserved")
	}
	if got.Object["data"].(map[string]any)["k"] != "v" {
		t.Error("object data must be preserved")
	}
}

func TestStripForCacheDropsAnnotationsMapWhenEmptied(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"kind": "Pod",
		"metadata": map[string]any{
			"name": "p",
			"annotations": map[string]any{
				"kubectl.kubernetes.io/last-applied-configuration": "{...}",
			},
		},
	}}
	out, _ := stripForCache(u)
	md := out.(*unstructured.Unstructured).Object["metadata"].(map[string]any)
	if _, ok := md["annotations"]; ok {
		t.Error("an annotations map left empty after stripping should be removed entirely")
	}
}

func TestStripForCacheStripsCRDSchemaButKeepsEssence(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiextensions.k8s.io/v1",
		"kind":       "CustomResourceDefinition",
		"metadata":   map[string]any{"name": "widgets.example.com"},
		"spec": map[string]any{
			"group": "example.com",
			"names": map[string]any{"plural": "widgets", "kind": "Widget"},
			"scope": "Namespaced",
			"versions": []any{
				map[string]any{
					"name":   "v1",
					"served": true,
					"schema": map[string]any{"openAPIV3Schema": map[string]any{"type": "object"}},
				},
			},
		},
	}}
	out, _ := stripForCache(u)
	got := out.(*unstructured.Unstructured)
	versions, _, _ := unstructured.NestedSlice(got.Object, "spec", "versions")
	v0 := versions[0].(map[string]any)
	if _, ok := v0["schema"]; ok {
		t.Error("CRD version schema should be stripped")
	}
	// The essence crdSummary/removeResourcesForCRD rely on must survive.
	if v0["name"] != "v1" || v0["served"] != true {
		t.Error("CRD version name/served must be preserved")
	}
	if g, _, _ := unstructured.NestedString(got.Object, "spec", "group"); g != "example.com" {
		t.Error("CRD spec.group must be preserved")
	}
	if p, _, _ := unstructured.NestedString(got.Object, "spec", "names", "plural"); p != "widgets" {
		t.Error("CRD spec.names.plural must be preserved")
	}
}

func TestStripForCachePassesTombstonesAndNonUnstructured(t *testing.T) {
	tomb := cache.DeletedFinalStateUnknown{Key: "ns/name"}
	if out, _ := stripForCache(tomb); out == nil {
		t.Error("tombstones must pass through unchanged")
	}
	if out, _ := stripForCache("not an object"); out != "not an object" {
		t.Error("non-unstructured input must pass through unchanged")
	}
}

func TestStripForCacheIsIdempotent(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]any{
		"kind":     "CustomResourceDefinition",
		"metadata": map[string]any{"name": "w", "managedFields": []any{"x"}},
		"spec":     map[string]any{"versions": []any{map[string]any{"name": "v1", "schema": map[string]any{}}}},
	}}
	first, _ := stripForCache(u)
	second, err := stripForCache(first)
	if err != nil {
		t.Fatalf("second pass: %v", err)
	}
	md := second.(*unstructured.Unstructured).Object["metadata"].(map[string]any)
	if _, ok := md["managedFields"]; ok {
		t.Error("idempotent: managedFields still gone after second pass")
	}
}
