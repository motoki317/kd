---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

The defining feature of kd is a 2D view that renders Kubernetes resources with their
**parent-child relationships clearly visible**, so an operator can grasp a namespace (or
the cluster) at a glance and drill into details/logs. Beyond ownership, useful relationships
include Node↔Pod, Service↔Pod, Ingress↔Service, mount references, and RBAC links. We need a
single, consistent graph model that the client can lay out and render.

# Decision

The server builds a **typed relationship graph** from the informer cache and serves it as
`{nodes, edges}`. The client lays it out and renders it (frontend-stack ADR).

**Node** = one Kubernetes object: `{id (uid), kind, apiVersion, namespace, name, health,
status, ownerUIDs, key metadata}`. `id` is the object UID; synthetic nodes (e.g. a Node, or
an external LoadBalancer) get stable derived IDs.

**Edge** = a typed relationship `{from, to, type}`. Edge types and how they are inferred:

- `ownerReference` — **primary** parent-child, straight from `metadata.ownerReferences`
  (Deployment→ReplicaSet→Pod, StatefulSet→Pod, Job→Pod, CronJob→Job, etc.). This forms the
  ArgoCD-style ownership tree and is the default layout backbone.
- `scheduledOn` — Pod→Node, from `pod.spec.nodeName` (enables the Node/Pod view).
- `selects` — Service→Pod, by matching `service.spec.selector` against pod labels (via
  Endpoints/EndpointSlice when available for accuracy, falling back to selector match).
- `routes` — Ingress→Service (and Gateway/HTTPRoute→Service if present), from backend refs.
- `exposes` — Service→workload, derived transitively for summary views.
- `mounts` — Pod→ConfigMap/Secret/PVC, from `volumes` and `envFrom`/`valueFrom`.
- `usesServiceAccount` — Pod→ServiceAccount.
- `binds` — RoleBinding/ClusterRoleBinding→Role/ClusterRole, and →subjects
  (User/Group/ServiceAccount), for the RBAC relationship view.
- `refers` — CR→referenced object, inferred from a curated registry of vendor schemas
  (Argo Workflow, cert-manager Certificate, ExternalSecret, ArgoCD Application) plus a
  convention scanner for `{name, kind, apiGroup?, namespace?}` shapes in `spec`. Added by
  [`20260528-dynamic-informers-and-cluster-scope.md`](./20260528-dynamic-informers-and-cluster-scope.md);
  rendered with a dashed style so the ownership backbone stays the primary read.

**Health/status** is computed per kind with a small rules set (e.g. Pod: Running/Ready vs
CrashLoopBackOff/Pending; Deployment: available replicas vs desired), normalized to a shared
enum (`Healthy | Progressing | Degraded | Suspended | Unknown`) so the UI colors nodes
uniformly — the ArgoCD approach. Custom resources without a typed rule walk
`status.conditions[]` for `Ready` or `Available` per the heuristic in
[`20260528-dynamic-informers-and-cluster-scope.md`](./20260528-dynamic-informers-and-cluster-scope.md).

**Views**: the graph is filtered into named views the client can request:
`ownership` (default, per namespace), `nodes` (Node/Pod), `network` (Ingress/Service/Pod),
`rbac` (bindings/roles/subjects). Each view is a subset of node/edge types from the same
underlying graph, so there is one source of truth.

# Consequences

- One graph model serves every relationship view; adding a relationship = adding an edge
  inferrer, not a new subsystem.
- ownerReferences as the backbone gives an exact, kubelet-authored hierarchy — no guessing
  for the primary tree.
- Health normalization lets the client stay dumb about per-kind semantics.

# Impact

- Selector-based edges (`selects`) can be ambiguous/expensive; we prefer EndpointSlice truth
  and cap fan-out. Graph building runs on cache updates, not per request.
- Cross-namespace edges (RBAC subjects, ClusterRole) require care in a namespace-scoped view;
  such edges are marked and can point to nodes outside the current view.

# Alternatives

- **Client-side graph assembly.** Rejected: would ship raw objects to the browser (heavier,
  leaks more data) and duplicate inference logic per client.
- **ownerReferences only.** Rejected: misses the Node/Service/RBAC relationships the user
  explicitly asked for.

# Notes

- Edge inference is pure given a cache snapshot, so it is unit-testable against YAML fixtures
  (no live cluster) — see the kube-graph plan/test slice.
