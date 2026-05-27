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
