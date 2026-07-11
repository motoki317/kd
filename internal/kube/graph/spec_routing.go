package graph

// The routing-table extractors: Ingress, Gateway-API HTTPRoute, and Traefik IngressRoute/Middleware.
// Split from spec.go because routing is its own grown topic (three API families rendering one
// "match → backend" row idiom) and the likeliest to grow again (GRPCRoute is a known candidate —
// see docs/backlog.md). Shared scalar helpers (intStrString, asUnstructuredKind) stay in spec.go.

import (
	"fmt"
	"sort"
	"strings"

	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

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
	u := asUnstructuredKind(obj, "HTTPRoute")
	if u == nil {
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
		if port := intStrString(r["port"]); port != "" {
			name += ":" + port
		}
		out = append(out, name)
	}
	return strings.Join(out, ", ")
}

// traefikIngressRouteRoutes formats a Traefik IngressRoute's routing table as "match → service[:port]"
// rows (nil otherwise). Traefik's match is already a human-readable matcher expression
// (Host(`x`) && PathPrefix(`/y`)), so it's shown verbatim; a route's services join with ", ". A route
// with no plain-Service backend (a TraefikService chain, or middleware-only) still shows its match so
// the rule is visible. IngressRoute is a CRD, so it arrives unstructured.
func traefikIngressRouteRoutes(obj runtime.Object) []string {
	u := asUnstructuredKind(obj, "IngressRoute")
	if u == nil || !isTraefik(u) {
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
		mw := traefikRouteMiddlewares(route)
		if svc := traefikRouteServices(route); svc != "" {
			out = append(out, match+" → "+svc+mw)
		} else {
			out = append(out, match+mw)
		}
	}
	return out
}

// traefikRouteMiddlewares renders a route's middleware chain as " · via name[, ns/name…]" in spec
// order (Traefik applies them in sequence — auth, rate-limit, header rewrites — so order is meaningful),
// qualifying a cross-namespace middleware with its namespace. Empty when the route has none. The chain
// is the "what processing happens to this request" the host→service mapping can't show; a cross-namespace
// middleware (a shared auth gateway) never appears as a same-namespace graph edge, so the route row is
// the only place it surfaces.
func traefikRouteMiddlewares(route map[string]any) string {
	mws, _ := route["middlewares"].([]any)
	var names []string
	for _, mi := range mws {
		m, ok := mi.(map[string]any)
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		if ns, _ := m["namespace"].(string); ns != "" {
			name = ns + "/" + name
		}
		names = append(names, name)
	}
	if len(names) == 0 {
		return ""
	}
	return " · via " + strings.Join(names, ", ")
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

// traefikMiddlewareSummary renders a Traefik Middleware's essence — WHAT it does — as its type plus the
// one parameter an operator checks ("rateLimit 10/1s, burst 20", "forwardAuth → http://auth/", "redirect
// → https"). A Middleware's spec carries exactly one key: the middleware type. The common types are
// enriched; any other (or a new one) falls back to the bare type name, still answering "what kind is
// this" — which the card/drawer otherwise left blank, so clicking through from a route's "via <name>"
// chain revealed nothing without opening the YAML. Empty for non-Traefik / non-Middleware kinds.
func traefikMiddlewareSummary(obj runtime.Object) string {
	u := asUnstructuredKind(obj, "Middleware")
	if u == nil || !isTraefik(u) {
		return ""
	}
	spec, found, _ := unstructured.NestedMap(u.Object, "spec")
	if !found || len(spec) == 0 {
		return ""
	}
	keys := make([]string, 0, len(spec))
	for k := range spec {
		keys = append(keys, k)
	}
	sort.Strings(keys) // exactly one key in practice; sorted for determinism if ever more
	typ := keys[0]
	str := func(path ...string) string {
		s, _, _ := unstructured.NestedString(u.Object, append([]string{"spec", typ}, path...)...)
		return s
	}
	num := func(path ...string) int64 {
		v, _ := nestedNum(u.Object, append([]string{"spec", typ}, path...)...)
		return v
	}
	switch typ {
	case "rateLimit":
		period := str("period")
		if period == "" {
			period = "1s"
		}
		s := fmt.Sprintf("rateLimit %d/%s", num("average"), period)
		if b := num("burst"); b > 0 {
			s += fmt.Sprintf(", burst %d", b)
		}
		return s
	case "redirectScheme":
		if sc := str("scheme"); sc != "" {
			return "redirect → " + sc
		}
		return "redirectScheme"
	case "forwardAuth":
		if a := str("address"); a != "" {
			return "forwardAuth → " + a
		}
		return "forwardAuth"
	case "stripPrefix":
		if p, _, _ := unstructured.NestedStringSlice(u.Object, "spec", typ, "prefixes"); len(p) > 0 {
			return "stripPrefix " + strings.Join(p, ", ")
		}
		return "stripPrefix"
	case "addPrefix":
		if p := str("prefix"); p != "" {
			return "addPrefix " + p
		}
		return "addPrefix"
	case "inFlightReq":
		return fmt.Sprintf("inFlightReq %d", num("amount"))
	case "retry":
		return fmt.Sprintf("retry %d", num("attempts"))
	case "ipAllowList", "ipWhiteList":
		if r, _, _ := unstructured.NestedStringSlice(u.Object, "spec", typ, "sourceRange"); len(r) > 0 {
			return typ + " " + strings.Join(r, ", ")
		}
		return typ
	case "chain":
		if ms, _, _ := unstructured.NestedSlice(u.Object, "spec", typ, "middlewares"); len(ms) > 0 {
			return fmt.Sprintf("chain of %d", len(ms))
		}
		return "chain"
	default:
		return typ // bare type (headers, basicAuth, compress, circuitBreaker, …) — still the key fact
	}
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
