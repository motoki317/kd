package graph

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// TestCRStatusUnknownHint asserts that a CR with Unknown health (conditions present but
// uninterpretable) carries "unknown state" as its status text, so the topology card is
// not silently blank when the health dot shows grey.
func TestCRStatusUnknownHint(t *testing.T) {
	cr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Workflow",
		"metadata":   map[string]any{"name": "wf-1"},
		"status": map[string]any{
			"conditions": []any{map[string]any{"type": "Reconciled", "status": "True"}},
		},
	}}
	if got := statusSummary(cr); got != "unknown state" {
		t.Errorf("statusSummary(Unknown CR) = %q, want \"unknown state\"", got)
	}
	// A healthy-by-existence CR (no conditions) must stay silent — no false alarm.
	crNoStatus := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Workflow",
		"metadata":   map[string]any{"name": "wf-2"},
	}}
	if got := statusSummary(crNoStatus); got != "" {
		t.Errorf("statusSummary(healthy-by-existence CR) = %q, want \"\"", got)
	}
}

// TestCRHealthFromConditions covers the heuristic kd uses to give a custom resource a
// Health value when there's no per-kind rule. The contract: Ready/Available conditions
// drive the result; no conditions falls back to Healthy (existence == health); conditions
// present but neither Ready nor Available → Unknown so we don't gloss as Healthy.
func TestCRHealthFromConditions(t *testing.T) {
	cr := func(conds []any) *unstructured.Unstructured {
		obj := map[string]any{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Workflow",
			"metadata":   map[string]any{"name": "wf-1"},
		}
		if conds != nil {
			obj["status"] = map[string]any{"conditions": conds}
		}
		return &unstructured.Unstructured{Object: obj}
	}
	cond := func(typ, status string) any {
		return map[string]any{"type": typ, "status": status}
	}

	tests := []struct {
		name  string
		input *unstructured.Unstructured
		want  Health
	}{
		{"ready true → Healthy", cr([]any{cond("Ready", "True")}), HealthHealthy},
		{"available true → Healthy", cr([]any{cond("Available", "True")}), HealthHealthy},
		{"ready false → Degraded", cr([]any{cond("Ready", "False")}), HealthDegraded},
		{"available false → Degraded", cr([]any{cond("Available", "False")}), HealthDegraded},
		{"ready unknown → Unknown", cr([]any{cond("Ready", "Unknown")}), HealthUnknown},
		{"no conditions field → Healthy (existence == health)", cr(nil), HealthHealthy},
		{"empty conditions → Healthy", cr([]any{}), HealthHealthy},
		{"only foreign conditions → Unknown", cr([]any{cond("Reconciled", "True")}), HealthUnknown},
		{"first matching condition wins (Ready true wins over Available false)",
			cr([]any{cond("Ready", "True"), cond("Available", "False")}), HealthHealthy},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := health(tc.input)
			if got != tc.want {
				t.Errorf("health(CR) = %q, want %q", got, tc.want)
			}
		})
	}
}
