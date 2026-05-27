package graph

import "testing"

// A selector-based Service reports how many of the pods it selects are Ready; a selectorless Service
// (manual/external endpoints) reports nothing; a selector that matches no pod reports 0/0 — the
// "nothing is serving this" signal.
func TestServiceEndpointReadiness(t *testing.T) {
	const fixture = `
apiVersion: v1
kind: Pod
metadata:
  name: web-ready
  namespace: shop
  uid: p1
  labels:
    app: web
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Pod
metadata:
  name: web-starting
  namespace: shop
  uid: p2
  labels:
    app: web
status:
  phase: Running
  conditions:
    - type: Ready
      status: "False"
---
apiVersion: v1
kind: Pod
metadata:
  name: other
  namespace: shop
  uid: p3
  labels:
    app: db
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: shop
  uid: svc1
spec:
  selector:
    app: web
---
apiVersion: v1
kind: Service
metadata:
  name: managed-svc
  namespace: shop
  uid: svc2
spec: {}
---
apiVersion: v1
kind: Service
metadata:
  name: orphan-svc
  namespace: shop
  uid: svc3
spec:
  selector:
    app: ghost
`
	g := Build(decodeFixture(t, fixture))

	if ep := nodeByName(g, "Service", "web-svc").Endpoints; ep == nil {
		t.Error("web-svc: expected endpoints, got nil")
	} else if ep.Ready != 1 || ep.Total != 2 {
		t.Errorf("web-svc endpoints = %d/%d, want 1/2", ep.Ready, ep.Total)
	}

	if ep := nodeByName(g, "Service", "managed-svc").Endpoints; ep != nil {
		t.Errorf("selectorless service should have no endpoints, got %+v", ep)
	}

	if ep := nodeByName(g, "Service", "orphan-svc").Endpoints; ep == nil {
		t.Error("orphan-svc: expected 0/0 endpoints, got nil")
	} else if ep.Ready != 0 || ep.Total != 0 {
		t.Errorf("orphan-svc endpoints = %d/%d, want 0/0", ep.Ready, ep.Total)
	}
}
