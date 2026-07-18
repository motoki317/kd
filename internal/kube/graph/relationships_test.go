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
    - name: projected
      projected:
        sources:
          - configMap:
              name: web-projcm
          - secret:
              name: web-projsec
          - configMap: # auto-injected root CA — must NOT produce a mount edge (every pod has it)
              name: kube-root-ca.crt
  containers:
    - name: app
      image: web:latest
      envFrom:
        - secretRef:
            name: web-env
        - configMapRef:
            name: web-envcm
      env:
        - name: PLAIN
          value: literal # no valueFrom — must be skipped, not crash or edge
        - name: FROM_CM_KEY
          valueFrom:
            configMapKeyRef:
              name: web-keycm
              key: k
        - name: FROM_SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: web-keysec
              key: k
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
kind: ConfigMap
metadata:
  name: web-envcm
  namespace: shop
  uid: envcm-uid
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-keycm
  namespace: shop
  uid: keycm-uid
---
apiVersion: v1
kind: Secret
metadata:
  name: web-keysec
  namespace: shop
  uid: keysec-uid
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-projcm
  namespace: shop
  uid: projcm-uid
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-root-ca.crt # auto-injected into every namespace — must be dropped from the graph entirely
  namespace: shop
  uid: rootca-uid
---
apiVersion: v1
kind: Secret
metadata:
  name: web-projsec
  namespace: shop
  uid: projsec-uid
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
		{"pod mounts configmap via envFrom", EdgeMounts, "Pod", "web-1", "ConfigMap", "web-envcm"},
		{"pod mounts configmap via env valueFrom keyRef", EdgeMounts, "Pod", "web-1", "ConfigMap", "web-keycm"},
		{"pod mounts secret via env valueFrom keyRef", EdgeMounts, "Pod", "web-1", "Secret", "web-keysec"},
		{"pod mounts configmap via projected source", EdgeMounts, "Pod", "web-1", "ConfigMap", "web-projcm"},
		{"pod mounts secret via projected source", EdgeMounts, "Pod", "web-1", "Secret", "web-projsec"},
		{"pod mounts pvc", EdgeMounts, "Pod", "web-1", "PersistentVolumeClaim", "web-data"},
		// PVC's volumeName completes the Pod → PVC → PV chain.
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

	// The auto-injected root-CA bundle every namespace carries is pure noise (a lone orphan ConfigMap,
	// or a star hub wired to every pod via its projected SA-token volume), so its node is dropped from
	// the graph entirely. With no node, no mount edge to it can survive either. The fixture includes a
	// real kube-root-ca.crt ConfigMap object AND a pod projecting it, so this exercises both.
	for _, n := range g.Nodes {
		if n.Kind == "ConfigMap" && n.Name == "kube-root-ca.crt" {
			t.Error("auto-injected kube-root-ca.crt must be dropped from the graph, not emitted as a node")
		}
	}
	if hasEdge(g, EdgeMounts, "Pod", "web-1", "ConfigMap", "kube-root-ca.crt") {
		t.Error("auto-mounted kube-root-ca.crt must not produce a mount edge")
	}
}

// The big fixture routes Ingress via HTTP-path backends and binds a namespaced Role to a
// namespaced subject. These RBAC/ingress branches it doesn't reach: an Ingress DEFAULT backend, a
// RoleBinding → ClusterRole (cluster-scoped roleRef), and a subject ServiceAccount with no explicit
// namespace (which must fall back to the binding's namespace).
func TestRBACAndIngressEdgeCases(t *testing.T) {
	const fixture = `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: default-only
  namespace: shop
  uid: ing2-uid
spec:
  defaultBackend:
    service:
      name: fallback-svc
      port:
        number: 80
---
apiVersion: v1
kind: Service
metadata:
  name: fallback-svc
  namespace: shop
  uid: fbsvc-uid
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: viewer
  uid: cr-uid
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: robot
  namespace: shop
  uid: robot-uid
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: bind-cluster
  namespace: shop
  uid: rb2-uid
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: viewer
subjects:
  - kind: ServiceAccount
    name: robot
    # no namespace: must default to the binding's namespace (shop)
`
	g := Build(decodeFixture(t, fixture))

	if !hasEdge(g, EdgeRoutes, "Ingress", "default-only", "Service", "fallback-svc") {
		t.Error("an Ingress default backend should route to its Service")
	}
	// roleRef Kind=ClusterRole → cluster-scoped (roleRefNamespace returns ""), so the binds edge
	// targets the cluster-scoped ClusterRole, not a namespaced Role.
	if !hasEdge(g, EdgeBinds, "RoleBinding", "bind-cluster", "ClusterRole", "viewer") {
		t.Error("a RoleBinding should bind its cluster-scoped ClusterRole roleRef")
	}
	// The namespace-less subject resolves to the binding's namespace and links to that ServiceAccount.
	if !hasEdge(g, EdgeBinds, "RoleBinding", "bind-cluster", "ServiceAccount", "robot") {
		t.Error("a subject without a namespace should fall back to the binding's namespace")
	}
}

// TestPDBGuardsEdges proves a PodDisruptionBudget links to the pods its selector matches (so a degraded
// PDB navigates to the failing pods), via a full LabelSelector with matchExpressions, and that an
// empty-selector PDB (the namespace-wide "protect everything" shape) guards every pod in its namespace.
func TestPDBGuardsEdges(t *testing.T) {
	const fixture = `
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-pdb
  namespace: shop
  uid: pdb-uid
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: web
    matchExpressions:
      - { key: tier, operator: In, values: [frontend] }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-1
  namespace: shop
  uid: web1-uid
  labels: { app: web, tier: frontend }
---
apiVersion: v1
kind: Pod
metadata:
  name: other-1
  namespace: shop
  uid: other1-uid
  labels: { app: web, tier: backend }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: all-pdb
  namespace: shop
  uid: allpdb-uid
spec:
  minAvailable: 1
  selector: {}
`
	g := Build(decodeFixture(t, fixture))

	if !hasEdge(g, EdgeGuards, "PodDisruptionBudget", "web-pdb", "Pod", "web-1") {
		t.Error("a PDB should guard the pod its matchLabels+matchExpressions select")
	}
	if hasEdge(g, EdgeGuards, "PodDisruptionBudget", "web-pdb", "Pod", "other-1") {
		t.Error("a PDB must NOT guard a pod failing its matchExpressions (tier=backend)")
	}
	// An empty selector guards every pod in the namespace (the "protect everything here" pattern).
	if !hasEdge(g, EdgeGuards, "PodDisruptionBudget", "all-pdb", "Pod", "web-1") ||
		!hasEdge(g, EdgeGuards, "PodDisruptionBudget", "all-pdb", "Pod", "other-1") {
		t.Error("an empty-selector PDB should guard every pod in its namespace")
	}
}

func TestNetworkPolicyGovernsEdges(t *testing.T) {
	const fixture = `
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-np
  namespace: shop
  uid: np-uid
spec:
  podSelector:
    matchLabels: { app: api }
  policyTypes: [Ingress]
---
apiVersion: v1
kind: Pod
metadata:
  name: api-1
  namespace: shop
  uid: api1-uid
  labels: { app: api }
---
apiVersion: v1
kind: Pod
metadata:
  name: web-1
  namespace: shop
  uid: web1-uid
  labels: { app: web }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: shop
  uid: denyall-uid
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
`
	g := Build(decodeFixture(t, fixture))

	if !hasEdge(g, EdgeGoverns, "NetworkPolicy", "api-np", "Pod", "api-1") {
		t.Error("a NetworkPolicy should govern the pod its podSelector matches")
	}
	if hasEdge(g, EdgeGoverns, "NetworkPolicy", "api-np", "Pod", "web-1") {
		t.Error("a NetworkPolicy must NOT govern a pod its podSelector doesn't match")
	}
	// An empty podSelector applies to every pod in the namespace (the default-deny shape).
	if !hasEdge(g, EdgeGoverns, "NetworkPolicy", "deny-all", "Pod", "api-1") ||
		!hasEdge(g, EdgeGoverns, "NetworkPolicy", "deny-all", "Pod", "web-1") {
		t.Error("an empty-podSelector NetworkPolicy should govern every pod in its namespace")
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
