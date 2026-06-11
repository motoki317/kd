package graph

// Health rule for Elastic Cloud on Kubernetes (every *.k8s.elastic.co kind) — the cluster-color
// status.health vocabulary (green/yellow/red) plus Elasticsearch's orchestration phase.

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
