package graph

import (
	"fmt"
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
	default:
		return crHealthFromConditions(u)
	}
}

// victoriaMetricsHealth maps the VictoriaMetrics operator's CRs (every operator.victoriametrics.com
// kind — VMAgent/VMAlert/VMSingle runtime components AND VMRule/VMServiceScrape/VMNodeScrape config
// objects). They carry status.updateStatus (the operator's reconcile state: operational/expanding/
// failed/paused) rather than a Ready/Available condition, and the config CRs instead carry a
// "<qualified>/Applied" condition — so the generic heuristic called every one "Unknown", painting a
// whole monitoring namespace gray (35 VMRules + a dozen scrapes on a stock victoria-metrics-k8s-stack).
func victoriaMetricsHealth(u *unstructured.Unstructured) Health {
	switch s, _, _ := unstructured.NestedString(u.Object, "status", "updateStatus"); s {
	case "operational":
		return HealthHealthy
	case "failed":
		return HealthDegraded
	case "expanding":
		return HealthProgressing
	case "paused":
		return HealthSuspended
	}
	// No updateStatus yet (e.g. VMCluster, or a freshly-applied CR): fall back to the operator's
	// "<qualified>/Applied" reconcile condition, else Healthy by existence (a config object).
	for typ, st := range conditionStatuses(u) {
		if strings.HasSuffix(typ, "/Applied") {
			if st == "False" {
				return HealthDegraded
			}
			return HealthHealthy
		}
	}
	return HealthHealthy
}

// policyReportHealth reads a policy report's result summary (the wgpolicyk8s.io PolicyReport/
// ClusterPolicyReport schema, which Kyverno's reports.kyverno.io EphemeralReport shares): a failed or
// errored rule means the reported resource is VIOLATING policy → Degraded; pass/warn/skip is fine →
// Healthy. Without this every report read Healthy-by-existence, so a real policy failure was invisible
// in the health tally and the Degraded filter — a compliance signal silently lost.
func policyReportHealth(u *unstructured.Unstructured) Health {
	if summaryCount(u, "fail") > 0 || summaryCount(u, "error") > 0 {
		return HealthDegraded
	}
	return HealthHealthy
}

// policyReportStatus renders a report's result tally as "Np pass, Nf fail, …" (non-zero parts only, in
// severity order), turning an opaque UUID-named report into "what did the policy checks say".
func policyReportStatus(u *unstructured.Unstructured) string {
	var parts []string
	for _, k := range []string{"fail", "error", "warn", "pass", "skip"} {
		if c := summaryCount(u, k); c > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", c, k))
		}
	}
	return strings.Join(parts, ", ")
}

// summaryCount reads a policy report's result-summary count. The two report families nest it
// differently: Kyverno's reports.kyverno.io puts the summary under spec, while the wgpolicyk8s.io
// PolicyReport schema puts it at the top level — try both. (The dynamic informer may also decode a JSON
// number as int64 or float64, so accept both.) Getting the path wrong silently blanked every status
// against real cluster data — the live-vs-unit-test gap dogfooding caught.
func summaryCount(u *unstructured.Unstructured, key string) int64 {
	for _, base := range [][]string{{"spec", "summary", key}, {"summary", key}} {
		if v, ok, _ := unstructured.NestedInt64(u.Object, base...); ok {
			return v
		}
		if v, ok, _ := unstructured.NestedFloat64(u.Object, base...); ok {
			return int64(v)
		}
	}
	return 0
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

// crdHealth reads a CustomResourceDefinition's conditions. An established CRD with accepted names is
// serving (Healthy); a name conflict (NamesAccepted=False) or a not-established CRD isn't serving
// (Degraded). The catch-all called every CRD "Unknown" — its conditions are Established/NamesAccepted,
// not Ready/Available — which made cluster-scope health read alarmingly (49 CRDs on a stock cluster).
func crdHealth(u *unstructured.Unstructured) Health {
	conds := conditionStatuses(u)
	if conds["NamesAccepted"] == "False" {
		return HealthDegraded // a name conflict with another CRD — it isn't serving
	}
	switch conds["Established"] {
	case "True":
		return HealthHealthy
	case "False":
		return HealthDegraded
	}
	return HealthHealthy // no Established condition yet (just created) — existence == health
}

// flowControlHealth reads an API Priority and Fairness object. A FlowSchema's Dangling=True means it
// references a missing PriorityLevelConfiguration — a real misconfiguration; otherwise it's healthy. Its
// only condition is Dangling (not Ready/Available), so the catch-all called every FlowSchema Unknown. A
// PriorityLevelConfiguration carries no conditions and is healthy by existence.
func flowControlHealth(u *unstructured.Unstructured, kind string) Health {
	if kind == "FlowSchema" && conditionStatuses(u)["Dangling"] == "True" {
		return HealthDegraded
	}
	return HealthHealthy
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

// nodeClaimStatus summarizes a Karpenter NodeClaim — the in-flight request for a node. Until it is
// Ready the Ready condition's reason is the "why" (still launching, insufficient capacity); once Ready
// the resolved capacity type + instance type ("spot · r5dn.large") answers the operator's first
// question about a node: how interruptible (spot vs on-demand) and how big. Both come from the labels
// Karpenter writes onto the NodeClaim as it provisions, so an unlaunched claim falls back silently.
func nodeClaimStatus(u *unstructured.Unstructured) string {
	if crConditionStatus(u, "Ready") == "False" {
		if r := crConditionReason(u, "Ready"); r != "" {
			return r
		}
		return "NotReady"
	}
	labels := u.GetLabels()
	capType, instType := labels["karpenter.sh/capacity-type"], labels["node.kubernetes.io/instance-type"]
	switch {
	case capType != "" && instType != "":
		return capType + " · " + instType
	case instType != "":
		return instType
	default:
		return capType
	}
}

// apiServiceStatus summarizes an aggregated APIService: which Service backs the API group, and — when
// the apiserver can't reach that backend — the Available=False reason. An unavailable aggregated API
// (metrics.k8s.io, custom.metrics, a conversion webhook's API) silently breaks every client of that
// group — kubectl top, the HPA, `kubectl get <cr>` — with no hint at the APIService node itself, which
// otherwise reads blank. A Local APIService (a built-in group served by the apiserver, no backing
// service) carries nothing worth surfacing, so it stays silent.
func apiServiceStatus(u *unstructured.Unstructured) string {
	svcName, _, _ := unstructured.NestedString(u.Object, "spec", "service", "name")
	if svcName == "" {
		return "" // a Local group served by the apiserver itself
	}
	backend := svcName
	if ns, _, _ := unstructured.NestedString(u.Object, "spec", "service", "namespace"); ns != "" {
		backend = ns + "/" + svcName
	}
	if crConditionStatus(u, "Available") == "False" {
		if r := crConditionReason(u, "Available"); r != "" {
			return "Unavailable · " + r
		}
		return "Unavailable"
	}
	return "→ " + backend
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

// crConditionReason returns the short reason token (e.g. "FailedDiscoveryCheck") of the named
// status.conditions[] entry — the compact "why" behind a non-True condition, preferred over the long
// free-text message for a status chip. Empty when the condition or its reason is absent.
func crConditionReason(u *unstructured.Unstructured, typ string) string {
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
			r, _ := m["reason"].(string)
			return r
		}
	}
	return ""
}
