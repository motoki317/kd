package graph

import (
	"slices"
	"testing"
)

func kindsPresent(g *Graph) map[string]bool {
	m := map[string]bool{}
	for _, n := range g.Nodes {
		m[n.Kind] = true
	}
	return m
}

func edgeTypesPresent(g *Graph) map[EdgeType]bool {
	m := map[EdgeType]bool{}
	for _, e := range g.Edges {
		m[e.Type] = true
	}
	return m
}

func TestFilterViews(t *testing.T) {
	full := Build(decodeFixture(t, relationshipsFixture))

	t.Run("network view keeps ingress/service/pod and routes/selects edges", func(t *testing.T) {
		g := full.Filter(ViewNetwork)
		kinds := kindsPresent(g)
		for _, want := range []string{"Ingress", "Service", "Pod"} {
			if !kinds[want] {
				t.Errorf("network view missing kind %s", want)
			}
		}
		for _, unwanted := range []string{"Role", "ConfigMap", "Node"} {
			if kinds[unwanted] {
				t.Errorf("network view should not include kind %s", unwanted)
			}
		}
		et := edgeTypesPresent(g)
		if !et[EdgeRoutes] || !et[EdgeSelects] {
			t.Error("network view should keep routes and selects edges")
		}
		if et[EdgeBinds] || et[EdgeMounts] {
			t.Error("network view should drop unrelated edge types")
		}
	})

	t.Run("nodes view keeps Node/Pod and scheduledOn edges only", func(t *testing.T) {
		g := full.Filter(ViewNodes)
		kinds := kindsPresent(g)
		if !kinds["Node"] || !kinds["Pod"] {
			t.Error("nodes view should include Node and Pod")
		}
		if kinds["Service"] || kinds["Ingress"] {
			t.Error("nodes view should not include Service/Ingress")
		}
		if et := edgeTypesPresent(g); !et[EdgeScheduledOn] || len(et) != 1 {
			t.Errorf("nodes view edges = %v, want only scheduledOn", et)
		}
	})

	t.Run("rbac view keeps role/binding/serviceaccount and binds edges", func(t *testing.T) {
		g := full.Filter(ViewRBAC)
		kinds := kindsPresent(g)
		for _, want := range []string{"Role", "RoleBinding", "ServiceAccount"} {
			if !kinds[want] {
				t.Errorf("rbac view missing kind %s", want)
			}
		}
		if et := edgeTypesPresent(g); !et[EdgeBinds] || len(et) != 1 {
			t.Errorf("rbac view edges = %v, want only binds", et)
		}
	})

	t.Run("volumes view keeps mounting pods and their mounted volumes via mounts edges", func(t *testing.T) {
		g := full.Filter(ViewVolumes)
		if et := edgeTypesPresent(g); !et[EdgeMounts] || len(et) != 1 {
			t.Errorf("volumes view edges = %v, want only mounts", et)
		}
		kinds := kindsPresent(g)
		if !kinds["Pod"] {
			t.Error("volumes view should include the mounting Pod")
		}
		if !kinds["ConfigMap"] && !kinds["Secret"] && !kinds["PersistentVolumeClaim"] {
			t.Error("volumes view should include a mounted ConfigMap/Secret/PVC")
		}
		for _, unwanted := range []string{"Service", "Ingress", "Node", "Role"} {
			if kinds[unwanted] {
				t.Errorf("volumes view should not include %s", unwanted)
			}
		}
	})

	t.Run("all view is unchanged", func(t *testing.T) {
		g := full.Filter(ViewAll)
		if len(g.Nodes) != len(full.Nodes) || len(g.Edges) != len(full.Edges) {
			t.Errorf("all view changed sizes: nodes %d/%d edges %d/%d",
				len(g.Nodes), len(full.Nodes), len(g.Edges), len(full.Edges))
		}
	})

	t.Run("ownership view keeps workloads and owner edges", func(t *testing.T) {
		g := Build(decodeFixture(t, ownershipFixture)).Filter(ViewOwnership)
		if et := edgeTypesPresent(g); !et[EdgeOwner] || len(et) != 1 {
			t.Errorf("ownership view edges = %v, want only ownerReference", et)
		}
		if k := kindsPresent(g); !k["Deployment"] || !k["ReplicaSet"] || !k["Pod"] {
			t.Error("ownership view should include the workload tree kinds")
		}
	})
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

func TestParseView(t *testing.T) {
	tests := map[string]View{
		"":          ViewOwnership, // default
		"ownership": ViewOwnership,
		"network":   ViewNetwork,
		"nodes":     ViewNodes,
		"rbac":      ViewRBAC,
		"volumes":   ViewVolumes,
		"all":       ViewAll,
		"bogus":     ViewOwnership, // unknown falls back to default
	}
	for in, want := range tests {
		if got := ParseView(in); got != want {
			t.Errorf("ParseView(%q) = %q, want %q", in, got, want)
		}
	}
}
