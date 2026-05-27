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
