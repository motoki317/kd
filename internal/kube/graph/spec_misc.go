package graph

// Extractors without a domain sibling (yet) — ArgoCD Application destination/revision, CRD and
// PriorityClass summaries, and Prometheus-Operator/VictoriaMetrics scrape configs. Prefer growing a
// real spec_<domain>.go over this file.

import (
	"strconv"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// argoApp returns the unstructured object when it is an ArgoCD Application — the group guard
// matters because "Application" is a generic kind name other operators also use.
func argoApp(obj runtime.Object) *unstructured.Unstructured {
	u := asUnstructuredKind(obj, "Application")
	if u == nil || u.GroupVersionKind().Group != "argoproj.io" {
		return nil
	}
	return u
}

// argoAppDest renders where an ArgoCD Application deploys — its destination namespace, prefixed
// with the cluster when it targets a remote one ("prod-cluster/shop"). kd's graph is namespace-
// scoped, so an Application card otherwise gives no pointer from the argocd namespace to where its
// workloads (and their trouble) actually live.
func argoAppDest(obj runtime.Object) string {
	u := argoApp(obj)
	if u == nil {
		return ""
	}
	ns, _, _ := unstructured.NestedString(u.Object, "spec", "destination", "namespace")
	cluster, _, _ := unstructured.NestedString(u.Object, "spec", "destination", "name")
	if cluster == "" || cluster == "in-cluster" {
		if server, _, _ := unstructured.NestedString(u.Object, "spec", "destination", "server"); server != "" && server != "https://kubernetes.default.svc" {
			cluster = strings.TrimPrefix(strings.TrimPrefix(server, "https://"), "http://")
		} else {
			cluster = ""
		}
	}
	switch {
	case cluster != "" && ns != "":
		return cluster + "/" + ns
	case cluster != "":
		return cluster
	default:
		return ns
	}
}

// argoAppRevision renders the revision an Application last synced to — "what's actually deployed".
// A 40-hex git SHA is shortened to 8 chars (what an operator pastes into git log); other revision
// forms (a chart version, a tag) pass through. Multi-source apps (status.sync.revisions) are
// omitted rather than half-rendered.
func argoAppRevision(obj runtime.Object) string {
	u := argoApp(obj)
	if u == nil {
		return ""
	}
	rev, _, _ := unstructured.NestedString(u.Object, "status", "sync", "revision")
	if len(rev) == 40 && strings.IndexFunc(rev, func(r rune) bool {
		return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f')
	}) < 0 {
		return rev[:8]
	}
	return rev
}

// priorityClassSummary renders a PriorityClass's essence — its priority value (the number that decides
// preemption: higher wins), whether it's the cluster's globalDefault (the priority pods get when they
// name none — the single most useful fact for "why did my pod get this priority"), and a "never
// preempts" note when preemptionPolicy is Never. The value is comma-grouped because these are often
// billions (system-cluster-critical = 2,000,000,000) and a raw 2000000000 hides the magnitude. Empty
// for any other kind. A PriorityClass arrives unstructured (scheduling.k8s.io types aren't typed here).
func priorityClassSummary(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "PriorityClass")
	if u == nil {
		return ""
	}
	val, found, _ := unstructured.NestedInt64(u.Object, "value")
	if !found {
		return ""
	}
	parts := []string{groupThousands(val)}
	if gd, _, _ := unstructured.NestedBool(u.Object, "globalDefault"); gd {
		parts = append(parts, "default")
	}
	if pp, _, _ := unstructured.NestedString(u.Object, "preemptionPolicy"); pp == "Never" {
		parts = append(parts, "never preempts")
	}
	return strings.Join(parts, " · ")
}

// groupThousands formats an integer with comma thousands-separators ("2000000000" → "2,000,000,000"),
// so a large magnitude reads at a glance. Sign-aware.
func groupThousands(n int64) string {
	s := strconv.FormatInt(n, 10)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteByte(s[i])
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

// crdSummary renders a CustomResourceDefinition's essence — the Kind it defines, its scope, and its
// served versions — as "Kind · Scope · v1[, v1beta1]", the answer to "what custom resource does this
// enable, and is it namespaced?" A CRD's own name is only `plural.group`, so the Kind and (crucially)
// the Cluster-vs-Namespaced scope are otherwise invisible without opening the manifest. Empty for any
// other kind. A CRD arrives unstructured (apiextensions types aren't in kd's typed factories).
func crdSummary(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "CustomResourceDefinition")
	if u == nil {
		return ""
	}
	var parts []string
	if kind, _, _ := unstructured.NestedString(u.Object, "spec", "names", "kind"); kind != "" {
		parts = append(parts, kind)
	}
	if scope, _, _ := unstructured.NestedString(u.Object, "spec", "scope"); scope != "" {
		parts = append(parts, scope)
	}
	versions, _, _ := unstructured.NestedSlice(u.Object, "spec", "versions")
	var served []string
	for _, vi := range versions {
		v, ok := vi.(map[string]any)
		if !ok {
			continue
		}
		if on, _, _ := unstructured.NestedBool(v, "served"); on {
			if name, _, _ := unstructured.NestedString(v, "name"); name != "" {
				served = append(served, name)
			}
		}
	}
	if len(served) > 0 {
		parts = append(parts, strings.Join(served, ", "))
	}
	return strings.Join(parts, " · ")
}

// scrapeConfig renders a Prometheus-Operator ServiceMonitor or a VictoriaMetrics VMServiceScrape's
// scrape target — the operator's "what does this scrape, on which port/path, how often?", otherwise
// buried in the manifest. Both CRs share the same spec shape (a service selector + a list of
// endpoints), so one extractor covers both. The first row is the target ("selects k=v [in ns,…]");
// each endpoint follows as ":port/path every interval". Empty for any other kind. Both are CRDs, so
// they arrive unstructured.
func scrapeConfig(obj runtime.Object) []string {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return nil
	}
	switch u.GetKind() {
	case "ServiceMonitor", "VMServiceScrape":
	default:
		return nil
	}
	target := "selects " + unstructuredSelectorSummary(u.Object, "spec", "selector")
	if names, _, _ := unstructured.NestedStringSlice(u.Object, "spec", "namespaceSelector", "matchNames"); len(names) > 0 {
		target += " in " + strings.Join(names, ", ")
	}
	out := []string{target}
	eps, _, _ := unstructured.NestedSlice(u.Object, "spec", "endpoints")
	for _, ei := range eps {
		if ep, ok := ei.(map[string]any); ok {
			out = append(out, scrapeEndpoint(ep))
		}
	}
	return out
}

// scrapeEndpoint renders one scrape endpoint as ":port/path every interval", dropping any part the
// endpoint leaves unset (a port-less endpoint scrapes the pod's declared port; a missing path defaults
// to /metrics in both operators).
func scrapeEndpoint(ep map[string]any) string {
	port, _ := ep["port"].(string)
	if port == "" {
		port = intStrString(ep["targetPort"])
	}
	path, _ := ep["path"].(string)
	if path == "" {
		path = "/metrics"
	}
	row := path
	if port != "" {
		row = ":" + port + path
	}
	if iv, _ := ep["interval"].(string); iv != "" {
		row += " every " + iv
	}
	return row
}

// unstructuredSelectorSummary reads a LabelSelector out of an unstructured spec by field path and
// formats it with selectorSummary. An empty/absent selector means "all services" here (a monitor with
// no selector scrapes everything), not selectorSummary's pod-centric "all pods".
func unstructuredSelectorSummary(obj map[string]any, fields ...string) string {
	raw, ok, _ := unstructured.NestedMap(obj, fields...)
	if !ok {
		return "all services"
	}
	var sel metav1.LabelSelector
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(raw, &sel); err != nil {
		return "all services"
	}
	if s := selectorSummary(&sel); s != "all pods" {
		return s
	}
	return "all services"
}
