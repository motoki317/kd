package graph

import (
	"strings"
	"testing"
)

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
kind: Pod
metadata:
  name: down
  namespace: shop
  uid: p4
  labels:
    app: down
status:
  phase: Running
  conditions:
    - type: Ready
      status: "False"
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
  name: down-svc
  namespace: shop
  uid: svc4
spec:
  selector:
    app: down
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
---
apiVersion: v1
kind: Service
metadata:
  name: alias-svc
  namespace: shop
  uid: svc5
spec:
  type: ExternalName
  externalName: db.example.com
  selector:
    app: web
`
	g := Build(decodeFixture(t, fixture))

	// web-svc has one ready backend out of two: still serving, so it stays Healthy (the partial
	// ratio shows in the drawer, not as a topology alarm).
	web := nodeByName(g, "Service", "web-svc")
	if web.Endpoints == nil || web.Endpoints.Ready != 1 || web.Endpoints.Total != 2 {
		t.Errorf("web-svc endpoints = %+v, want 1/2", web.Endpoints)
	}
	if web.Health != HealthHealthy {
		t.Errorf("web-svc health = %q, want Healthy (still has a ready backend)", web.Health)
	}

	// A selectorless Service manages its endpoints externally, so we report nothing and leave it calm.
	if ep := nodeByName(g, "Service", "managed-svc").Endpoints; ep != nil {
		t.Errorf("selectorless service should have no endpoints, got %+v", ep)
	}

	// A selector that matches no pod is a misconfiguration the topology must surface: Degraded with
	// an explanatory status, since a Service otherwise always reads Healthy.
	orphan := nodeByName(g, "Service", "orphan-svc")
	if orphan.Endpoints == nil || orphan.Endpoints.Total != 0 {
		t.Errorf("orphan-svc endpoints = %+v, want 0/0", orphan.Endpoints)
	}
	if orphan.Health != HealthDegraded || orphan.Status != "no endpoints" {
		t.Errorf("orphan-svc = %q/%q, want Degraded/\"no endpoints\"", orphan.Health, orphan.Status)
	}

	// A Service whose only backend is not ready has no serving endpoints: Degraded, status says 0/N.
	down := nodeByName(g, "Service", "down-svc")
	if down.Health != HealthDegraded || down.Status != "0/1 ready" {
		t.Errorf("down-svc = %q/%q, want Degraded/\"0/1 ready\"", down.Health, down.Status)
	}

	// An ExternalName service is a DNS alias whose selector Kubernetes ignores (kubectl's generator
	// emits one anyway) — it must stay calm with no endpoint readiness, even though its selector
	// happens to match pods.
	alias := nodeByName(g, "Service", "alias-svc")
	if alias.Endpoints != nil {
		t.Errorf("ExternalName service should have no endpoints, got %+v", alias.Endpoints)
	}
	if alias.Health != HealthHealthy {
		t.Errorf("alias-svc health = %q, want Healthy (selector is inert on ExternalName)", alias.Health)
	}
}

// A named targetPort that no selected pod's containers declare creates ZERO Kubernetes endpoints even
// though the pods are Ready — the typo'd-port shape. The service must read 0/N Degraded with the why,
// not a false "1/1 ready". A numeric targetPort always routes, and a name declared by the pod is fine.
func TestServiceNamedTargetPortMismatch(t *testing.T) {
	const fixture = `
apiVersion: v1
kind: Pod
metadata:
  name: web-1
  namespace: shop
  uid: p1
  labels:
    app: web
spec:
  containers:
    - name: main
      image: nginx
      ports:
        - name: web
          containerPort: 80
status:
  phase: Running
  conditions:
    - type: Ready
      status: "True"
---
apiVersion: v1
kind: Service
metadata:
  name: typo-svc
  namespace: shop
  uid: svc1
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: http
---
apiVersion: v1
kind: Service
metadata:
  name: named-ok-svc
  namespace: shop
  uid: svc2
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: web
---
apiVersion: v1
kind: Service
metadata:
  name: numeric-svc
  namespace: shop
  uid: svc3
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 80
`
	g := Build(decodeFixture(t, fixture))

	typo := nodeByName(g, "Service", "typo-svc")
	if typo.Endpoints == nil || typo.Endpoints.Ready != 0 || typo.Endpoints.Total != 1 {
		t.Errorf("typo-svc endpoints = %+v, want 0/1", typo.Endpoints)
	}
	if typo.Health != HealthDegraded || typo.Status != "0/1 ready" {
		t.Errorf("typo-svc = %q/%q, want Degraded/\"0/1 ready\"", typo.Health, typo.Status)
	}
	if typo.Message == "" || !strings.Contains(typo.Message, `targetPort "http"`) {
		t.Errorf("typo-svc message = %q, want the unresolved-port explanation", typo.Message)
	}

	// The matching name and the numeric port both resolve: 1/1, Healthy, no message.
	for _, name := range []string{"named-ok-svc", "numeric-svc"} {
		svc := nodeByName(g, "Service", name)
		if svc.Endpoints == nil || svc.Endpoints.Ready != 1 || svc.Endpoints.Total != 1 {
			t.Errorf("%s endpoints = %+v, want 1/1", name, svc.Endpoints)
		}
		if svc.Health != HealthHealthy || svc.Message != "" {
			t.Errorf("%s = %q (msg %q), want Healthy with no message", name, svc.Health, svc.Message)
		}
	}
}

// Summarize rolls up the built graph's health, so a namespace whose only fault is a Service with no
// endpoints is reported troubled in the sidebar — consistent with what the topology shows.
func TestSummarizeCountsEndpointlessService(t *testing.T) {
	const fixture = `
apiVersion: v1
kind: Service
metadata:
  name: orphan-svc
  namespace: shop
  uid: svc1
spec:
  selector:
    app: ghost
`
	if got := Summarize(decodeFixture(t, fixture)); got.Health != HealthDegraded || got.NonReady != 1 {
		t.Errorf("Summarize = %+v, want Degraded/1", got)
	}
}
