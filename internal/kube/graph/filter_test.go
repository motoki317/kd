package graph

import (
	"slices"
	"testing"
)

// SummarizeBuilt is the cycle-201 entry point used by the SSE handler so the same unfiltered
// graph powers both the filtered view payload and the namespace summary (no double Build). Pin
// behavior so future refactors can't quietly drop the parity with Summarize.
func TestSummarizeBuiltMatchesSummarize(t *testing.T) {
	objs := decodeFixture(t, `
apiVersion: v1
kind: Pod
metadata:
  name: ok
  namespace: shop
  uid: ok-uid
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Pod
metadata:
  name: crashing
  namespace: shop
  uid: crash-uid
status:
  phase: Running
  containerStatuses:
    - state:
        waiting:
          reason: CrashLoopBackOff
`)
	want := Summarize(objs)
	if got := SummarizeBuilt(Build(objs), false); got != want {
		t.Errorf("SummarizeBuilt = %+v, want %+v (must match Summarize)", got, want)
	}
}

func TestSummarizeWorstHealth(t *testing.T) {
	// A crashing pod dominates a namespace of otherwise-healthy resources.
	degraded := decodeFixture(t, `
apiVersion: v1
kind: Pod
metadata:
  name: ok
  namespace: shop
  uid: ok-uid
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Pod
metadata:
  name: crashing
  namespace: shop
  uid: crash-uid
status:
  phase: Running
  containerStatuses:
    - state:
        waiting:
          reason: CrashLoopBackOff
`)
	if got := Summarize(degraded); got.Health != HealthDegraded {
		t.Errorf("Summarize health = %q, want Degraded", got.Health)
	}
	// Only the crashing pod is non-healthy; the ready pod must not be counted.
	if got := Summarize(degraded); got.NonReady != 1 {
		t.Errorf("Summarize NonReady = %d, want 1", got.NonReady)
	}

	// The superseded fixture's only non-historical workloads are a ready Deployment, its live
	// ReplicaSet, and a running pod — all healthy — so it summarizes Healthy (the dropped old
	// ReplicaSets must not affect the roll-up).
	if got := Summarize(decodeFixture(t, supersededRSFixture)); got.Health != HealthHealthy || got.NonReady != 0 {
		t.Errorf("Summarize(superseded) = %+v, want Healthy/0", got)
	}

	// A lone pending pod rolls up to Progressing.
	progressing := decodeFixture(t, `
apiVersion: v1
kind: Pod
metadata:
  name: starting
  namespace: shop
  uid: starting-uid
status:
  phase: Pending
`)
	if got := Summarize(progressing); got.Health != HealthProgressing || got.NonReady != 1 {
		t.Errorf("Summarize(pending) = %+v, want Progressing/1", got)
	}
}

// TestSummarizeIgnoresUnknown pins the rule that Unknown resources (unclassifiable custom
// resources) are noise an operator can't act on, so they affect neither the actionable "not
// ready" count NOR the dot color — a namespace reads by its actionable resources alone.
func TestSummarizeIgnoresUnknown(t *testing.T) {
	// A namespace mixing one real problem with Unknown noise: the count reflects only the
	// actionable Degraded resource, and the color is Degraded (Unknown doesn't change either).
	mixed := &Graph{Nodes: []Node{
		{Namespace: "shop", Health: HealthHealthy},
		{Namespace: "shop", Health: HealthDegraded},
		{Namespace: "shop", Health: HealthUnknown},
		{Namespace: "shop", Health: HealthUnknown},
	}}
	if got := SummarizeBuilt(mixed, false); got.NonReady != 1 || got.Health != HealthDegraded {
		t.Errorf("SummarizeBuilt(mixed) = %+v, want Degraded/1", got)
	}

	// Healthy + Unknown reads as Healthy/0: the Unknown resource doesn't drag an otherwise-fine
	// namespace to a misleading gray.
	withUnknown := &Graph{Nodes: []Node{
		{Namespace: "shop", Health: HealthHealthy},
		{Namespace: "shop", Health: HealthUnknown},
	}}
	if got := SummarizeBuilt(withUnknown, false); got.NonReady != 0 || got.Health != HealthHealthy {
		t.Errorf("SummarizeBuilt(withUnknown) = %+v, want Healthy/0", got)
	}
}

// Every namespace's snapshot carries the cluster-scoped Nodes (for placement edges), so a single
// unhealthy Node — cordoned (Suspended) or NotReady (Degraded) — must not roll into a per-namespace
// indicator and make every namespace look troubled over one cluster-level event. Nodes surface in
// the Nodes view, not the sidebar dot.
func TestSummarizeIgnoresClusterScopedNodes(t *testing.T) {
	objs := decodeFixture(t, `
apiVersion: v1
kind: Pod
metadata:
  name: ok
  namespace: shop
  uid: ok-uid
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Node
metadata:
  name: worker-1
  uid: node-uid
status:
  conditions:
    - type: Ready
      status: "False"
`)
	if got := Summarize(objs); got.Health != HealthHealthy || got.NonReady != 0 {
		t.Errorf("Summarize with an unhealthy cluster-scoped Node = %+v, want Healthy/0", got)
	}
}

func TestDescendantPodNames(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture)) // Deployment(dep-uid) -> RS(rs-uid) -> 2 pods
	bothPods := []string{"web-abc-1", "web-abc-2"}

	tests := map[string][]string{
		"dep-uid":    bothPods,      // Deployment aggregates every pod under its ReplicaSets
		"rs-uid":     bothPods,      // ReplicaSet aggregates its own pods
		"pod1-uid":   {"web-abc-1"}, // a Pod resolves to just itself
		"absent-uid": nil,           // unknown node owns nothing
	}
	for id, want := range tests {
		if got := g.DescendantPodNames(id); !slices.Equal(got, want) {
			t.Errorf("DescendantPodNames(%q) = %v, want %v", id, got, want)
		}
	}
}

// DescendantIDs (used by the events handler to aggregate a controller's events across its whole
// subtree) returns the node itself plus every owner-edge-reachable descendant, sorted. Distinct from
// DescendantPodNames: it yields the controllers/ReplicaSets too, by id, not just leaf pod names.
func TestDescendantIDs(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture)) // Deployment(dep-uid) -> RS(rs-uid) -> 2 pods

	tests := map[string][]string{
		"dep-uid":    {"dep-uid", "pod1-uid", "pod2-uid", "rs-uid"}, // whole subtree, sorted
		"rs-uid":     {"pod1-uid", "pod2-uid", "rs-uid"},            // the ReplicaSet down
		"pod1-uid":   {"pod1-uid"},                                  // a leaf is just itself
		"absent-uid": {"absent-uid"},                                // unknown id seeds the walk, owns nothing
	}
	for id, want := range tests {
		if got := g.DescendantIDs(id); !slices.Equal(got, want) {
			t.Errorf("DescendantIDs(%q) = %v, want %v", id, got, want)
		}
	}
}

// A pathological ownership cycle (real ownerReferences can't form one, but the walk must not loop
// forever if the graph is ever malformed) terminates and reports each node exactly once.
func TestDescendantIDsCycleGuard(t *testing.T) {
	g := &Graph{
		Nodes: []Node{{ID: "a"}, {ID: "b"}},
		Edges: []Edge{
			{From: "a", To: "b", Type: EdgeOwner},
			{From: "b", To: "a", Type: EdgeOwner},
		},
	}
	if got := g.DescendantIDs("a"); !slices.Equal(got, []string{"a", "b"}) {
		t.Errorf("DescendantIDs over a cycle = %v, want [a b] once each", got)
	}
}

// NodeID resolves an API handler's {kind}/{name} path to a graph node id, matching BOTH kind and
// name (a Pod and a Service of the same name must not collide), and returns "" when absent.
func TestNodeID(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture))
	if got := g.NodeID("Pod", "web-abc-1"); got != "pod1-uid" {
		t.Errorf("NodeID(Pod, web-abc-1) = %q, want pod1-uid", got)
	}
	if got := g.NodeID("Service", "web"); got != "" {
		t.Errorf("NodeID(Service, web) = %q, want \"\" (kind must match, not just name)", got)
	}
}
