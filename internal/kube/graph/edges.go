package graph

import (
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
)

// index resolves (kind, namespace, name) to a node ID, so inferred edges only ever point at
// nodes that exist in the graph (no dangling edges). Cluster-scoped objects use namespace "".
type index struct {
	byKey map[string]string
}

func newIndex(nodes []Node) *index {
	idx := &index{byKey: make(map[string]string, len(nodes))}
	for _, n := range nodes {
		idx.byKey[indexKey(n.Kind, n.Namespace, n.Name)] = n.ID
	}
	return idx
}

func indexKey(kind, namespace, name string) string {
	return kind + "|" + namespace + "|" + name
}

func (i *index) id(kind, namespace, name string) (string, bool) {
	id, ok := i.byKey[indexKey(kind, namespace, name)]
	return id, ok
}

// edgeBuilder accumulates edges, resolving endpoints through the index and de-duplicating.
type edgeBuilder struct {
	idx       *index
	edges     []Edge
	seen      map[Edge]bool
	endpoints map[string]*Endpoints // service node id -> readiness, populated alongside selects edges
}

// link adds an edge from a source node to a target identified by (kind, namespace, name),
// skipping it when either endpoint is missing from the graph.
func (b *edgeBuilder) link(fromID string, typ EdgeType, toKind, toNamespace, toName string) {
	toID, ok := b.idx.id(toKind, toNamespace, toName)
	if !ok || fromID == "" {
		return
	}
	e := Edge{From: fromID, To: toID, Type: typ}
	if b.seen[e] {
		return
	}
	b.seen[e] = true
	b.edges = append(b.edges, e)
}

// buildEdges infers every relationship edge from the typed objects, resolving endpoints
// through idx. Each inferrer is independent, so adding a relationship is adding a case here.
func buildEdges(nodes []Node, objs []runtime.Object, idx *index) ([]Edge, map[string]*Endpoints) {
	b := &edgeBuilder{idx: idx, seen: map[Edge]bool{}, endpoints: map[string]*Endpoints{}}

	// Owner edges come from metadata.ownerReferences (UID is the node ID), independent of kind.
	uids := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		uids[n.ID] = true
	}
	for _, n := range nodes {
		for _, ownerUID := range n.OwnerUIDs {
			if uids[ownerUID] {
				e := Edge{From: ownerUID, To: n.ID, Type: EdgeOwner}
				if !b.seen[e] {
					b.seen[e] = true
					b.edges = append(b.edges, e)
				}
			}
		}
	}

	for _, obj := range objs {
		kind, _, m, ok := describe(obj)
		if !ok {
			continue
		}
		id, ok := idx.id(kind, m.GetNamespace(), m.GetName())
		if !ok {
			continue
		}
		ns := m.GetNamespace()
		switch o := obj.(type) {
		case *corev1.Pod:
			b.podEdges(id, ns, o)
		case *corev1.Service:
			b.serviceEdges(id, ns, o, nodes)
		case *networkingv1.Ingress:
			b.ingressEdges(id, ns, o)
		case *policyv1.PodDisruptionBudget:
			b.pdbEdges(id, ns, o, nodes)
		case *corev1.PersistentVolumeClaim:
			// A bound PVC carries its target PV's name in spec.volumeName, completing the
			// Pod → PVC → PV chain in the Volumes view (cycle 235). Modeled as a `mounts`
			// edge so the volumes view's existing filter picks it up without a new edge type.
			if o.Spec.VolumeName != "" {
				b.link(id, EdgeMounts, "PersistentVolume", "", o.Spec.VolumeName)
			}
		case *rbacv1.RoleBinding:
			b.link(id, EdgeBinds, roleRefKind(o.RoleRef), roleRefNamespace(o.RoleRef, ns), o.RoleRef.Name)
			b.subjectEdges(id, ns, o.Subjects)
		case *rbacv1.ClusterRoleBinding:
			b.link(id, EdgeBinds, roleRefKind(o.RoleRef), "", o.RoleRef.Name)
			b.subjectEdges(id, "", o.Subjects)
		case *unstructured.Unstructured:
			// A Gateway API route (HTTPRoute/GRPCRoute/…) declares its backends in
			// spec.rules[].backendRefs — the Gateway-API analogue of an Ingress's rules. Model
			// them as EdgeRoutes so they share the Ingress's networking category, and skip the
			// generic scanners: backends are the route's whole reference surface, and the
			// convention scanner can't link a kind-less Service backendRef anyway (the common
			// shape, since Service is the backendRef default).
			if isGatewayRoute(o) {
				b.gatewayRouteEdges(id, ns, o)
				break
			}
			// A Traefik IngressRoute is the same story as an Ingress: spec.routes[].services name the
			// backend Services. Emit EdgeRoutes and skip the generic scanners, for the same reasons.
			if o.GetKind() == "IngressRoute" && isTraefik(o) {
				b.traefikIngressRouteEdges(id, ns, o)
				break
			}
			// Custom resource. Try the curated registry first (deterministic, hand-coded
			// for vendor schemas), then fall back to the convention scanner for the
			// generic {name, kind, …} shape.
			b.curatedRefEdges(id, o)
			b.conventionRefEdges(id, o)
		}
	}
	return b.edges, b.endpoints
}

func (b *edgeBuilder) podEdges(id, ns string, p *corev1.Pod) {
	if p.Spec.NodeName != "" {
		b.link(id, EdgeScheduledOn, "Node", "", p.Spec.NodeName)
	}
	if sa := p.Spec.ServiceAccountName; sa != "" {
		b.link(id, EdgeUsesServiceAccount, "ServiceAccount", ns, sa)
	}
	for _, v := range p.Spec.Volumes {
		switch {
		case v.ConfigMap != nil:
			b.link(id, EdgeMounts, "ConfigMap", ns, v.ConfigMap.Name)
		case v.Secret != nil:
			b.link(id, EdgeMounts, "Secret", ns, v.Secret.SecretName)
		case v.PersistentVolumeClaim != nil:
			b.link(id, EdgeMounts, "PersistentVolumeClaim", ns, v.PersistentVolumeClaim.ClaimName)
		case v.Projected != nil:
			for _, src := range v.Projected.Sources {
				if src.ConfigMap != nil {
					b.link(id, EdgeMounts, "ConfigMap", ns, src.ConfigMap.Name)
				}
				if src.Secret != nil {
					b.link(id, EdgeMounts, "Secret", ns, src.Secret.Name)
				}
			}
		}
	}
	for _, c := range append(append([]corev1.Container{}, p.Spec.InitContainers...), p.Spec.Containers...) {
		b.containerRefs(id, ns, c)
	}
}

func (b *edgeBuilder) containerRefs(id, ns string, c corev1.Container) {
	for _, ef := range c.EnvFrom {
		if ef.ConfigMapRef != nil {
			b.link(id, EdgeMounts, "ConfigMap", ns, ef.ConfigMapRef.Name)
		}
		if ef.SecretRef != nil {
			b.link(id, EdgeMounts, "Secret", ns, ef.SecretRef.Name)
		}
	}
	for _, e := range c.Env {
		if e.ValueFrom == nil {
			continue
		}
		if r := e.ValueFrom.ConfigMapKeyRef; r != nil {
			b.link(id, EdgeMounts, "ConfigMap", ns, r.Name)
		}
		if r := e.ValueFrom.SecretKeyRef; r != nil {
			b.link(id, EdgeMounts, "Secret", ns, r.Name)
		}
	}
}

func (b *edgeBuilder) serviceEdges(id, ns string, svc *corev1.Service, nodes []Node) {
	if len(svc.Spec.Selector) == 0 {
		return // selectorless: endpoints are managed externally, so we report no readiness
	}
	// Endpoint readiness reuses this selector match (a Healthy pod is a Ready backend). A 0/0 result
	// for a selector-based service is the meaningful "nothing is serving this" signal, so record it
	// even when no pod matches.
	ep := &Endpoints{}
	for _, n := range nodes {
		if n.Kind == "Pod" && n.Namespace == ns && labelsMatch(svc.Spec.Selector, n.Labels) {
			b.link(id, EdgeSelects, "Pod", ns, n.Name)
			ep.Total++
			if n.Health == HealthHealthy {
				ep.Ready++
			}
		}
	}
	b.endpoints[id] = ep
}

func (b *edgeBuilder) ingressEdges(id, ns string, ing *networkingv1.Ingress) {
	if db := ing.Spec.DefaultBackend; db != nil && db.Service != nil {
		b.link(id, EdgeRoutes, "Service", ns, db.Service.Name)
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, path := range rule.HTTP.Paths {
			if path.Backend.Service != nil {
				b.link(id, EdgeRoutes, "Service", ns, path.Backend.Service.Name)
			}
		}
	}
}

// isGatewayRoute reports whether a CR is a Gateway API *Route kind, the ones whose backends are a
// routing relationship (matching the kinds health_cr.go already recognizes).
func isGatewayRoute(u *unstructured.Unstructured) bool {
	if u.GroupVersionKind().Group != "gateway.networking.k8s.io" {
		return false
	}
	switch u.GetKind() {
	case "HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute":
		return true
	}
	return false
}

// gatewayRouteEdges links a Gateway API route to each Service it routes to (spec.rules[].backendRefs),
// the EdgeRoutes counterpart to ingressEdges. A backendRef defaults to kind Service; a non-Service
// backend has no node to point at and is skipped. backendRefs may name another namespace (allowed via a
// ReferenceGrant), so an explicit namespace overrides the route's own.
func (b *edgeBuilder) gatewayRouteEdges(id, ns string, u *unstructured.Unstructured) {
	rules, _, _ := unstructured.NestedSlice(u.Object, "spec", "rules")
	for _, ri := range rules {
		rule, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		refs, _ := rule["backendRefs"].([]any)
		for _, refi := range refs {
			ref, ok := refi.(map[string]any)
			if !ok {
				continue
			}
			name, _ := ref["name"].(string)
			if name == "" {
				continue
			}
			if k, _ := ref["kind"].(string); k != "" && k != "Service" {
				continue
			}
			toNS := ns
			if n, _ := ref["namespace"].(string); n != "" {
				toNS = n
			}
			b.link(id, EdgeRoutes, "Service", toNS, name)
		}
	}
}

// traefikIngressRouteEdges links a Traefik IngressRoute to each Kubernetes Service it routes to
// (spec.routes[].services). A service entry may instead target a TraefikService (kind: TraefikService)
// for mirroring/weighting; those are skipped here (no Service node), accepting the loss of that advanced
// chain in exchange for keeping the common plain-Service case edge-clean.
func (b *edgeBuilder) traefikIngressRouteEdges(id, ns string, u *unstructured.Unstructured) {
	routes, _, _ := unstructured.NestedSlice(u.Object, "spec", "routes")
	for _, ri := range routes {
		route, ok := ri.(map[string]any)
		if !ok {
			continue
		}
		svcs, _ := route["services"].([]any)
		for _, si := range svcs {
			s, ok := si.(map[string]any)
			if !ok {
				continue
			}
			name, _ := s["name"].(string)
			if name == "" {
				continue
			}
			if k, _ := s["kind"].(string); k != "" && k != "Service" {
				continue
			}
			b.link(id, EdgeRoutes, "Service", ns, name)
		}
	}
}

// pdbEdges links a PodDisruptionBudget to the Pods its selector guards (EdgeGuards), the counterpart to
// serviceEdges' selection — so a degraded PDB navigates to the pods that explain it. A PDB selector is a
// full LabelSelector (matchExpressions, unlike a Service's plain map), matched via the apimachinery
// helper. An EMPTY selector ({}) guards every pod in the namespace — the common "protect everything
// here" pattern, and exactly the shape of a real namespace-wide PDB — so it must link to all pods, not
// be skipped as noise (the Scheduling relationship is opt-in anyway). A nil selector matches nothing.
func (b *edgeBuilder) pdbEdges(id, ns string, pdb *policyv1.PodDisruptionBudget, nodes []Node) {
	sel, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
	if err != nil {
		return // malformed selector — LabelSelectorAsSelector already maps nil → matches-nothing
	}
	for _, n := range nodes {
		if n.Kind == "Pod" && n.Namespace == ns && sel.Matches(labels.Set(n.Labels)) {
			b.link(id, EdgeGuards, "Pod", ns, n.Name)
		}
	}
}

func (b *edgeBuilder) subjectEdges(id, bindingNS string, subjects []rbacv1.Subject) {
	for _, s := range subjects {
		if s.Kind == "ServiceAccount" {
			ns := s.Namespace
			if ns == "" {
				ns = bindingNS
			}
			b.link(id, EdgeBinds, "ServiceAccount", ns, s.Name)
		}
		// User/Group subjects are not Kubernetes objects, so they have no node to link to in v1.
	}
}

// roleRefKind/Namespace resolve a RoleBinding's roleRef target: a namespaced Role lives in the
// binding's namespace, a ClusterRole is cluster-scoped.
func roleRefKind(ref rbacv1.RoleRef) string { return ref.Kind }

func roleRefNamespace(ref rbacv1.RoleRef, bindingNS string) string {
	if ref.Kind == "ClusterRole" {
		return ""
	}
	return bindingNS
}

// labelsMatch reports whether labels satisfy every key/value in selector.
func labelsMatch(selector, labels map[string]string) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
