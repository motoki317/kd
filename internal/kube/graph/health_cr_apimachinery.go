package graph

// Health/status rules for built-in apiserver machinery — CRDs, API Priority and Fairness, and
// aggregated APIServices: groups whose signals (Established, Dangling, Available + reason) need
// dedicated reads beyond the generic Ready/Available heuristic.

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
