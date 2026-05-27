package graph

import (
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/scheme"
)

// decodeFixture parses a multi-document YAML string into typed Kubernetes objects.
func decodeFixture(t *testing.T, yaml string) []runtime.Object {
	t.Helper()
	decode := scheme.Codecs.UniversalDeserializer().Decode
	var objs []runtime.Object
	for _, doc := range strings.Split(yaml, "\n---\n") {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		obj, _, err := decode([]byte(doc), nil, nil)
		if err != nil {
			t.Fatalf("decode fixture: %v\n%s", err, doc)
		}
		objs = append(objs, obj)
	}
	return objs
}

// nodeByName finds a node by kind+name for assertions.
func nodeByName(g *Graph, kind, name string) *Node {
	for i := range g.Nodes {
		if g.Nodes[i].Kind == kind && g.Nodes[i].Name == name {
			return &g.Nodes[i]
		}
	}
	return nil
}

// hasEdge reports whether an edge of the given type connects the named nodes.
func hasEdge(g *Graph, typ EdgeType, fromKind, fromName, toKind, toName string) bool {
	from := nodeByName(g, fromKind, fromName)
	to := nodeByName(g, toKind, toName)
	if from == nil || to == nil {
		return false
	}
	for _, e := range g.Edges {
		if e.Type == typ && e.From == from.ID && e.To == to.ID {
			return true
		}
	}
	return false
}

const ownershipFixture = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  uid: dep-uid
spec:
  replicas: 2
status:
  replicas: 2
  readyReplicas: 2
  availableReplicas: 2
  updatedReplicas: 2
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-abc
  namespace: shop
  uid: rs-uid
  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: web
      uid: dep-uid
      controller: true
---
apiVersion: v1
kind: Pod
metadata:
  name: web-abc-1
  namespace: shop
  uid: pod1-uid
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-abc
      uid: rs-uid
      controller: true
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Pod
metadata:
  name: web-abc-2
  namespace: shop
  uid: pod2-uid
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-abc
      uid: rs-uid
      controller: true
status:
  phase: Pending
`

func TestBuildOwnershipTree(t *testing.T) {
	g := Build(decodeFixture(t, ownershipFixture))

	if len(g.Nodes) != 4 {
		t.Fatalf("nodes = %d, want 4", len(g.Nodes))
	}

	// ownerReference edges form the Deployment -> ReplicaSet -> Pod tree.
	if !hasEdge(g, EdgeOwner, "Deployment", "web", "ReplicaSet", "web-abc") {
		t.Error("missing Deployment -> ReplicaSet owner edge")
	}
	if !hasEdge(g, EdgeOwner, "ReplicaSet", "web-abc", "Pod", "web-abc-1") {
		t.Error("missing ReplicaSet -> Pod owner edge (pod1)")
	}
	if !hasEdge(g, EdgeOwner, "ReplicaSet", "web-abc", "Pod", "web-abc-2") {
		t.Error("missing ReplicaSet -> Pod owner edge (pod2)")
	}

	// Node identity and metadata.
	pod1 := nodeByName(g, "Pod", "web-abc-1")
	if pod1 == nil {
		t.Fatal("pod1 node missing")
	}
	if pod1.ID != "pod1-uid" {
		t.Errorf("pod1 ID = %q, want pod1-uid", pod1.ID)
	}
	if pod1.Namespace != "shop" {
		t.Errorf("pod1 namespace = %q, want shop", pod1.Namespace)
	}

	// Health: ready pod is Healthy, pending pod is Progressing, fully-available deployment is Healthy.
	if pod1.Health != HealthHealthy {
		t.Errorf("ready pod health = %q, want Healthy", pod1.Health)
	}
	if pod2 := nodeByName(g, "Pod", "web-abc-2"); pod2 == nil || pod2.Health != HealthProgressing {
		t.Errorf("pending pod health = %v, want Progressing", pod2)
	}
	if dep := nodeByName(g, "Deployment", "web"); dep == nil || dep.Health != HealthHealthy {
		t.Errorf("available deployment health = %v, want Healthy", dep)
	}
}

// supersededRSFixture is a Deployment with one live ReplicaSet (1 pod) and two old revisions
// scaled to zero — the noise that dominates real namespaces.
const supersededRSFixture = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  uid: dep-uid
spec:
  replicas: 1
status:
  replicas: 1
  readyReplicas: 1
  updatedReplicas: 1
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-live
  namespace: shop
  uid: rs-live
  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: web
      uid: dep-uid
      controller: true
spec:
  replicas: 1
status:
  replicas: 1
  readyReplicas: 1
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-old-1
  namespace: shop
  uid: rs-old-1
  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: web
      uid: dep-uid
      controller: true
spec:
  replicas: 0
status:
  replicas: 0
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: web-old-2
  namespace: shop
  uid: rs-old-2
  ownerReferences:
    - apiVersion: apps/v1
      kind: Deployment
      name: web
      uid: dep-uid
      controller: true
spec:
  replicas: 0
status:
  replicas: 0
---
apiVersion: v1
kind: Pod
metadata:
  name: web-live-1
  namespace: shop
  uid: pod-uid
  ownerReferences:
    - apiVersion: apps/v1
      kind: ReplicaSet
      name: web-live
      uid: rs-live
      controller: true
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
`

func TestBuildDropsSupersededReplicaSets(t *testing.T) {
	g := Build(decodeFixture(t, supersededRSFixture))

	// The two zero-replica old revisions are gone; the live RS and its pod remain.
	for _, name := range []string{"web-old-1", "web-old-2"} {
		if nodeByName(g, "ReplicaSet", name) != nil {
			t.Errorf("superseded ReplicaSet %q should be dropped", name)
		}
	}
	if nodeByName(g, "ReplicaSet", "web-live") == nil {
		t.Error("live ReplicaSet should be kept")
	}
	if nodeByName(g, "Pod", "web-live-1") == nil {
		t.Error("live pod should be kept")
	}
	// Deployment -> live RS -> Pod tree stays intact; no edges dangle to dropped nodes.
	if !hasEdge(g, EdgeOwner, "Deployment", "web", "ReplicaSet", "web-live") {
		t.Error("missing Deployment -> live ReplicaSet edge")
	}
	if got := len(g.Nodes); got != 3 {
		t.Errorf("nodes = %d, want 3 (Deployment, live RS, Pod)", got)
	}
}

// completedPodsFixture has a finished controller-owned pod (a workflow/job leftover), a failed
// controller-owned pod, and a bare succeeded pod with no owner.
const completedPodsFixture = `
apiVersion: v1
kind: Pod
metadata:
  name: wf-done
  namespace: shop
  uid: pod-done
  ownerReferences:
    - apiVersion: argoproj.io/v1alpha1
      kind: Workflow
      name: wf
      uid: wf-uid
      controller: true
status:
  phase: Succeeded
---
apiVersion: v1
kind: Pod
metadata:
  name: wf-failed
  namespace: shop
  uid: pod-failed
  ownerReferences:
    - apiVersion: batch/v1
      kind: Job
      name: j
      uid: job-uid
      controller: true
status:
  phase: Failed
---
apiVersion: v1
kind: Pod
metadata:
  name: manual-done
  namespace: shop
  uid: pod-manual
status:
  phase: Succeeded
`

func TestBuildDropsFinishedControllerPods(t *testing.T) {
	g := Build(decodeFixture(t, completedPodsFixture))

	if nodeByName(g, "Pod", "wf-done") != nil {
		t.Error("finished controller-owned pod should be dropped")
	}
	if nodeByName(g, "Pod", "wf-failed") == nil {
		t.Error("failed pod should be kept (it is actionable)")
	}
	if nodeByName(g, "Pod", "manual-done") == nil {
		t.Error("ownerless succeeded pod should be kept")
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	objs := decodeFixture(t, ownershipFixture)
	g1, g2 := Build(objs), Build(objs)
	if len(g1.Nodes) != len(g2.Nodes) || len(g1.Edges) != len(g2.Edges) {
		t.Fatal("graph sizes differ between builds")
	}
	for i := range g1.Nodes {
		if g1.Nodes[i].ID != g2.Nodes[i].ID {
			t.Errorf("node order differs at %d: %q vs %q", i, g1.Nodes[i].ID, g2.Nodes[i].ID)
		}
	}
	for i := range g1.Edges {
		if g1.Edges[i] != g2.Edges[i] {
			t.Errorf("edge order differs at %d", i)
		}
	}
}
