package graph

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// cr builds an unstructured CR of the given apiVersion/kind with an optional status map.
func cr(apiVersion, kind string, status map[string]any) *unstructured.Unstructured {
	obj := map[string]any{
		"apiVersion": apiVersion,
		"kind":       kind,
		"metadata":   map[string]any{"name": "x"},
	}
	if status != nil {
		obj["status"] = status
	}
	return &unstructured.Unstructured{Object: obj}
}

func conds(cs ...map[string]any) []any {
	out := make([]any, len(cs))
	for i, c := range cs {
		out[i] = c
	}
	return out
}

func cond(typ, status string) map[string]any {
	return map[string]any{"type": typ, "status": status}
}

// TestCRStatusUnknownHint asserts that a CR with Unknown health (conditions present but
// uninterpretable) carries "unknown state" as its status text, so the topology card is not
// silently blank when the health dot shows grey — while a healthy-by-existence CR stays silent.
// Uses a generic group/kind so it exercises the catch-all heuristic, not a per-kind rule.
func TestCRStatusUnknownHint(t *testing.T) {
	uninterpretable := cr("example.com/v1", "Widget", map[string]any{
		"conditions": conds(cond("Reconciled", "True")),
	})
	if got := statusSummary(uninterpretable); got != "unknown state" {
		t.Errorf("statusSummary(Unknown CR) = %q, want \"unknown state\"", got)
	}
	healthyByExistence := cr("example.com/v1", "Widget", nil)
	if got := statusSummary(healthyByExistence); got != "" {
		t.Errorf("statusSummary(healthy-by-existence CR) = %q, want \"\"", got)
	}
}

// TestCRHealthFromConditions covers the catch-all heuristic kd uses for a CR with no per-kind
// rule. The contract: a Ready/Available condition drives the result; no conditions falls back to
// Healthy (existence == health); conditions present but neither Ready nor Available → Unknown so
// we don't gloss as Healthy. A generic group/kind is used so no dedicated rule intercepts it.
func TestCRHealthFromConditions(t *testing.T) {
	tests := []struct {
		name string
		in   *unstructured.Unstructured
		want Health
	}{
		{"ready true → Healthy", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Ready", "True"))}), HealthHealthy},
		{"available true → Healthy", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Available", "True"))}), HealthHealthy},
		{"ready false → Degraded", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Ready", "False"))}), HealthDegraded},
		{"available false → Degraded", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Available", "False"))}), HealthDegraded},
		{"ready unknown → Unknown", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Ready", "Unknown"))}), HealthUnknown},
		{"no conditions field → Healthy", cr("example.com/v1", "Widget", nil), HealthHealthy},
		{"empty conditions → Healthy", cr("example.com/v1", "Widget", map[string]any{"conditions": conds()}), HealthHealthy},
		{"only foreign conditions → Unknown", cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Reconciled", "True"))}), HealthUnknown},
		{"first matching wins (Ready true over Available false)",
			cr("example.com/v1", "Widget", map[string]any{"conditions": conds(cond("Ready", "True"), cond("Available", "False"))}), HealthHealthy},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.in); got != tc.want {
				t.Errorf("health(CR) = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCRConditionMessage proves a degraded CR's "why" — the message on its not-True Ready/Available
// condition (where cert-manager, external-secrets, etc. put it) — is surfaced as the Node message,
// falling back from the top-level status.message that most CRs don't set. A True condition carries no
// "why". Asserts through statusMessage (the integration), with h forced non-Healthy as Build computes.
func TestCRConditionMessage(t *testing.T) {
	condM := func(typ, status, msg string) map[string]any {
		return map[string]any{"type": typ, "status": status, "message": msg}
	}
	degraded := cr("cert-manager.io/v1", "Certificate", map[string]any{
		"conditions": conds(condM("Ready", "False", "Issuing certificate as Secret does not exist")),
	})
	if got := statusMessage(degraded, HealthDegraded); got != "Issuing certificate as Secret does not exist" {
		t.Errorf("statusMessage(degraded CR) = %q, want the condition message", got)
	}
	// A top-level status.message wins over the condition message when both are present.
	both := cr("example.com/v1", "Widget", map[string]any{
		"message":    "top-level reason",
		"conditions": conds(condM("Ready", "False", "condition reason")),
	})
	if got := statusMessage(both, HealthDegraded); got != "top-level reason" {
		t.Errorf("statusMessage = %q, want the top-level status.message to win", got)
	}
	// A True Ready condition has no "why"; a healthy CR yields no message regardless.
	ready := cr("example.com/v1", "Widget", map[string]any{"conditions": conds(condM("Ready", "True", "all good"))})
	if got := statusMessage(ready, HealthDegraded); got != "" {
		t.Errorf("statusMessage(True condition) = %q, want empty", got)
	}
	if got := statusMessage(degraded, HealthHealthy); got != "" {
		t.Errorf("statusMessage(healthy) = %q, want empty (the early-return guard)", got)
	}
}

// TestArgoWorkflowHealth pins the status.phase mapping for Argo Workflows. The cluster's real
// workflows showed phase Succeeded/Failed with a generic Completed condition — proof the catch-all
// (which reads Ready/Available) would mis-call them Unknown, hence the dedicated phase rule.
func TestArgoWorkflowHealth(t *testing.T) {
	wf := func(phase string) *unstructured.Unstructured {
		st := map[string]any{}
		if phase != "" {
			st["phase"] = phase
		}
		return cr("argoproj.io/v1alpha1", "Workflow", st)
	}
	tests := []struct {
		phase string
		want  Health
		text  string
	}{
		{"Succeeded", HealthHealthy, "Succeeded"},
		{"Failed", HealthDegraded, "Failed"},
		{"Error", HealthDegraded, "Error"},
		{"Running", HealthProgressing, "Running"},
		{"Pending", HealthProgressing, "Pending"},
		{"", HealthUnknown, "unknown state"},
	}
	for _, tc := range tests {
		t.Run(tc.phase, func(t *testing.T) {
			if got := health(wf(tc.phase)); got != tc.want {
				t.Errorf("health(Workflow phase=%q) = %q, want %q", tc.phase, got, tc.want)
			}
			if got := statusSummary(wf(tc.phase)); got != tc.text {
				t.Errorf("statusSummary(Workflow phase=%q) = %q, want %q", tc.phase, got, tc.text)
			}
		})
	}
}

// TestArgoCronWorkflowHealth: a suspended schedule is Suspended, a SubmissionError is Degraded,
// otherwise the schedule is Healthy.
func TestArgoCronWorkflowHealth(t *testing.T) {
	suspended := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow",
		"metadata": map[string]any{"name": "c"},
		"spec":     map[string]any{"suspend": true},
	}}
	if got := health(suspended); got != HealthSuspended {
		t.Errorf("suspended CronWorkflow = %q, want Suspended", got)
	}
	if got := statusSummary(suspended); got != "Suspended" {
		t.Errorf("suspended CronWorkflow status = %q, want Suspended", got)
	}
	submErr := cr("argoproj.io/v1alpha1", "CronWorkflow", map[string]any{"conditions": conds(cond("SubmissionError", "True"))})
	if got := health(submErr); got != HealthDegraded {
		t.Errorf("CronWorkflow w/ SubmissionError = %q, want Degraded", got)
	}
	healthy := cr("argoproj.io/v1alpha1", "CronWorkflow", nil)
	if got := health(healthy); got != HealthHealthy {
		t.Errorf("plain CronWorkflow = %q, want Healthy", got)
	}
}

// TestArgoRolloutHealth: phase Paused is Suspended (a deliberate gate), not a fault.
func TestArgoRolloutHealth(t *testing.T) {
	tests := map[string]Health{
		"Healthy": HealthHealthy, "Degraded": HealthDegraded,
		"Progressing": HealthProgressing, "Paused": HealthSuspended,
	}
	for phase, want := range tests {
		r := cr("argoproj.io/v1alpha1", "Rollout", map[string]any{"phase": phase})
		if got := health(r); got != want {
			t.Errorf("health(Rollout phase=%q) = %q, want %q", phase, got, want)
		}
	}
}

// TestArgoCDApplicationHealth: status.health.status uses kd's own vocabulary; Missing is a fault.
func TestArgoCDApplicationHealth(t *testing.T) {
	app := func(h string) *unstructured.Unstructured {
		return cr("argoproj.io/v1alpha1", "Application", map[string]any{
			"health": map[string]any{"status": h},
		})
	}
	tests := map[string]Health{
		"Healthy": HealthHealthy, "Progressing": HealthProgressing,
		"Suspended": HealthSuspended, "Degraded": HealthDegraded, "Missing": HealthDegraded,
	}
	for h, want := range tests {
		if got := health(app(h)); got != want {
			t.Errorf("health(Application health=%q) = %q, want %q", h, got, want)
		}
	}
	if got := statusSummary(app("Degraded")); got != "Degraded" {
		t.Errorf("Application status = %q, want Degraded", got)
	}
}

// TestECKHealth pins the Elastic Cloud on Kubernetes mapping. The cluster's real Elasticsearch
// reported phase Ready + health yellow (single-node, replicas unassigned) — a functional but
// not-redundant state kd shows as Progressing, with "Ready · yellow" status text. green is the
// all-clear, red a fault, and an in-flight orchestration (ApplyingChanges) is Progressing.
func TestECKHealth(t *testing.T) {
	es := func(phase, hlth string) *unstructured.Unstructured {
		st := map[string]any{}
		if phase != "" {
			st["phase"] = phase
		}
		if hlth != "" {
			st["health"] = hlth
		}
		return cr("elasticsearch.k8s.elastic.co/v1", "Elasticsearch", st)
	}
	tests := []struct {
		name        string
		phase, hlth string
		want        Health
		text        string
	}{
		{"ready green", "Ready", "green", HealthHealthy, "Ready"},
		{"ready yellow", "Ready", "yellow", HealthProgressing, "Ready · yellow"},
		{"ready red", "Ready", "red", HealthDegraded, "Ready · red"},
		{"applying changes", "ApplyingChanges", "green", HealthProgressing, "ApplyingChanges"},
		{"migrating data", "MigratingData", "yellow", HealthProgressing, "MigratingData · yellow"},
		{"invalid", "Invalid", "red", HealthDegraded, "Invalid · red"},
		{"stalled", "Stalled", "yellow", HealthDegraded, "Stalled · yellow"},
		{"unknown health", "", "unknown", HealthUnknown, "unknown"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(es(tc.phase, tc.hlth)); got != tc.want {
				t.Errorf("health = %q, want %q", got, tc.want)
			}
			if got := statusSummary(es(tc.phase, tc.hlth)); got != tc.text {
				t.Errorf("status = %q, want %q", got, tc.text)
			}
		})
	}
	// A stateless ECK kind (Kibana) reports only green/red, no phase.
	kib := cr("kibana.k8s.elastic.co/v1", "Kibana", map[string]any{"health": "green"})
	if got := health(kib); got != HealthHealthy {
		t.Errorf("health(Kibana green) = %q, want Healthy", got)
	}
	if got := statusSummary(kib); got != "green" {
		t.Errorf("status(Kibana green) = %q, want green", got)
	}
	// An ECK kind with neither health nor phase (e.g. autoscaler) defers to the generic heuristic.
	autoscaler := cr("autoscaling.k8s.elastic.co/v1alpha1", "ElasticsearchAutoscaler", nil)
	if got := health(autoscaler); got != HealthHealthy {
		t.Errorf("health(autoscaler, no status) = %q, want Healthy", got)
	}
}

// TestGatewayHealth: a Gateway is Healthy once Programmed=True, Degraded if Accepted/Programmed
// is False, Progressing while accepted-but-not-yet-programmed.
func TestGatewayHealth(t *testing.T) {
	gw := func(cs ...map[string]any) *unstructured.Unstructured {
		return cr("gateway.networking.k8s.io/v1", "Gateway", map[string]any{"conditions": conds(cs...)})
	}
	tests := []struct {
		name string
		in   *unstructured.Unstructured
		want Health
		text string
	}{
		{"programmed", gw(cond("Accepted", "True"), cond("Programmed", "True")), HealthHealthy, "Programmed"},
		{"rejected", gw(cond("Accepted", "False")), HealthDegraded, "Rejected"},
		{"not programmed", gw(cond("Accepted", "True"), cond("Programmed", "False")), HealthDegraded, "Not Programmed"},
		{"accepted, programming", gw(cond("Accepted", "True")), HealthProgressing, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := health(tc.in); got != tc.want {
				t.Errorf("health = %q, want %q", got, tc.want)
			}
			if got := statusSummary(tc.in); got != tc.text {
				t.Errorf("status = %q, want %q", got, tc.text)
			}
		})
	}
}

// TestGatewayClassHealth: Accepted=True is Healthy, False Degraded, missing Unknown.
func TestGatewayClassHealth(t *testing.T) {
	gc := func(status string) *unstructured.Unstructured {
		st := map[string]any{}
		if status != "" {
			st["conditions"] = conds(cond("Accepted", status))
		}
		return cr("gateway.networking.k8s.io/v1", "GatewayClass", st)
	}
	if got := health(gc("True")); got != HealthHealthy {
		t.Errorf("GatewayClass Accepted=True = %q, want Healthy", got)
	}
	if got := statusSummary(gc("True")); got != "Accepted" {
		t.Errorf("GatewayClass Accepted=True status = %q, want Accepted", got)
	}
	if got := health(gc("False")); got != HealthDegraded {
		t.Errorf("GatewayClass Accepted=False = %q, want Degraded", got)
	}
	if got := statusSummary(gc("False")); got != "Rejected" {
		t.Errorf("GatewayClass Accepted=False status = %q, want Rejected", got)
	}
	if got := health(gc("")); got != HealthUnknown {
		t.Errorf("GatewayClass no condition = %q, want Unknown", got)
	}
}

// TestGatewayRouteHealth folds per-parent conditions: every parent must Accept and ResolveRefs.
func TestGatewayRouteHealth(t *testing.T) {
	route := func(parents ...any) *unstructured.Unstructured {
		st := map[string]any{}
		if parents != nil {
			st["parents"] = parents
		}
		return cr("gateway.networking.k8s.io/v1", "HTTPRoute", st)
	}
	parent := func(cs ...map[string]any) map[string]any {
		return map[string]any{"conditions": conds(cs...)}
	}

	accepted := route(parent(cond("Accepted", "True"), cond("ResolvedRefs", "True")))
	if got := health(accepted); got != HealthHealthy {
		t.Errorf("accepted route = %q, want Healthy", got)
	}
	if got := statusSummary(accepted); got != "Accepted" {
		t.Errorf("accepted route status = %q, want Accepted", got)
	}
	badRef := route(parent(cond("Accepted", "True"), cond("ResolvedRefs", "False")))
	if got := health(badRef); got != HealthDegraded {
		t.Errorf("route w/ unresolved ref = %q, want Degraded", got)
	}
	if got := statusSummary(badRef); got != "Ref error" {
		t.Errorf("bad-ref route status = %q, want \"Ref error\"", got)
	}
	notAccepted := route(parent(cond("Accepted", "False")))
	if got := health(notAccepted); got != HealthDegraded {
		t.Errorf("not-accepted route = %q, want Degraded", got)
	}
	partial := route(parent(cond("Accepted", "True"), cond("ResolvedRefs", "True"), cond("PartiallyInvalid", "True")))
	if got := health(partial); got != HealthDegraded {
		t.Errorf("partially-invalid route = %q, want Degraded", got)
	}
	// One good parent + one bad parent → Degraded (any parent failing degrades the whole route).
	mixed := route(
		parent(cond("Accepted", "True"), cond("ResolvedRefs", "True")),
		parent(cond("Accepted", "False")),
	)
	if got := health(mixed); got != HealthDegraded {
		t.Errorf("mixed-parent route = %q, want Degraded", got)
	}
	// No parents yet → still attaching.
	attaching := route()
	if got := health(attaching); got != HealthProgressing {
		t.Errorf("no-parent route = %q, want Progressing", got)
	}
	if got := statusSummary(attaching); got != "Attaching" {
		t.Errorf("attaching route status = %q, want Attaching", got)
	}
}

// TestTraefikNoStatusHealthy: Traefik config CRs (IngressRoute, Middleware) carry no status — they
// are config objects, Healthy by existence like a ConfigMap, and must not be dragged to Unknown.
func TestTraefikNoStatusHealthy(t *testing.T) {
	for _, kind := range []string{"IngressRoute", "Middleware", "TraefikService"} {
		ir := cr("traefik.io/v1alpha1", kind, nil)
		if got := health(ir); got != HealthHealthy {
			t.Errorf("health(%s, no status) = %q, want Healthy", kind, got)
		}
		if got := statusSummary(ir); got != "" {
			t.Errorf("statusSummary(%s) = %q, want \"\"", kind, got)
		}
	}
}
