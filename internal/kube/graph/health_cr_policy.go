package graph

// Health rules for policy reports (wgpolicyk8s.io PolicyReport/ClusterPolicyReport and Kyverno's
// reports.kyverno.io) — the pass/fail result tally, which the two families nest differently.

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
		if v, ok := nestedNum(u.Object, base...); ok {
			return v
		}
	}
	return 0
}
