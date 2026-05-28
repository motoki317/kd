package graph

import "testing"

const relationshipsFixture = `
apiVersion: v1
kind: Node
metadata:
  name: node-1
  uid: node1-uid
---
apiVersion: v1
kind: Pod
metadata:
  name: web-1
  namespace: shop
  uid: pod-uid
  labels:
    app: web
spec:
  nodeName: node-1
  serviceAccountName: web-sa
  volumes:
    - name: config
      configMap:
        name: web-config
    - name: secret
      secret:
        secretName: web-secret
    - name: data
      persistentVolumeClaim:
        claimName: web-data
  containers:
    - name: app
      image: web:latest
      envFrom:
        - secretRef:
            name: web-env
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: shop
  uid: svc-uid
spec:
  selector:
    app: web
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ing
  namespace: shop
  uid: ing-uid
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-svc
                port:
                  number: 80
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
  namespace: shop
  uid: cm-uid
---
apiVersion: v1
kind: Secret
metadata:
  name: web-secret
  namespace: shop
  uid: sec-uid
---
apiVersion: v1
kind: Secret
metadata:
  name: web-env
  namespace: shop
  uid: env-uid
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: web-data
  namespace: shop
  uid: pvc-uid
spec:
  volumeName: web-pv
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: web-pv
  uid: pv-uid
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web-sa
  namespace: shop
  uid: sa-uid
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: web-role
  namespace: shop
  uid: role-uid
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: web-rb
  namespace: shop
  uid: rb-uid
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: web-role
subjects:
  - kind: ServiceAccount
    name: web-sa
    namespace: shop
`

func TestBuildInferredEdges(t *testing.T) {
	g := Build(decodeFixture(t, relationshipsFixture))

	cases := []struct {
		desc               string
		typ                EdgeType
		fromKind, fromName string
		toKind, toName     string
	}{
		{"pod scheduled on node", EdgeScheduledOn, "Pod", "web-1", "Node", "node-1"},
		{"service selects pod", EdgeSelects, "Service", "web-svc", "Pod", "web-1"},
		{"ingress routes to service", EdgeRoutes, "Ingress", "web-ing", "Service", "web-svc"},
		{"pod mounts configmap", EdgeMounts, "Pod", "web-1", "ConfigMap", "web-config"},
		{"pod mounts secret volume", EdgeMounts, "Pod", "web-1", "Secret", "web-secret"},
		{"pod mounts secret via envFrom", EdgeMounts, "Pod", "web-1", "Secret", "web-env"},
		{"pod mounts pvc", EdgeMounts, "Pod", "web-1", "PersistentVolumeClaim", "web-data"},
		// PVC's volumeName completes the Pod → PVC → PV chain (cycle 235).
		{"pvc binds to pv", EdgeMounts, "PersistentVolumeClaim", "web-data", "PersistentVolume", "web-pv"},
		{"pod uses serviceaccount", EdgeUsesServiceAccount, "Pod", "web-1", "ServiceAccount", "web-sa"},
		{"rolebinding binds role", EdgeBinds, "RoleBinding", "web-rb", "Role", "web-role"},
		{"rolebinding binds subject", EdgeBinds, "RoleBinding", "web-rb", "ServiceAccount", "web-sa"},
	}
	for _, c := range cases {
		if !hasEdge(g, c.typ, c.fromKind, c.fromName, c.toKind, c.toName) {
			t.Errorf("%s: missing %s edge %s/%s -> %s/%s", c.desc, c.typ, c.fromKind, c.fromName, c.toKind, c.toName)
		}
	}
}

func TestSelectsRequiresLabelMatch(t *testing.T) {
	// A service whose selector matches no pod produces no selects edge.
	const fixture = `
apiVersion: v1
kind: Pod
metadata:
  name: other
  namespace: shop
  uid: other-uid
  labels:
    app: db
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
  namespace: shop
  uid: svc-uid
spec:
  selector:
    app: web
`
	g := Build(decodeFixture(t, fixture))
	if hasEdge(g, EdgeSelects, "Service", "web-svc", "Pod", "other") {
		t.Error("service should not select a pod with non-matching labels")
	}
}

func TestNoDanglingEdges(t *testing.T) {
	// Every edge endpoint must be a real node in the graph.
	g := Build(decodeFixture(t, relationshipsFixture))
	ids := map[string]bool{}
	for _, n := range g.Nodes {
		ids[n.ID] = true
	}
	for _, e := range g.Edges {
		if !ids[e.From] || !ids[e.To] {
			t.Errorf("dangling edge %s: %s -> %s", e.Type, e.From, e.To)
		}
	}
}
