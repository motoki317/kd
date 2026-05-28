package graph

import (
	"slices"

	"k8s.io/apimachinery/pkg/runtime"
)

// severity orders health from most to least attention-worthy, for rolling many resources up into
// a single namespace indicator.
var severity = map[Health]int{
	HealthDegraded:    4,
	HealthProgressing: 3,
	HealthUnknown:     2,
	HealthSuspended:   1,
	HealthHealthy:     0,
}

// Summary rolls a namespace up to its worst resource health plus how many resources are not Healthy,
// so the sidebar can both flag trouble (the dot color) and convey its scale (the count).
type Summary struct {
	Health   Health
	NonReady int // resources whose health != Healthy (the count behind the dot)
}

// Summarize rolls a namespace snapshot up to its worst resource health and non-ready count, so the
// UI can show cluster state at a glance without opening each namespace. It rolls up the built graph's
// node health (not raw per-object health) so the sidebar agrees with the topology — including
// graph-derived signals like a Service with no ready endpoints. Build already drops historical noise,
// so an empty namespace reports Healthy with a zero count.
func Summarize(objs []runtime.Object) Summary {
	return summarize(objs, false)
}

// SummarizeCluster is the cluster pseudo-namespace counterpart of Summarize: rolls up only the
// cluster-scoped resources in the snapshot, so the sidebar's [cluster] entry can flag Node /
// PV / cluster-CR trouble at a glance. Namespaced ride-along objects are ignored — they
// belong to a namespace's health, not the cluster's.
func SummarizeCluster(objs []runtime.Object) Summary {
	return summarize(objs, true)
}

func summarize(objs []runtime.Object, clusterScope bool) Summary {
	g := Build(objs)
	s := Summary{Health: HealthHealthy}
	for _, n := range g.Nodes {
		// Per-namespace rollup skips cluster-scoped ride-along (a cordoned Node would otherwise
		// flag every namespace that's scheduled on it). The cluster rollup is the inverse — only
		// cluster-scoped objects.
		if clusterScope != (n.Namespace == "") {
			continue
		}
		if n.Health != HealthHealthy {
			s.NonReady++
		}
		if severity[n.Health] > severity[s.Health] {
			s.Health = n.Health
		}
	}
	return s
}

// DescendantPodNames returns the names of every Pod reachable from the node with the given id by
// following ownerReference edges downward — or just that pod's name if the id is itself a Pod. It
// lets the API aggregate logs for a workload across all the pods it ultimately owns (Deployment →
// ReplicaSet → Pod, CronJob → Job → Pod, ...). Historical pods are absent because Build drops them.
func (g *Graph) DescendantPodNames(id string) []string {
	children := map[string][]string{}
	for _, e := range g.Edges {
		if e.Type == EdgeOwner {
			children[e.From] = append(children[e.From], e.To)
		}
	}
	kind := make(map[string]string, len(g.Nodes))
	name := make(map[string]string, len(g.Nodes))
	for _, n := range g.Nodes {
		kind[n.ID], name[n.ID] = n.Kind, n.Name
	}

	var pods []string
	seen := map[string]bool{}
	var walk func(string)
	walk = func(cur string) {
		if seen[cur] {
			return // ownerReferences are a DAG in practice, but guard against cycles regardless
		}
		seen[cur] = true
		if kind[cur] == "Pod" {
			pods = append(pods, name[cur])
		}
		for _, c := range children[cur] {
			walk(c)
		}
	}
	walk(id)
	slices.Sort(pods)
	return pods
}

// NodeID returns the id of the node with the given kind and name, or "" if none — a small helper for
// API handlers resolving a {kind}/{name} request path to a graph node.
func (g *Graph) NodeID(kind, name string) string {
	for _, n := range g.Nodes {
		if n.Kind == kind && n.Name == name {
			return n.ID
		}
	}
	return ""
}

// DescendantIDs returns the given node's id plus every node reachable from it through
// ownerReference edges (the whole subtree). Used to aggregate a controller's events across its
// ReplicaSets and Pods, where the actionable events (scheduling, image pull) actually land.
func (g *Graph) DescendantIDs(id string) []string {
	children := map[string][]string{}
	for _, e := range g.Edges {
		if e.Type == EdgeOwner {
			children[e.From] = append(children[e.From], e.To)
		}
	}
	var out []string
	seen := map[string]bool{}
	var walk func(string)
	walk = func(cur string) {
		if seen[cur] {
			return
		}
		seen[cur] = true
		out = append(out, cur)
		for _, c := range children[cur] {
			walk(c)
		}
	}
	walk(id)
	slices.Sort(out)
	return out
}

// View is a named projection of the full graph onto one relationship dimension, so the UI
// can switch between the ownership tree, node placement, network, and RBAC without the server
// building a different graph. See docs/ADR/20260527-resource-relationship-graph.md.
type View string

const (
	ViewAll       View = "all"
	ViewOwnership View = "ownership" // default: the parent-child workload tree
	ViewNodes     View = "nodes"     // Pod placement on Nodes
	ViewNetwork   View = "network"   // Ingress -> Service -> Pod
	ViewRBAC      View = "rbac"      // bindings -> roles and subjects
	ViewVolumes   View = "volumes"   // Pod -> mounted ConfigMaps/Secrets/PVCs
)

// viewSpec defines a view: which edge types to keep and which kinds to always show even when
// unconnected (so e.g. a Service with no endpoints still appears in the network view).
type viewSpec struct {
	edges       []EdgeType
	alwaysKinds []string
}

var viewSpecs = map[View]viewSpec{
	ViewOwnership: {
		edges:       []EdgeType{EdgeOwner},
		alwaysKinds: []string{"Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"},
	},
	ViewNodes: {
		edges:       []EdgeType{EdgeScheduledOn},
		alwaysKinds: []string{"Node", "Pod"},
	},
	ViewNetwork: {
		edges:       []EdgeType{EdgeRoutes, EdgeSelects},
		alwaysKinds: []string{"Ingress", "Service", "Pod"},
	},
	ViewRBAC: {
		edges:       []EdgeType{EdgeBinds},
		alwaysKinds: []string{"Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding", "ServiceAccount"},
	},
	// No alwaysKinds: only pods that actually mount something (and the volumes they mount) appear,
	// so the view stays about real dependencies rather than every pod and every config object.
	ViewVolumes: {
		edges: []EdgeType{EdgeMounts},
	},
}

// ParseView maps a query parameter to a View, defaulting to the ownership view.
func ParseView(s string) View {
	switch View(s) {
	case ViewAll, ViewOwnership, ViewNodes, ViewNetwork, ViewRBAC, ViewVolumes:
		return View(s)
	default:
		return ViewOwnership
	}
}

// Filter returns a new graph projected onto the given view. A node is kept when its kind is
// one the view always shows or when it is an endpoint of a kept edge.
func (g *Graph) Filter(v View) *Graph {
	if v == ViewAll {
		return &Graph{Nodes: slices.Clone(g.Nodes), Edges: slices.Clone(g.Edges)}
	}
	spec := viewSpecs[v]

	edges := make([]Edge, 0, len(g.Edges))
	connected := map[string]bool{}
	for _, e := range g.Edges {
		if slices.Contains(spec.edges, e.Type) {
			edges = append(edges, e)
			connected[e.From] = true
			connected[e.To] = true
		}
	}

	nodes := make([]Node, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		if connected[n.ID] || slices.Contains(spec.alwaysKinds, n.Kind) {
			nodes = append(nodes, n)
		}
	}
	return &Graph{Nodes: nodes, Edges: edges}
}
