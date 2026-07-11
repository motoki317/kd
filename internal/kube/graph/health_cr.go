package graph

// The CR health/status dispatch plus the generic condition-based fallback and the condition-reading
// helpers every family shares. Family-specific rules live in the health_cr_<family>.go siblings.

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
	case gvk.Group == "apiextensions.k8s.io":
		return crdHealth(u)
	case gvk.Group == "flowcontrol.apiserver.k8s.io":
		return flowControlHealth(u, gvk.Kind)
	case gvk.Group == "wgpolicyk8s.io" || gvk.Group == "reports.kyverno.io":
		return policyReportHealth(u)
	case gvk.Group == "operator.victoriametrics.com":
		return victoriaMetricsHealth(u)
	case gvk.Group == "autoscaling":
		return hpaHealth(u)
	default:
		return crHealthFromConditions(u)
	}
}

// conditionStatuses maps each status.conditions[].type to its status string, for rules that key on a
// specific named condition rather than the Ready/Available convention.
func conditionStatuses(u *unstructured.Unstructured) map[string]string {
	out := map[string]string{}
	conds, _, _ := unstructured.NestedSlice(u.Object, "status", "conditions")
	for _, c := range conds {
		if m, ok := c.(map[string]any); ok {
			if typ, _ := m["type"].(string); typ != "" {
				st, _ := m["status"].(string)
				out[typ] = st
			}
		}
	}
	return out
}

// crHealthFromConditions is the catch-all for custom resources kd has no dedicated rule for. It
// inspects status.conditions[] for a Ready or Available condition: True → Healthy, False →
// Degraded, anything else → Unknown. A CR without conditions falls back to Healthy (existence ==
// health), matching ConfigMap/Service semantics. This covers most controller-written CRs
// (cert-manager, Crossplane, Flux, KEDA, ExternalSecret, …) that follow the conventional Ready
// condition, while being honest about a CR carrying only signals kd can't interpret.
func crHealthFromConditions(u *unstructured.Unstructured) Health {
	// No conditions at all → Healthy by existence (matching ConfigMap/Service). This is distinct from
	// "has conditions but none Ready/Available" (Unknown, below), so the empty check stays here — the
	// shared selector can't tell the two apart.
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found || len(conds) == 0 {
		return HealthHealthy
	}
	m, ok := readyOrAvailableCondition(u)
	if !ok {
		return HealthUnknown // conditions present but none kd interprets
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

// readyOrAvailableCondition returns the first status.conditions[] entry of type Ready or Available — the
// conventional controller health signal — or false when the CR has no such condition. The single source
// of which condition is authoritative, so crHealthFromConditions' verdict and crConditionMessage's "why"
// stay on the same condition instead of two hand-synced scans.
func readyOrAvailableCondition(u *unstructured.Unstructured) (map[string]any, bool) {
	conds, found, err := unstructured.NestedSlice(u.Object, "status", "conditions")
	if err != nil || !found {
		return nil, false
	}
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if typ, _ := m["type"].(string); typ == "Ready" || typ == "Available" {
			return m, true
		}
	}
	return nil, false
}

// crConditionMessage returns the message of the CR's Ready/Available condition when that condition isn't
// True — the "why" behind a degraded CR (a Certificate's "Issuing certificate…", an ExternalSecret's
// provider error), which most controllers put in conditions[].message rather than a top-level
// status.message (the only place statusMessage looked before). Reads the same condition
// readyOrAvailableCondition selects for the health verdict, so message and color match. Empty when
// absent or the condition is True.
func crConditionMessage(u *unstructured.Unstructured) string {
	m, ok := readyOrAvailableCondition(u)
	if !ok {
		return ""
	}
	if s, _ := m["status"].(string); s == "True" {
		return "" // healthy condition carries no "why"
	}
	msg, _ := m["message"].(string)
	return msg
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
			// Pair the health phase with the sync state when it isn't the all-clear "Synced" —
			// ArgoCD's own UI always shows the two side by side, and "Progressing · OutOfSync"
			// answers the first triage question ("is it mid-sync or drifted?") the bare health
			// phase can't. Mirrors the ECK "Ready · yellow" pairing idiom.
			s, _, _ := unstructured.NestedString(u.Object, "status", "health", "status")
			sync, _, _ := unstructured.NestedString(u.Object, "status", "sync", "status")
			if sync != "" && sync != "Synced" {
				if s == "" {
					return sync
				}
				return s + " · " + sync
			}
			return s
		case "CronWorkflow":
			if b, _, _ := unstructured.NestedBool(u.Object, "spec", "suspend"); b {
				return "Suspended"
			}
			// Mirror a CronJob, whose status column IS its schedule — the operator's first question
			// about a scheduled resource is "when does it run".
			return cronWorkflowSchedule(u)
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
	case gvk.Group == "wgpolicyk8s.io" || gvk.Group == "reports.kyverno.io":
		return policyReportStatus(u)
	case gvk.Group == "apiregistration.k8s.io" && gvk.Kind == "APIService":
		return apiServiceStatus(u)
	case gvk.Group == "karpenter.sh" && gvk.Kind == "NodeClaim":
		return nodeClaimStatus(u)
	case gvk.Group == "operator.victoriametrics.com":
		// Surface the operator's reconcile state only when it isn't the all-clear "operational" — an
		// expanding/failed/paused component explains its non-green dot; a healthy one stays silent.
		if s, _, _ := unstructured.NestedString(u.Object, "status", "updateStatus"); s != "" && s != "operational" {
			return s
		}
	}
	return ""
}

// crPhase reads the common status.phase string (empty when absent).
func crPhase(u *unstructured.Unstructured) string {
	s, _, _ := unstructured.NestedString(u.Object, "status", "phase")
	return s
}

// crConditionField returns one scalar field ("status"/"reason"/…) of the named top-level
// status.conditions[] entry, or "" when the condition or that field is absent. The shared scanner
// behind crConditionStatus/crConditionReason — condition types are unique per object, so first-match
// is the only match.
func crConditionField(u *unstructured.Unstructured, typ, field string) string {
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
			v, _ := m[field].(string)
			return v
		}
	}
	return ""
}

// crConditionStatus returns the status ("True"/"False"/"Unknown") of the named top-level
// status.conditions[] entry, or "" when the condition is absent.
func crConditionStatus(u *unstructured.Unstructured, typ string) string {
	return crConditionField(u, typ, "status")
}

// crConditionReason returns the short reason token (e.g. "FailedDiscoveryCheck") of the named
// status.conditions[] entry — the compact "why" behind a non-True condition, preferred over the long
// free-text message for a status chip. Empty when the condition or its reason is absent.
func crConditionReason(u *unstructured.Unstructured, typ string) string {
	return crConditionField(u, typ, "reason")
}
