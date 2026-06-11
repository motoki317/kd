package graph

// Health rules for the argoproj.io group — one group hosting several unrelated controllers
// (Workflows, Rollouts, ArgoCD), each with its own phase/health vocabulary, plus the drill-down
// that finds a failed Workflow's real error deep in status.nodes.

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// argoWorkflowMessage drills past an Argo Workflow's top-level status.message — which is only a
// PROPAGATION POINTER naming a child node ID ("child 'wf-3628068524' failed"), useless for triage —
// into status.nodes to surface the deepest FAILED leaf step's own error ("migrate-dry-run: main:
// Error (exit code 1)"). Pod-type leaves win (the actual container that errored) over parent steps;
// among equals the most recently finished failure, then a stable name order, so the result is
// deterministic across SSE patches. Returns "" for non-Workflows, when nodes are absent (offloaded/
// compressed status), or when no leaf carries a non-pointer message — leaving the caller's existing
// status.message fallback intact, so this never regresses a Workflow that fails at the top level.
func argoWorkflowMessage(u *unstructured.Unstructured) string {
	gvk := u.GroupVersionKind()
	if gvk.Group != "argoproj.io" || gvk.Kind != "Workflow" {
		return ""
	}
	nodes, found, err := unstructured.NestedMap(u.Object, "status", "nodes")
	if err != nil || !found {
		return ""
	}
	type cand struct {
		text     string
		isPod    bool
		isHook   bool
		finished string
	}
	var best *cand
	for _, raw := range nodes {
		n, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if p, _ := n["phase"].(string); p != "Failed" && p != "Error" {
			continue
		}
		msg, _ := n["message"].(string)
		msg = strings.TrimSpace(msg)
		// Skip the parent nodes that merely forward a descendant's failure — we want the leaf that
		// actually errored, not another "child '<id>' failed" pointer.
		if msg == "" || strings.HasPrefix(msg, "child '") {
			continue
		}
		text := msg
		if display, _ := n["displayName"].(string); display != "" {
			text = display + ": " + msg
		}
		// Exit-handler / lifecycle-hook leaves run AFTER (and because of) the primary failure; Argo
		// names them "<wf>.onExit…" / "<wf>.hooks.…". A failing notification handler (a Slack post that
		// can't create workflowtaskresults) must not eclipse the real job error it's reporting on.
		nodeName, _ := n["name"].(string)
		isHook := strings.Contains(nodeName, ".onExit") || strings.Contains(nodeName, ".hooks.")
		fin, _ := n["finishedAt"].(string)
		c := cand{text: text, isPod: n["type"] == "Pod", isHook: isHook, finished: fin}
		if best == nil || moreRelevantFailure(c.isHook, c.isPod, c.finished, c.text, best.isHook, best.isPod, best.finished, best.text) {
			cc := c
			best = &cc
		}
	}
	if best == nil {
		return ""
	}
	return best.text
}

// moreRelevantFailure orders two failed Workflow leaves: a primary-pipeline failure outranks an
// exit-handler/hook failure (which runs after, and reports on, the real error); then a Pod
// (container) execution outranks a parent step; then the most recently finished failure; then a
// stable name order for determinism.
func moreRelevantFailure(aHook, aPod bool, aFin, aText string, bHook, bPod bool, bFin, bText string) bool {
	if aHook != bHook {
		return !aHook
	}
	if aPod != bPod {
		return aPod
	}
	if aFin != bFin {
		return aFin > bFin
	}
	return aText < bText
}

// argoHealth covers the argoproj.io group, which hosts several unrelated controllers, so it
// dispatches by kind. Argo Workflows / Rollouts roll their status up into a single status.phase;
// an ArgoCD Application exposes status.health.status using kd's own vocabulary.
func argoHealth(u *unstructured.Unstructured, kind string) Health {
	switch kind {
	case "Workflow":
		// WorkflowPhase (argo-workflows pkg/apis/.../workflow_phase.go): Succeeded is the only
		// healthy terminal; Failed/Error are the failed terminals; Pending/Running are in flight;
		// "" means not yet scheduled — honest Unknown rather than a fake green.
		switch crPhase(u) {
		case "Succeeded":
			return HealthHealthy
		case "Failed", "Error":
			return HealthDegraded
		case "Running", "Pending":
			return HealthProgressing
		default:
			return HealthUnknown
		}
	case "Rollout":
		// RolloutPhase (argo-rollouts): Paused is a deliberate canary/blue-green gate, surfaced
		// like a paused Deployment (Suspended), not a fault.
		switch crPhase(u) {
		case "Healthy":
			return HealthHealthy
		case "Degraded":
			return HealthDegraded
		case "Paused":
			return HealthSuspended
		case "Progressing":
			return HealthProgressing
		default:
			return HealthUnknown
		}
	case "Application":
		// ArgoCD's Application.status.health.status (gitops-engine HealthStatusCode) is the same
		// enum kd uses, so it maps almost 1:1; Missing (the live resource is gone) is a fault.
		switch s, _, _ := unstructured.NestedString(u.Object, "status", "health", "status"); s {
		case "Healthy":
			return HealthHealthy
		case "Progressing":
			return HealthProgressing
		case "Suspended":
			return HealthSuspended
		case "Degraded", "Missing":
			return HealthDegraded
		default:
			return HealthUnknown
		}
	case "CronWorkflow":
		// A suspended schedule is intentionally paused; a SubmissionError condition means the
		// last scheduled run couldn't be created. Otherwise the schedule itself is fine.
		if b, _, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); b {
			return HealthSuspended
		}
		if crConditionStatus(u, "SubmissionError") == "True" {
			return HealthDegraded
		}
		return HealthHealthy
	case "ApplicationSet":
		// An ApplicationSet generates Applications from a template; its conditions are
		// ErrorOccurred/ParametersGenerated/ResourcesUpToDate (never Ready/Available). ErrorOccurred=True
		// means generation/templating failed — the child Applications are stale or missing — otherwise
		// the generator is doing its job.
		if crConditionStatus(u, "ErrorOccurred") == "True" {
			return HealthDegraded
		}
		return HealthHealthy
	default:
		// WorkflowTemplate, WorkflowEventBinding, WorkflowTaskSet, … are config/bookkeeping
		// objects with no runtime health — defer to the generic heuristic (Healthy by existence).
		return crHealthFromConditions(u)
	}
}
