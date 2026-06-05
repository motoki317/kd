package graph

import (
	"fmt"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
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

// cronLastRun returns a CronJob's last schedule time as RFC3339 (empty when it has never fired or for
// other kinds) — the "did my cron actually run?" answer the schedule expression alone can't give.
func cronLastRun(obj runtime.Object) string {
	if o, ok := obj.(*batchv1.CronJob); ok && o.Status.LastScheduleTime != nil {
		return o.Status.LastScheduleTime.UTC().Format(time.RFC3339)
	}
	return ""
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
