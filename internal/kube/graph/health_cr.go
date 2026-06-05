package graph

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// crHealth maps a custom resource to the shared Health enum. Many controllers don't write a
// generic Ready/Available condition — they expose a kind-specific status.phase or status.health
// field — so kd dispatches by API group (and kind, where one group hosts several controllers) to
// a dedicated rule, falling back to the generic condition heuristic for everything else. Each
// rule's enum values are taken from the upstream type's source; see the per-function comments.
//
// Adding a family: add a group case here + a fooHealth rule + (optionally) a status string in
// crStatusSummary, and cover it in health_cr_test.go with a real status fixture.
func crHealth(u *unstructured.Unstructured) Health {
	gvk := u.GroupVersionKind()
	switch {
	case gvk.Group == "argoproj.io":
		return argoHealth(u, gvk.Kind)
	case strings.HasSuffix(gvk.Group, "k8s.elastic.co"):
		return eckHealth(u)
	case gvk.Group == "gateway.networking.k8s.io":
		return gatewayAPIHealth(u, gvk.Kind)
	default:
		return crHealthFromConditions(u)
	}
}

// crHealthFromConditions is the catch-all for custom resources kd has no dedicated rule for. It
// inspects status.conditions[] for a Ready or Available condition: True → Healthy, False →
// Degraded, anything else → Unknown. A CR without conditions falls back to Healthy (existence ==
// health), matching ConfigMap/Service semantics. This covers most controller-written CRs
// (cert-manager, Crossplane, Flux, KEDA, ExternalSecret, …) that follow the conventional Ready
// condition, while being honest about a CR carrying only signals kd can't interpret.
func crHealthFromConditions(u *unstructured.Unstructured) Health {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found || len(conds) == 0 {
		return HealthHealthy
	}
	// First Ready/Available decides; if neither is present, the CR has conditions but none kd
	// interprets, so report Unknown rather than glossing as Healthy.
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := m["type"].(string)
		if typ != "Ready" && typ != "Available" {
			continue
		}
		switch s, _ := m["status"].(string); s {
		case "True":
			return HealthHealthy
		case "False":
			return HealthDegraded
		default:
			return HealthUnknown
		}
	}
	return HealthUnknown
}

// crConditionMessage returns the message of the CR's Ready/Available condition when that condition isn't
// True — the "why" behind a degraded CR (a Certificate's "Issuing certificate…", an ExternalSecret's
// provider error), which most controllers put in conditions[].message rather than a top-level
// status.message (the only place statusMessage looked before). Mirrors crHealthFromConditions' condition
// selection so the surfaced message matches the health verdict. Empty when absent or the condition is True.
func crConditionMessage(u *unstructured.Unstructured) string {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found {
		return ""
	}
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if typ, _ := m["type"].(string); typ != "Ready" && typ != "Available" {
			continue
		}
		if s, _ := m["status"].(string); s == "True" {
			return "" // healthy condition carries no "why"
		}
		msg, _ := m["message"].(string)
		return msg
	}
	return ""
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
	default:
		// WorkflowTemplate, WorkflowEventBinding, WorkflowTaskSet, … are config/bookkeeping
		// objects with no runtime health — defer to the generic heuristic (Healthy by existence).
		return crHealthFromConditions(u)
	}
}

// eckHealth maps Elastic Cloud on Kubernetes resources (every *.k8s.elastic.co kind). Elasticsearch
// alone carries a status.phase orchestration signal; most ECK kinds carry status.health with the
// cluster-color vocabulary green/yellow/red(/unknown). yellow = up but not fully redundant (some
// shards/replicas unassigned) — treated like a partially-ready Deployment (Progressing), not a
// hard fault. A reconcile in flight (ApplyingChanges/MigratingData) is Progressing; an Invalid or
// Stalled orchestration is a real fault. Kinds with neither field (autoscaler, stackconfigpolicy)
// defer to the generic heuristic.
func eckHealth(u *unstructured.Unstructured) Health {
	switch crPhase(u) {
	case "Invalid", "Stalled":
		return HealthDegraded
	case "ApplyingChanges", "MigratingData":
		return HealthProgressing
	}
	switch h, _, _ := unstructured.NestedString(u.Object, "status", "health"); h {
	case "green":
		return HealthHealthy
	case "yellow":
		return HealthProgressing
	case "red":
		return HealthDegraded
	case "unknown":
		return HealthUnknown
	default:
		return crHealthFromConditions(u)
	}
}

// gatewayAPIHealth maps Gateway API resources. They use standard metav1 conditions but with
// kind-specific types (Accepted/Programmed/ResolvedRefs, never Ready/Available), so the generic
// heuristic would call them all Unknown. A Gateway is ready once Programmed=True (data plane
// provisioned, address assigned); a *Route once every parent accepts it and its refs resolve.
func gatewayAPIHealth(u *unstructured.Unstructured, kind string) Health {
	switch kind {
	case "Gateway":
		if crConditionStatus(u, "Accepted") == "False" || crConditionStatus(u, "Programmed") == "False" {
			return HealthDegraded
		}
		if crConditionStatus(u, "Programmed") == "True" {
			return HealthHealthy
		}
		return HealthProgressing // accepted but not yet programmed, or status not written yet
	case "GatewayClass":
		switch crConditionStatus(u, "Accepted") {
		case "True":
			return HealthHealthy
		case "False":
			return HealthDegraded
		default:
			return HealthUnknown
		}
	case "HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute":
		return gatewayRouteHealth(u)
	default:
		return crHealthFromConditions(u)
	}
}

// gatewayRouteHealth folds a *Route's per-parent status (status.parents[].conditions[]): healthy
// only when every parent both Accepts the route and resolves its backend refs. Any Accepted=False
// / ResolvedRefs=False, or a PartiallyInvalid=True (some rules dropped as invalid), degrades it.
// No parents written yet → still attaching (Progressing).
func gatewayRouteHealth(u *unstructured.Unstructured) Health {
	parents, found, _ := unstructured.NestedSlice(u.Object, "status", "parents")
	if !found || len(parents) == 0 {
		return HealthProgressing
	}
	for _, p := range parents {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		conds, _, _ := unstructured.NestedSlice(m, "conditions")
		for _, c := range conds {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			typ, _ := cm["type"].(string)
			status, _ := cm["status"].(string)
			switch typ {
			case "Accepted", "ResolvedRefs":
				if status == "False" {
					return HealthDegraded
				}
			case "PartiallyInvalid":
				if status == "True" {
					return HealthDegraded
				}
			}
		}
	}
	return HealthHealthy
}

// crStatusSummary is the human status string for a custom resource — the CR equivalent of
// kubectl's STATUS column. It surfaces the same kind-specific field crHealth keys off of (a
// Workflow's phase, an Elasticsearch's color) so a non-green card explains itself instead of
// reading blank. Falls back to "unknown state" only when health is Unknown, else stays silent
// (a healthy-by-existence CR shouldn't add noise).
func crStatusSummary(u *unstructured.Unstructured) string {
	if s := crKindStatus(u); s != "" {
		return s
	}
	if crHealth(u) == HealthUnknown {
		return "unknown state"
	}
	return ""
}

func crKindStatus(u *unstructured.Unstructured) string {
	gvk := u.GroupVersionKind()
	switch {
	case gvk.Group == "argoproj.io":
		switch gvk.Kind {
		case "Workflow", "Rollout":
			return crPhase(u)
		case "Application":
			s, _, _ := unstructured.NestedString(u.Object, "status", "health", "status")
			return s
		case "CronWorkflow":
			if b, _, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); b {
				return "Suspended"
			}
		}
	case strings.HasSuffix(gvk.Group, "k8s.elastic.co"):
		// Pair the orchestration phase with the cluster color when the color isn't the all-clear
		// green, so "Ready · yellow" explains a non-green dot on an otherwise-Ready Elasticsearch.
		phase := crPhase(u)
		health, _, _ := unstructured.NestedString(u.Object, "status", "health")
		switch {
		case phase != "" && health != "" && health != "green":
			return phase + " · " + health
		case phase != "":
			return phase
		default:
			return health
		}
	case gvk.Group == "gateway.networking.k8s.io":
		return gatewayStatusSummary(u, gvk.Kind)
	}
	return ""
}

// gatewayStatusSummary names a Gateway API resource's attach state in one word, mirroring the
// condition crHealth read.
func gatewayStatusSummary(u *unstructured.Unstructured, kind string) string {
	switch kind {
	case "Gateway":
		switch {
		case crConditionStatus(u, "Programmed") == "True":
			return "Programmed"
		case crConditionStatus(u, "Accepted") == "False":
			return "Rejected"
		case crConditionStatus(u, "Programmed") == "False":
			return "Not Programmed"
		}
	case "GatewayClass":
		switch crConditionStatus(u, "Accepted") {
		case "True":
			return "Accepted"
		case "False":
			return "Rejected"
		}
	case "HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute":
		switch gatewayRouteHealth(u) {
		case HealthHealthy:
			return "Accepted"
		case HealthDegraded:
			return "Ref error"
		case HealthProgressing:
			return "Attaching"
		}
	}
	return ""
}

// crPhase reads the common status.phase string (empty when absent).
func crPhase(u *unstructured.Unstructured) string {
	s, _, _ := unstructured.NestedString(u.Object, "status", "phase")
	return s
}

// crConditionStatus returns the status ("True"/"False"/"Unknown") of the named top-level
// status.conditions[] entry, or "" when the condition is absent.
func crConditionStatus(u *unstructured.Unstructured, typ string) string {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found {
		return ""
	}
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if t, _ := m["type"].(string); t == typ {
			s, _ := m["status"].(string)
			return s
		}
	}
	return ""
}
