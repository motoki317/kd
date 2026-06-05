package graph

import (
	"maps"
	"slices"
)

// Patch is the incremental change between two graphs, sent over the SSE watch feed so the
// client mutates its store instead of replacing it. See docs/ADR/20260527-realtime-transport-sse.md.
type Patch struct {
	UpsertNodes   []Node   `json:"upsertNodes,omitempty"`
	RemoveNodeIDs []string `json:"removeNodeIds,omitempty"`
	UpsertEdges   []Edge   `json:"upsertEdges,omitempty"`
	RemoveEdges   []Edge   `json:"removeEdges,omitempty"`
}

// Empty reports whether the patch carries no changes.
func (p Patch) Empty() bool {
	return len(p.UpsertNodes) == 0 && len(p.RemoveNodeIDs) == 0 &&
		len(p.UpsertEdges) == 0 && len(p.RemoveEdges) == 0
}

// Diff computes the changes needed to turn prev into next: nodes added or changed are upserts,
// nodes gone are removals, and edges (whose identity is from/to/type) are added or removed.
// Output is deterministic (sorted), matching the builder's ordering.
func Diff(prev, next *Graph) Patch {
	var p Patch

	prevNodes := make(map[string]Node, len(prev.Nodes))
	for _, n := range prev.Nodes {
		prevNodes[n.ID] = n
	}
	nextIDs := make(map[string]bool, len(next.Nodes))
	for _, n := range next.Nodes {
		nextIDs[n.ID] = true
		if old, ok := prevNodes[n.ID]; !ok || !nodeEqual(old, n) {
			p.UpsertNodes = append(p.UpsertNodes, n)
		}
	}
	for _, n := range prev.Nodes {
		if !nextIDs[n.ID] {
			p.RemoveNodeIDs = append(p.RemoveNodeIDs, n.ID)
		}
	}

	prevEdges := make(map[Edge]bool, len(prev.Edges))
	for _, e := range prev.Edges {
		prevEdges[e] = true
	}
	nextEdges := make(map[Edge]bool, len(next.Edges))
	for _, e := range next.Edges {
		nextEdges[e] = true
		if !prevEdges[e] {
			p.UpsertEdges = append(p.UpsertEdges, e)
		}
	}
	for _, e := range prev.Edges {
		if !nextEdges[e] {
			p.RemoveEdges = append(p.RemoveEdges, e)
		}
	}

	slices.Sort(p.RemoveNodeIDs)
	return p
}

// nodeEqual compares two nodes for material equality (drives change detection).
func nodeEqual(a, b Node) bool {
	return a.ID == b.ID &&
		a.Kind == b.Kind &&
		a.APIVersion == b.APIVersion &&
		a.Namespace == b.Namespace &&
		a.Name == b.Name &&
		a.Health == b.Health &&
		a.Status == b.Status &&
		a.Message == b.Message && // a failure reason appearing/changing must repaint the drawer
		a.Restarts == b.Restarts &&
		a.Host == b.Host &&
		a.ClusterIP == b.ClusterIP && // "" → IP once assigned must repaint
		a.ExternalIP == b.ExternalIP && // a LoadBalancer's "pending" → assigned address must repaint
		slices.Equal(a.Ports, b.Ports) && // a Service port edit must repaint
		slices.Equal(a.Routes, b.Routes) && // an Ingress rule edit must repaint
		slices.Equal(a.Rules, b.Rules) && // a Role rule edit must repaint
		a.RoleRef == b.RoleRef &&
		slices.Equal(a.Subjects, b.Subjects) && // a binding's subject edit must repaint
		slices.Equal(a.DataKeys, b.DataKeys) && // a ConfigMap/Secret key add/remove/resize must repaint
		a.SecretType == b.SecretType &&
		a.AccessModes == b.AccessModes && // a PVC binding to a PV can fill in its modes/class — repaint
		a.StorageClass == b.StorageClass &&
		endpointsEqual(a.Endpoints, b.Endpoints) && // backends becoming ready/scaling must repaint
		slices.Equal(a.OwnerUIDs, b.OwnerUIDs) &&
		slices.Equal(a.Images, b.Images) && // an in-place image rollout must repaint the node
		slices.Equal(a.ContainerStatuses, b.ContainerStatuses) && // readiness/restart/state changes
		maps.Equal(a.Labels, b.Labels)
}

// endpointsEqual compares two endpoint summaries, treating nil (not selector-based) as distinct from
// a zero count (selector matches nothing).
func endpointsEqual(a, b *Endpoints) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
