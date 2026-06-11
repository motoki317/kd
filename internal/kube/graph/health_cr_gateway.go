package graph

// Health rules for the Gateway API (gateway.networking.k8s.io) — standard metav1 conditions but with
// kind-specific types (Accepted/Programmed/ResolvedRefs, never Ready/Available), plus the per-parent
// status fold a *Route needs.

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
