package graph

// Health rule for the HorizontalPodAutoscaler (autoscaling group) — its conditions are
// AbleToScale/ScalingActive/ScalingLimited, never Ready/Available, so the generic heuristic
// can't read them.

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// hpaHealth reads a HorizontalPodAutoscaler's conditions (AbleToScale/ScalingActive/ScalingLimited,
// never Ready/Available, so the generic heuristic called it Unknown). ScalingActive=False is the real
// fault — the HPA can't compute a desired replica count (usually a missing/unreadable metric), so it
// has silently stopped autoscaling; AbleToScale=False means it can't actuate a scale. ScalingLimited is
// deliberately ignored: it's True whenever the HPA sits at its min/max bound, the normal steady state.
func hpaHealth(u *unstructured.Unstructured) Health {
	cs := conditionStatuses(u)
	if cs["ScalingActive"] == "False" || cs["AbleToScale"] == "False" {
		return HealthDegraded
	}
	return HealthHealthy
}

// hpaConditionMessage explains a degraded HPA the way hpaHealth judges it: the ScalingActive /
// AbleToScale = False condition's message ("failed to get cpu utilization: missing request for
// cpu…"), which lives in neither Ready nor Available — the only types the generic
// crConditionMessage reads — so a broken autoscaler was a red card with no words.
func hpaConditionMessage(u *unstructured.Unstructured) string {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found {
		return ""
	}
	for _, want := range []string{"ScalingActive", "AbleToScale"} {
		for _, c := range conds {
			m, ok := c.(map[string]any)
			if !ok {
				continue
			}
			if typ, _ := m["type"].(string); typ != want {
				continue
			}
			if s, _ := m["status"].(string); s == "False" {
				msg, _ := m["message"].(string)
				return msg
			}
		}
	}
	return ""
}
