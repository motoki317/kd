package graph

// Status rule for Karpenter (karpenter.sh) NodeClaims — the in-flight node request's "why not
// ready" reason, or the resolved capacity/instance type once launched.

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
