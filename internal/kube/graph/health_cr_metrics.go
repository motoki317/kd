package graph

// Health rule for the VictoriaMetrics operator (operator.victoriametrics.com) — status.updateStatus
// reconcile states plus the config CRs' "<qualified>/Applied" condition.

import (
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
