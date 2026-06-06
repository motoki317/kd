package graph

import (
	"fmt"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// This file surfaces the declarative spec of the resources that anchor the relationship views — a
// Service's address/ports, an Ingress's routes, a Role's rules, a binding's grantees — as
// display-ready strings on the graph Node. They answer "what does this resource declare" for the
// network and RBAC views, the counterpart to fields.go's "what is this pod/node doing at runtime".

// servicePorts formats a Service's port mappings as "[name ]port[→target][:nodePort]/proto" (nil for
// non-services), the "what does this route to, on which port" detail the network view needs without
// opening the manifest. The target port is shown only when it differs from the service port, and the
// node port only when set (NodePort/LoadBalancer).
func servicePorts(obj runtime.Object) []string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return nil
	}
	if len(svc.Spec.Ports) == 0 {
		return nil
	}
	out := make([]string, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		s := fmt.Sprintf("%d", p.Port)
		if tp := p.TargetPort.String(); tp != "" && tp != "0" && tp != s {
			s += "→" + tp
		}
		if p.NodePort != 0 {
			s += fmt.Sprintf(":%d", p.NodePort)
		}
		proto := p.Protocol
		if proto == "" {
			proto = corev1.ProtocolTCP
		}
		s += "/" + string(proto)
		if p.Name != "" {
			s = p.Name + " " + s
		}
		out = append(out, s)
	}
	return out
}

// serviceClusterIP returns a Service's reachable address for the drawer: its cluster IP, "headless"
// for a headless (ClusterIP: None) service, or the aliased host for an ExternalName service. "" for
// non-services or a not-yet-assigned IP, so the drawer omits it.
func serviceClusterIP(obj runtime.Object) string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return ""
	}
	switch {
	case svc.Spec.Type == corev1.ServiceTypeExternalName:
		return svc.Spec.ExternalName
	case svc.Spec.ClusterIP == corev1.ClusterIPNone:
		return "headless"
	default:
		return svc.Spec.ClusterIP
	}
}

// serviceExternalAddress returns a Service's external reachability — the "how do I reach this from
// outside the cluster" answer the cluster IP can't give: a LoadBalancer's assigned ingress IP (or
// hostname, or "pending" while it provisions) and any admin-set spec.externalIPs. An IP is preferred
// over a hostname as the more specific address. "" for a plain ClusterIP service (nothing external)
// or non-services, so the drawer omits it.
func serviceExternalAddress(obj runtime.Object) string {
	svc, ok := obj.(*corev1.Service)
	if !ok {
		return ""
	}
	var addrs []string
	for _, ing := range svc.Status.LoadBalancer.Ingress {
		if ing.IP != "" {
			addrs = append(addrs, ing.IP)
		} else if ing.Hostname != "" {
			addrs = append(addrs, ing.Hostname)
		}
	}
	addrs = append(addrs, svc.Spec.ExternalIPs...)
	if len(addrs) == 0 {
		if svc.Spec.Type == corev1.ServiceTypeLoadBalancer {
			return "pending" // requested an external IP; the provider hasn't assigned one yet
		}
		return ""
	}
	return strings.Join(addrs, ", ")
}

// ingressRoutes formats an Ingress's routing table as "host/path → service:port" rows (nil for
// non-ingresses), so the network view's entry point says where external traffic actually goes without
// opening the manifest. A hostless rule shows "*", an empty path "/", and a default backend leads as
// "default → …". The Ingress→Service edges already show the targets; this adds the host/path mapping.
func ingressRoutes(obj runtime.Object) []string {
	ing, ok := obj.(*networkingv1.Ingress)
	if !ok {
		return nil
	}
	var routes []string
	if db := ing.Spec.DefaultBackend; db != nil && db.Service != nil {
		routes = append(routes, "default → "+ingressBackend(db.Service))
	}
	for _, r := range ing.Spec.Rules {
		if r.HTTP == nil {
			continue
		}
		host := r.Host
		if host == "" {
			host = "*"
		}
		for _, p := range r.HTTP.Paths {
			if p.Backend.Service == nil {
				continue // resource backends (non-Service) have no node to point at
			}
			path := p.Path
			if path == "" {
				path = "/"
			}
			routes = append(routes, host+path+" → "+ingressBackend(p.Backend.Service))
		}
	}
	return routes
}

// ingressBackend renders an Ingress backend as "service:port", using the named port when set.
func ingressBackend(s *networkingv1.IngressServiceBackend) string {
	switch {
	case s.Port.Name != "":
		return s.Name + ":" + s.Port.Name
	case s.Port.Number != 0:
		return fmt.Sprintf("%s:%d", s.Name, s.Port.Number)
	default:
		return s.Name
	}
}

// routes returns the human-readable routing table ("host/path → service:port" rows) for the kinds that
// declare one. Legacy Ingress, Gateway API HTTPRoute, and Traefik IngressRoute all solve the same
// problem (external entry → backend service), so they share one Node.Routes field and render
// identically; the drawer needn't know which API produced the table.
func routes(obj runtime.Object) []string {
	if r := ingressRoutes(obj); r != nil {
		return r
	}
	if r := httpRouteRoutes(obj); r != nil {
		return r
	}
	return traefikIngressRouteRoutes(obj)
}

// httpRouteRoutes formats a Gateway API HTTPRoute's routing table as "host/path → service[:port]" rows
// (nil for anything else), matching ingressRoutes so the modern entry point reads identically without
// opening the manifest. Unlike an Ingress, an HTTPRoute's hostnames are route-wide rather than per-rule,
// so every hostname pairs with every rule's path matches; a route with no hostnames shows "*", a
// match with no path "/", and a RegularExpression path is prefixed "~" to distinguish it. HTTPRoute is a
// CRD, so it arrives unstructured (no typed factory) and is navigated by field path.
func httpRouteRoutes(obj runtime.Object) []string {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok || u.GetKind() != "HTTPRoute" {
		return nil
	}
	hosts, _, _ := unstructured.NestedStringSlice(u.Object, "spec", "hostnames")
	if len(hosts) == 0 {
		hosts = []string{"*"}
	}
	rules, _, _ := unstructured.NestedSlice(u.Object, "spec", "rules")
	var out []string
	for _, ri := range rules {
		rule, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		backend := httpRouteBackends(rule)
		if backend == "" {
			continue // a rule with no resolvable backend has no node to point at
		}
		for _, host := range hosts {
			for _, path := range httpRoutePaths(rule) {
				out = append(out, host+path+" → "+backend)
			}
		}
	}
	return out
}

// httpRoutePaths returns the path strings of an HTTPRoute rule's matches. A rule with no matches matches
// everything ("/"); a header/method-only match (no path block) also reads as "/".
func httpRoutePaths(rule map[string]any) []string {
	matches, _ := rule["matches"].([]any)
	if len(matches) == 0 {
		return []string{"/"}
	}
	var paths []string
	for _, mi := range matches {
		m, ok := mi.(map[string]any)
		if !ok {
			continue
		}
		p, ok := m["path"].(map[string]any)
		if !ok {
			paths = append(paths, "/")
			continue
		}
		value, _ := p["value"].(string)
		if value == "" {
			value = "/"
		}
		if t, _ := p["type"].(string); t == "RegularExpression" {
			value = "~" + value
		}
		paths = append(paths, value)
	}
	if len(paths) == 0 {
		return []string{"/"}
	}
	return paths
}

// httpRouteBackends renders an HTTPRoute rule's backendRefs as "name[:port]" joined by ", " (multiple
// backends are a weighted split). A ref without a name is skipped; an empty result drops the rule.
func httpRouteBackends(rule map[string]any) string {
	refs, _ := rule["backendRefs"].([]any)
	var out []string
	for _, ri := range refs {
		r, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		name, _ := r["name"].(string)
		if name == "" {
			continue
		}
		if port := httpRoutePort(r); port != "" {
			name += ":" + port
		}
		out = append(out, name)
	}
	return strings.Join(out, ", ")
}

// httpRoutePort reads a backendRef's port, tolerating both numeric shapes unstructured decoding yields
// (int64 from the dynamic client, float64 from a JSON round-trip).
func httpRoutePort(ref map[string]any) string {
	return intStrString(ref["port"])
}

// intStrString renders an unstructured port-like value that may be a number (int64 from the dynamic
// client, float64 from a JSON round-trip) or a named-port string. Empty for anything else (e.g. absent).
func intStrString(v any) string {
	switch p := v.(type) {
	case string:
		return p
	case int64:
		return fmt.Sprintf("%d", p)
	case float64:
		return fmt.Sprintf("%d", int64(p))
	}
	return ""
}

// traefikIngressRouteRoutes formats a Traefik IngressRoute's routing table as "match → service[:port]"
// rows (nil otherwise). Traefik's match is already a human-readable matcher expression
// (Host(`x`) && PathPrefix(`/y`)), so it's shown verbatim; a route's services join with ", ". A route
// with no plain-Service backend (a TraefikService chain, or middleware-only) still shows its match so
// the rule is visible. IngressRoute is a CRD, so it arrives unstructured.
func traefikIngressRouteRoutes(obj runtime.Object) []string {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok || u.GetKind() != "IngressRoute" || !isTraefik(u) {
		return nil
	}
	routeList, _, _ := unstructured.NestedSlice(u.Object, "spec", "routes")
	var out []string
	for _, ri := range routeList {
		route, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		match, _ := route["match"].(string)
		if match == "" {
			continue
		}
		if svc := traefikRouteServices(route); svc != "" {
			out = append(out, match+" → "+svc)
		} else {
			out = append(out, match)
		}
	}
	return out
}

// traefikRouteServices renders an IngressRoute route's backend services as "name[:port]" joined by ", ".
// A Traefik service port is an int-or-string (a named port is valid), so it tolerates both.
func traefikRouteServices(route map[string]any) string {
	svcs, _ := route["services"].([]any)
	var out []string
	for _, si := range svcs {
		s, ok := si.(map[string]any)
		if !ok {
			continue
		}
		name, _ := s["name"].(string)
		if name == "" {
			continue
		}
		if port := intStrString(s["port"]); port != "" {
			name += ":" + port
		}
		out = append(out, name)
	}
	return strings.Join(out, ", ")
}

// isTraefik reports whether a CR belongs to Traefik's API group (the current traefik.io and the legacy
// traefik.containo.us both ship IngressRoute).
func isTraefik(u *unstructured.Unstructured) bool {
	switch u.GroupVersionKind().Group {
	case "traefik.io", "traefik.containo.us":
		return true
	}
	return false
}

// dataKeys lists a ConfigMap's or Secret's data keys as "key · size" rows, sorted (nil for other
// kinds), so the drawer answers "what does this hold?" without opening the manifest — the same
// declarative-essence surfacing routes/rules give an Ingress/Role. Only key NAMES and byte sizes are
// emitted, NEVER values: for a Secret the values are sensitive, and a name+size list is strictly less
// than the (RBAC-gated) Manifest tab already reveals. ConfigMap binaryData is included alongside data.
func dataKeys(obj runtime.Object) []string {
	sizes := map[string]int{}
	switch o := obj.(type) {
	case *corev1.ConfigMap:
		for k, v := range o.Data {
			sizes[k] = len(v)
		}
		for k, v := range o.BinaryData {
			sizes[k] = len(v)
		}
	case *corev1.Secret:
		for k, v := range o.Data {
			sizes[k] = len(v) // already-decoded bytes; we surface the length, not the content
		}
		for k, v := range o.StringData {
			sizes[k] = len(v)
		}
	default:
		return nil
	}
	if len(sizes) == 0 {
		return nil
	}
	keys := make([]string, 0, len(sizes))
	for k := range sizes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = k + " · " + humanizeBytes(int64(sizes[k]))
	}
	return out
}

// accessModeShort abbreviates a PVC/PV access mode to the form operators read in `kubectl get pvc`
// (RWO/ROX/RWX/RWOP), so the drawer answers "can more than one pod mount this?" at a glance.
func accessModeShort(m corev1.PersistentVolumeAccessMode) string {
	switch m {
	case corev1.ReadWriteOnce:
		return "RWO"
	case corev1.ReadOnlyMany:
		return "ROX"
	case corev1.ReadWriteMany:
		return "RWX"
	case corev1.ReadWriteOncePod:
		return "RWOP"
	}
	return string(m)
}

// accessModes joins a PVC's or PV's access modes in the abbreviated kubectl form (nil-safe, "" for
// other kinds). De-duplicated because the API can list a mode more than once.
func accessModes(obj runtime.Object) string {
	var modes []corev1.PersistentVolumeAccessMode
	switch o := obj.(type) {
	case *corev1.PersistentVolumeClaim:
		modes = o.Spec.AccessModes
	case *corev1.PersistentVolume:
		modes = o.Spec.AccessModes
	default:
		return ""
	}
	seen := map[string]bool{}
	var out []string
	for _, m := range modes {
		s := accessModeShort(m)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return strings.Join(out, "/")
}

// storageClass returns a PVC's or PV's storage class name (the provisioner/tier), "" when unset for
// other kinds. A PVC's spec.storageClassName is the request; we don't fall back to the bound PV's class
// here (the client shows whichever the object itself declares — the manifest carries the resolved one).
func storageClass(obj runtime.Object) string {
	switch o := obj.(type) {
	case *corev1.PersistentVolumeClaim:
		if o.Spec.StorageClassName != nil {
			return *o.Spec.StorageClassName
		}
	case *corev1.PersistentVolume:
		return o.Spec.StorageClassName
	}
	return ""
}

// batchActive returns how many pods/jobs a Job or CronJob has running right now ("is one running?"),
// the answer the "succeeded/total" status and schedule expression both omit. 0 for other kinds.
func batchActive(obj runtime.Object) int32 {
	switch o := obj.(type) {
	case *batchv1.Job:
		return o.Status.Active
	case *batchv1.CronJob:
		return int32(len(o.Status.Active))
	}
	return 0
}

// batchFailed returns a Job's failed-pod count — burning retries that the "succeeded/total" status
// hides (a Job at "0/1" with 5 failures looks merely pending). 0 for other kinds.
func batchFailed(obj runtime.Object) int32 {
	if o, ok := obj.(*batchv1.Job); ok {
		return o.Status.Failed
	}
	return 0
}

// cronLastRun returns a cron resource's last schedule time as RFC3339 (empty when it has never fired
// or for other kinds) — the "did my cron actually run?" answer the schedule expression alone can't
// give. Covers both a typed batch/v1 CronJob and an Argo CronWorkflow (a CR, navigated by field path:
// status.lastScheduledTime), so the drawer's "last run" chip works for both.
func cronLastRun(obj runtime.Object) string {
	if o, ok := obj.(*batchv1.CronJob); ok && o.Status.LastScheduleTime != nil {
		return o.Status.LastScheduleTime.UTC().Format(time.RFC3339)
	}
	if u := asUnstructuredKind(obj, "CronWorkflow"); u != nil {
		if t, ok, _ := unstructured.NestedString(u.Object, "status", "lastScheduledTime"); ok {
			return t
		}
	}
	return ""
}

// cronWorkflowSchedule renders an Argo CronWorkflow's cron schedule(s) with its timezone, the "when
// does this run" the status line otherwise omits. Argo v3 uses spec.schedules (a list); older
// CronWorkflows used the singular spec.schedule — both are handled. Empty for non-CronWorkflows.
func cronWorkflowSchedule(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "CronWorkflow")
	if u == nil {
		return ""
	}
	var crons []string
	if list, ok, _ := unstructured.NestedStringSlice(u.Object, "spec", "schedules"); ok {
		crons = list
	} else if one, ok, _ := unstructured.NestedString(u.Object, "spec", "schedule"); ok && one != "" {
		crons = []string{one}
	}
	if len(crons) == 0 {
		return ""
	}
	sched := strings.Join(crons, ", ")
	if tz, ok, _ := unstructured.NestedString(u.Object, "spec", "timezone"); ok && tz != "" {
		sched += " (" + tz + ")"
	}
	return sched
}

// asUnstructuredKind returns obj as an unstructured object when it is one AND its kind matches — the
// access gate every CR-essence extractor shares (kd keeps CRs and the few schemaless built-ins like HPA
// and StorageClass as *unstructured.Unstructured; see typedFactories). nil when the type or kind differs,
// so a caller reads `if u := asUnstructuredKind(obj, "X"); u != nil { … }`.
func asUnstructuredKind(obj runtime.Object, kind string) *unstructured.Unstructured {
	if u, ok := obj.(*unstructured.Unstructured); ok && u.GetKind() == kind {
		return u
	}
	return nil
}

// hpaScale extracts a HorizontalPodAutoscaler's replica state — "current" when stable, "current → desired"
// mid-scale — answering "how many is it running, and is it actively scaling?". Empty for non-HPAs. An HPA
// has no typed factory here, so it arrives unstructured and is navigated by field path (the autoscaling
// v1/v2 schemas share these status field names).
func hpaScale(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "HorizontalPodAutoscaler")
	if u == nil {
		return ""
	}
	cur, hasCur, _ := unstructured.NestedInt64(u.Object, "status", "currentReplicas")
	des, hasDes, _ := unstructured.NestedInt64(u.Object, "status", "desiredReplicas")
	if !hasCur && !hasDes {
		return "" // status not populated yet (freshly created) — nothing to show
	}
	if hasDes && des != cur {
		return fmt.Sprintf("%d → %d", cur, des)
	}
	return fmt.Sprintf("%d", cur)
}

// hpaRange extracts an HPA's min–max replica bounds ("2–10"); minReplicas defaults to 1 when unset
// (matching the API default). Empty for non-HPAs or when maxReplicas is unset.
func hpaRange(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "HorizontalPodAutoscaler")
	if u == nil {
		return ""
	}
	maxR, hasMax, _ := unstructured.NestedInt64(u.Object, "spec", "maxReplicas")
	if !hasMax {
		return ""
	}
	minR, hasMin, _ := unstructured.NestedInt64(u.Object, "spec", "minReplicas")
	if !hasMin {
		minR = 1
	}
	return fmt.Sprintf("%d–%d", minR, maxR)
}

// pdbPolicy renders a PodDisruptionBudget's configured intent — "min N" (minAvailable) or "max N"
// (maxUnavailable), where N is a count or a percentage — the policy the status's "healthy" count alone
// doesn't reveal. Empty for non-PDBs or a PDB with neither set (invalid, but don't panic).
func pdbPolicy(obj runtime.Object) string {
	p, ok := obj.(*policyv1.PodDisruptionBudget)
	if !ok {
		return ""
	}
	switch {
	case p.Spec.MinAvailable != nil:
		return "min " + p.Spec.MinAvailable.String()
	case p.Spec.MaxUnavailable != nil:
		return "max " + p.Spec.MaxUnavailable.String()
	}
	return ""
}

// pdbDisruptions renders how many voluntary evictions a PDB allows right now (status.disruptionsAllowed)
// as a string so "0" — the operationally critical "a node drain will block here" state — is surfaced,
// not hidden by an omitempty zero. Empty only for non-PDBs.
func pdbDisruptions(obj runtime.Object) string {
	if p, ok := obj.(*policyv1.PodDisruptionBudget); ok {
		return fmt.Sprintf("%d", p.Status.DisruptionsAllowed)
	}
	return ""
}

// asStorageClass returns the object as an unstructured StorageClass (kd has no typed factory for it), or
// nil. A StorageClass's fields (provisioner, reclaimPolicy, …) sit at the top level, not under spec.
func asStorageClass(obj runtime.Object) *unstructured.Unstructured {
	return asUnstructuredKind(obj, "StorageClass")
}

// storageClassProvisioner returns a StorageClass's provisioner (its defining fact — which CSI driver /
// plugin backs volumes on it), "" for other kinds.
func storageClassProvisioner(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		s, _, _ := unstructured.NestedString(u.Object, "provisioner")
		return s
	}
	return ""
}

// storageClassReclaim returns a StorageClass's reclaim policy (Delete/Retain — does deleting a PVC
// destroy the underlying data?). The API default is Delete when unset.
func storageClassReclaim(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		if s, found, _ := unstructured.NestedString(u.Object, "reclaimPolicy"); found {
			return s
		}
		return "Delete"
	}
	return ""
}

// storageClassBinding returns a StorageClass's volume binding mode (Immediate / WaitForFirstConsumer).
// Immediate is the API default when unset.
func storageClassBinding(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		if s, found, _ := unstructured.NestedString(u.Object, "volumeBindingMode"); found {
			return s
		}
		return "Immediate"
	}
	return ""
}

// storageClassExpandable reports a StorageClass's allowVolumeExpansion (can PVCs on it grow?).
func storageClassExpandable(obj runtime.Object) bool {
	if u := asStorageClass(obj); u != nil {
		b, _, _ := unstructured.NestedBool(u.Object, "allowVolumeExpansion")
		return b
	}
	return false
}

// secretType returns a Secret's type as a display string (empty for non-Secrets). An empty type
// defaults to Opaque, mirroring Kubernetes.
func secretType(obj runtime.Object) string {
	s, ok := obj.(*corev1.Secret)
	if !ok {
		return ""
	}
	if s.Type == "" {
		return string(corev1.SecretTypeOpaque)
	}
	return string(s.Type)
}

// roleRules formats a Role/ClusterRole's policy rules as "resources: verbs" rows (nil otherwise), so
// the RBAC view answers "what does this grant?" at a glance instead of in the manifest. Resources are
// shown kubectl-style ("deployments.apps", core group bare), resourceNames in [brackets], and a
// non-resource-URL rule (ClusterRole) as "url: verbs".
func roleRules(obj runtime.Object) []string {
	var rules []rbacv1.PolicyRule
	switch o := obj.(type) {
	case *rbacv1.Role:
		rules = o.Rules
	case *rbacv1.ClusterRole:
		rules = o.Rules
	default:
		return nil
	}
	out := make([]string, 0, len(rules))
	for _, r := range rules {
		verbs := strings.Join(r.Verbs, ", ")
		if len(r.NonResourceURLs) > 0 {
			out = append(out, strings.Join(r.NonResourceURLs, ", ")+": "+verbs)
			continue
		}
		var res []string
		for _, group := range r.APIGroups {
			for _, name := range r.Resources {
				if group == "" {
					res = append(res, name)
				} else {
					res = append(res, name+"."+group)
				}
			}
		}
		line := strings.Join(res, ", ")
		if len(r.ResourceNames) > 0 {
			line += " [" + strings.Join(r.ResourceNames, ", ") + "]"
		}
		out = append(out, line+": "+verbs)
	}
	return out
}

// networkPolicySummary distills a NetworkPolicy into the lines an operator debugging "why can't A
// reach B" needs without opening the YAML: which pods it applies to (podSelector), and for each
// GOVERNED direction whether it denies all (the type is listed but carries no rules — a lockdown) or
// allows N rule-sets. A direction not in policyTypes isn't governed at all, so it's omitted rather
// than shown as "allow all", which would misread an ungoverned direction as an explicit allow. nil
// for non-NetworkPolicies.
func networkPolicySummary(obj runtime.Object) []string {
	np, ok := obj.(*networkingv1.NetworkPolicy)
	if !ok {
		return nil
	}
	governs := func(t networkingv1.PolicyType) bool {
		for _, p := range np.Spec.PolicyTypes {
			if p == t {
				return true
			}
		}
		return false
	}
	out := []string{"targets: " + selectorSummary(&np.Spec.PodSelector)}
	if governs(networkingv1.PolicyTypeIngress) {
		out = append(out, "Ingress: "+ruleCountSummary(len(np.Spec.Ingress)))
	}
	if governs(networkingv1.PolicyTypeEgress) {
		out = append(out, "Egress: "+ruleCountSummary(len(np.Spec.Egress)))
	}
	return out
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

// ruleCountSummary names a governed direction's rule set: zero rules under a listed policyType is a
// deny-all lockdown (the operationally critical case), otherwise the count of allow rule-sets.
func ruleCountSummary(n int) string {
	switch n {
	case 0:
		return "deny all"
	case 1:
		return "1 rule"
	default:
		return fmt.Sprintf("%d rules", n)
	}
}

// selectorSummary renders a LabelSelector as "k=v, k2=v2" (matchExpressions appended as "key op
// (values)"), or "all pods" when empty — which for a NetworkPolicy podSelector means every pod in the
// namespace. matchLabels are sorted so the string is stable across SSE patches.
func selectorSummary(sel *metav1.LabelSelector) string {
	if sel == nil || (len(sel.MatchLabels) == 0 && len(sel.MatchExpressions) == 0) {
		return "all pods"
	}
	keys := make([]string, 0, len(sel.MatchLabels))
	for k := range sel.MatchLabels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys)+len(sel.MatchExpressions))
	for _, k := range keys {
		parts = append(parts, k+"="+sel.MatchLabels[k])
	}
	for _, e := range sel.MatchExpressions {
		parts = append(parts, fmt.Sprintf("%s %s (%s)", e.Key, strings.ToLower(string(e.Operator)), strings.Join(e.Values, ",")))
	}
	return strings.Join(parts, ", ")
}

// bindingRoleRef renders a RoleBinding/ClusterRoleBinding's target role as "Kind/name" ("" otherwise).
// The binding→role edge already shows an in-namespace Role, but a roleRef to a cluster-scoped
// ClusterRole has no node in a namespace graph, so this is the only place that target is visible.
func bindingRoleRef(obj runtime.Object) string {
	switch o := obj.(type) {
	case *rbacv1.RoleBinding:
		return o.RoleRef.Kind + "/" + o.RoleRef.Name
	case *rbacv1.ClusterRoleBinding:
		return o.RoleRef.Kind + "/" + o.RoleRef.Name
	default:
		return ""
	}
}

// bindingSubjects renders who a RoleBinding/ClusterRoleBinding grants to as "Kind: [namespace/]name"
// rows (nil otherwise). User and Group subjects aren't Kubernetes objects, so they have no node and
// are invisible in the topology — this surfaces them, the core "who got access" audit answer.
func bindingSubjects(obj runtime.Object) []string {
	var subjects []rbacv1.Subject
	switch o := obj.(type) {
	case *rbacv1.RoleBinding:
		subjects = o.Subjects
	case *rbacv1.ClusterRoleBinding:
		subjects = o.Subjects
	default:
		return nil
	}
	if len(subjects) == 0 {
		return nil
	}
	out := make([]string, 0, len(subjects))
	for _, s := range subjects {
		name := s.Name
		if s.Kind == "ServiceAccount" && s.Namespace != "" {
			name = s.Namespace + "/" + s.Name
		}
		out = append(out, s.Kind+": "+name)
	}
	return out
}
