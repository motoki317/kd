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

// TestArgoWorkflowMessage proves a failed Argo Workflow's drawer shows the LEAF step's real error,
// not the top-level "child '<id>' failed" propagation pointer. Models the real staging shape: a DAG
// node + a step node both forward the failure, while the Pod leaf "migrate-dry-run" carries the
// actual "main: Error (exit code 1)". The Pod leaf must win; a Workflow that fails with no leaf
// message must keep the top-level pointer; non-Workflow CRs must be untouched.
func TestArgoWorkflowMessage(t *testing.T) {
	node := func(typ, phase, name, msg, fin string) map[string]any {
		return map[string]any{"type": typ, "phase": phase, "displayName": name, "message": msg, "finishedAt": fin}
	}
	const ver = "argoproj.io/v1alpha1"
	withLeaf := cr(ver, "Workflow", map[string]any{
		"phase":   "Failed",
		"message": "child 'wf-3628068524' failed",
		"nodes": map[string]any{
			"wf-root":       node("DAG", "Failed", "wf", "child 'wf-3628068524' failed", "2026-06-06T01:00:05Z"),
			"wf-1111111111": node("StepGroup", "Failed", "[0]", "child 'wf-3628068524' failed", "2026-06-06T01:00:04Z"),
			"wf-3628068524": node("Pod", "Failed", "migrate-dry-run", "main: Error (exit code 1)", "2026-06-06T01:00:03Z"),
			"wf-notify":     node("Pod", "Succeeded", "notify", "", "2026-06-06T01:00:06Z"),
		},
	})
	if got := statusMessage(withLeaf, HealthDegraded); got != "migrate-dry-run: main: Error (exit code 1)" {
		t.Errorf("statusMessage = %q, want the failed Pod leaf's error, not the child pointer", got)
	}
	// A Pod leaf outranks a parent step that happens to carry its own non-pointer message.
	podOverStep := cr(ver, "Workflow", map[string]any{
		"phase":   "Failed",
		"message": "child 'wf-pod' failed",
		"nodes": map[string]any{
			"wf-retry": node("Retry", "Failed", "build", "No more retries left", "2026-06-06T01:00:09Z"),
			"wf-pod":   node("Pod", "Failed", "compile", "exec format error", "2026-06-06T01:00:08Z"),
		},
	})
	if got := statusMessage(podOverStep, HealthDegraded); got != "compile: exec format error" {
		t.Errorf("statusMessage = %q, want the Pod leaf over the parent step", got)
	}
	// No leaf message (status offloaded/compressed) → keep the top-level pointer rather than blanking.
	noLeaf := cr(ver, "Workflow", map[string]any{
		"phase":   "Failed",
		"message": "Workflow operation error: timed out",
		"nodes":   map[string]any{"wf-root": node("DAG", "Failed", "wf", "child 'x' failed", "")},
	})
	if got := statusMessage(noLeaf, HealthDegraded); got != "Workflow operation error: timed out" {
		t.Errorf("statusMessage = %q, want the top-level message when no leaf error exists", got)
	}
	// Non-Workflow CRs are untouched by the Argo drill-down.
	other := cr("example.com/v1", "Widget", map[string]any{"message": "top-level reason"})
	if got := statusMessage(other, HealthDegraded); got != "top-level reason" {
		t.Errorf("statusMessage(non-Workflow) = %q, want the top-level message unchanged", got)
	}
}

// TestCRDHealth proves a CustomResourceDefinition is classified by its Established/NamesAccepted
// conditions (not left "Unknown" by the Ready/Available catch-all): an established CRD with accepted
// names is Healthy; a name conflict or a not-established CRD is Degraded. This is what cleared 49
// stock-cluster CRDs out of the cluster-scope "Unknown" tally.
func TestCRDHealth(t *testing.T) {
	const g = "apiextensions.k8s.io/v1"
	established := cr(g, "CustomResourceDefinition", map[string]any{"conditions": conds(cond("Established", "True"), cond("NamesAccepted", "True"))})
	if got := health(established); got != HealthHealthy {
		t.Errorf("established CRD health = %q, want Healthy", got)
	}
	nameConflict := cr(g, "CustomResourceDefinition", map[string]any{"conditions": conds(cond("Established", "True"), cond("NamesAccepted", "False"))})
	if got := health(nameConflict); got != HealthDegraded {
		t.Errorf("name-conflict CRD health = %q, want Degraded", got)
	}
	notEstablished := cr(g, "CustomResourceDefinition", map[string]any{"conditions": conds(cond("Established", "False"), cond("NamesAccepted", "True"))})
	if got := health(notEstablished); got != HealthDegraded {
		t.Errorf("not-established CRD health = %q, want Degraded", got)
	}
	fresh := cr(g, "CustomResourceDefinition", nil) // just created, no conditions yet
	if got := health(fresh); got != HealthHealthy {
		t.Errorf("condition-less CRD health = %q, want Healthy (existence)", got)
	}
}

// TestFlowControlHealth proves a FlowSchema's Dangling condition (its only one — not Ready/Available)
// drives health: Dangling=True (references a missing PriorityLevelConfiguration) is Degraded, else
// Healthy; a PriorityLevelConfiguration is healthy by existence. Clears 11 FlowSchemas out of "Unknown".
func TestFlowControlHealth(t *testing.T) {
	const g = "flowcontrol.apiserver.k8s.io/v1"
	ok := cr(g, "FlowSchema", map[string]any{"conditions": conds(cond("Dangling", "False"))})
	if got := health(ok); got != HealthHealthy {
		t.Errorf("non-dangling FlowSchema health = %q, want Healthy", got)
	}
	dangling := cr(g, "FlowSchema", map[string]any{"conditions": conds(cond("Dangling", "True"))})
	if got := health(dangling); got != HealthDegraded {
		t.Errorf("dangling FlowSchema health = %q, want Degraded", got)
	}
	plc := cr(g, "PriorityLevelConfiguration", nil)
	if got := health(plc); got != HealthHealthy {
		t.Errorf("PriorityLevelConfiguration health = %q, want Healthy", got)
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

// TestCronWorkflowScheduleAndLastRun proves a non-suspended Argo CronWorkflow surfaces its schedule
// as the status text (mirroring a CronJob, whose status column is its schedule) and its
// lastScheduledTime through the reused LastRun field, so the drawer answers "when does it run / when
// did it last fire". Covers the Argo v3 spec.schedules list, the older singular spec.schedule, and
// the timezone suffix.
func TestCronWorkflowScheduleAndLastRun(t *testing.T) {
	cw := func(spec, status map[string]any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow",
			"metadata": map[string]any{"name": "c"},
			"spec":     spec, "status": status,
		}}
	}
	// Argo v3: spec.schedules (a list) + timezone, with a last fire time.
	v3 := cw(
		map[string]any{"schedules": []any{"0 5 * * *"}, "timezone": "Asia/Tokyo"},
		map[string]any{"lastScheduledTime": "2026-06-06T00:00:00Z"},
	)
	if got, want := statusSummary(v3), "0 5 * * * (Asia/Tokyo)"; got != want {
		t.Errorf("CronWorkflow status = %q, want the schedule %q", got, want)
	}
	if got, want := cronLastRun(v3), "2026-06-06T00:00:00Z"; got != want {
		t.Errorf("cronLastRun(CronWorkflow) = %q, want %q", got, want)
	}
	// Older singular spec.schedule, no timezone.
	v2 := cw(map[string]any{"schedule": "*/15 * * * *"}, nil)
	if got, want := statusSummary(v2), "*/15 * * * *"; got != want {
		t.Errorf("CronWorkflow (singular schedule) status = %q, want %q", got, want)
	}
	// Suspended still wins over the schedule.
	susp := cw(map[string]any{"schedules": []any{"0 5 * * *"}, "suspend": true}, nil)
	if got := statusSummary(susp); got != "Suspended" {
		t.Errorf("suspended CronWorkflow status = %q, want Suspended", got)
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
