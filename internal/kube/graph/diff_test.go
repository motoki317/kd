package graph

import (
	"slices"
	"testing"
)

func TestDiff(t *testing.T) {
	prev := &Graph{
		Nodes: []Node{
			{ID: "a", Kind: "Pod", Name: "a", Health: HealthHealthy},
			{ID: "b", Kind: "Pod", Name: "b", Health: HealthHealthy},
		},
		Edges: []Edge{
			{From: "a", To: "b", Type: EdgeOwner},
		},
	}
	next := &Graph{
		Nodes: []Node{
			{ID: "a", Kind: "Pod", Name: "a", Health: HealthDegraded}, // changed health
			{ID: "c", Kind: "Pod", Name: "c", Health: HealthHealthy},  // added; b removed
		},
		Edges: []Edge{
			{From: "a", To: "c", Type: EdgeOwner}, // added; a->b removed
		},
	}

	p := Diff(prev, next)

	upsertIDs := func() []string {
		var ids []string
		for _, n := range p.UpsertNodes {
			ids = append(ids, n.ID)
		}
		slices.Sort(ids)
		return ids
	}()
	if want := []string{"a", "c"}; !slices.Equal(upsertIDs, want) {
		t.Errorf("upsert node ids = %v, want %v (a changed, c added)", upsertIDs, want)
	}
	if !slices.Equal(p.RemoveNodeIDs, []string{"b"}) {
		t.Errorf("remove node ids = %v, want [b]", p.RemoveNodeIDs)
	}
	if len(p.UpsertEdges) != 1 || p.UpsertEdges[0].To != "c" {
		t.Errorf("upsert edges = %v, want [a->c]", p.UpsertEdges)
	}
	if len(p.RemoveEdges) != 1 || p.RemoveEdges[0].To != "b" {
		t.Errorf("remove edges = %v, want [a->b]", p.RemoveEdges)
	}
}

func TestDiffEmptyWhenUnchanged(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture))
	if p := Diff(g, g); !p.Empty() {
		t.Errorf("diff of identical graphs should be empty, got %+v", p)
	}
}

// nodeEqual drives change detection: a material field changing must make two nodes unequal so the SSE
// diff emits an upsert and the client repaints. Every field added to the Node (a recurring source of
// "I forgot to add it to nodeEqual") is exercised here so an omission fails loudly rather than silently
// dropping live updates. A handful of static/cosmetic fields are deliberately ignored — asserted too,
// so the exclusion stays a conscious choice.
func TestNodeEqualDetectsFieldChanges(t *testing.T) {
	base := Node{
		ID: "id", Kind: "Pod", APIVersion: "v1", Namespace: "ns", Name: "n",
		Health: HealthHealthy, Status: "Running", Restarts: 1, Host: "node-1",
		Capacity: "16 vCPU", ClusterIP: "10.0.0.1", ExternalIP: "pending", Ports: []string{"80/TCP"},
		Routes: []string{"h/p → s:80"}, Rules: []string{"pods: get"}, RoleRef: "Role/r",
		Subjects: []string{"User: a"}, Containers: []string{"app"}, Images: []string{"img:1"},
		CreatedAt: "2026-01-01T00:00:00Z", Labels: map[string]string{"app": "x"}, OwnerUIDs: []string{"o"},
		ContainerStatuses: []ContainerStatus{{Name: "app", Ready: true, State: "Running"}},
		Endpoints:         &Endpoints{Ready: 1, Total: 2},
	}
	if !nodeEqual(base, base) {
		t.Fatal("a node must equal itself")
	}

	// Each mutation reassigns one field (never mutates a shared slice/map/pointer in place).
	changed := []struct {
		field string
		mut   func(n *Node)
	}{
		{"ID", func(n *Node) { n.ID = "id2" }},
		{"Kind", func(n *Node) { n.Kind = "Service" }},
		{"APIVersion", func(n *Node) { n.APIVersion = "apps/v1" }},
		{"Namespace", func(n *Node) { n.Namespace = "ns2" }},
		{"Name", func(n *Node) { n.Name = "n2" }},
		{"Health", func(n *Node) { n.Health = HealthDegraded }},
		{"Status", func(n *Node) { n.Status = "CrashLoopBackOff" }},
		{"Restarts", func(n *Node) { n.Restarts = 2 }},
		{"Host", func(n *Node) { n.Host = "node-2" }},
		{"ClusterIP", func(n *Node) { n.ClusterIP = "10.0.0.2" }},
		{"ExternalIP", func(n *Node) { n.ExternalIP = "203.0.113.7" }},
		{"Ports", func(n *Node) { n.Ports = []string{"443/TCP"} }},
		{"Routes", func(n *Node) { n.Routes = []string{"h/p → s:443"} }},
		{"Rules", func(n *Node) { n.Rules = []string{"pods: list"} }},
		{"RoleRef", func(n *Node) { n.RoleRef = "ClusterRole/admin" }},
		{"Subjects", func(n *Node) { n.Subjects = []string{"Group: b"} }},
		{"Images", func(n *Node) { n.Images = []string{"img:2"} }},
		{"ContainerStatuses", func(n *Node) {
			n.ContainerStatuses = []ContainerStatus{{Name: "app", Ready: false, State: "Waiting: CrashLoopBackOff"}}
		}},
		{"Endpoints", func(n *Node) { n.Endpoints = &Endpoints{Ready: 2, Total: 2} }},
		{"Labels", func(n *Node) { n.Labels = map[string]string{"app": "y"} }},
		{"OwnerUIDs", func(n *Node) { n.OwnerUIDs = []string{"o2"} }},
	}
	for _, tc := range changed {
		n := base
		tc.mut(&n)
		if nodeEqual(base, n) {
			t.Errorf("nodeEqual ignored a change to %s — live updates to it would not repaint", tc.field)
		}
	}

	// Static/cosmetic fields are intentionally excluded (they never change for a live object, so a
	// repaint would be wasted churn): changing them must keep the nodes equal.
	ignored := []struct {
		field string
		mut   func(n *Node)
	}{
		{"CreatedAt", func(n *Node) { n.CreatedAt = "2030-01-01T00:00:00Z" }},
		{"Capacity", func(n *Node) { n.Capacity = "8 vCPU" }},
		{"Containers", func(n *Node) { n.Containers = []string{"app", "sidecar"} }},
	}
	for _, tc := range ignored {
		n := base
		tc.mut(&n)
		if !nodeEqual(base, n) {
			t.Errorf("nodeEqual now reacts to %s — if intentional, update this test; else revert", tc.field)
		}
	}
}
