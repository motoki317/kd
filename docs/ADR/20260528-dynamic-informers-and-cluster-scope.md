---
date: "2026-05-28"
author: "@motoki317"
status: "accepted"
---

# Context

v1 of kd watched a fixed, hand-curated list of 17 kinds via typed
`client-go/informers`. That kept the graph package's per-kind health rules and edge
inferrers compile-checked against `corev1.Pod` / `appsv1.Deployment` / … and made the
test fixtures small. But it left two visible gaps:

1. **No Custom Resources.** Operators run Argo Workflows, cert-manager, Crossplane,
   external-secrets, ArgoCD itself — every cluster has CRDs, and they are first-class
   topology citizens (Workflow→Pod ownership, Certificate→Issuer references, …). kd showed
   none of it, and a free-standing CR with no owner-chain into a workload was invisible.
2. **No cluster scope.** Cluster-scoped resources (PVs, StorageClasses, ClusterRoles,
   ClusterRoleBindings, CRDs themselves, every cluster-scoped CR) had nowhere to live in
   the UI. Nodes piggy-backed on per-namespace snapshots; everything else was absent.

Both gaps point to the same underlying constraint: typed informers can't watch a kind kd
doesn't already import at compile time.

# Decision

**One dynamic informer per discovered GVR, eager by default, with a small skip list.**

- `internal/kube/store` now wraps `dynamicinformer.DynamicSharedInformerFactory` keyed by
  GVR. Every cached object is `*unstructured.Unstructured`. A new
  `internal/kube/discovery` package enumerates the cluster's resources via the discovery
  API (`ServerPreferredResources` — preferred version per group) and feeds the GVR list
  to the store.
- **CRD churn** is handled by watching the CustomResourceDefinitions GVR and re-running
  discovery on add/remove. New CRDs start a new informer on the same factory; removed CRDs
  leave a dead informer whose watch errors are throttled silently (the dynamic factory has
  no per-informer stop in v1).
- **Eager-load default** with high-cardinality exclusions: events, leases, endpointslices,
  controllerrevisions. Operators can override via `--skip-kinds` / `--eager-kinds`.
- **Kubernetes RBAC** for the kd ServiceAccount is wildcard read (`*` `*` get/list/watch)
  + `pods/log`. Missing permissions are logged once per (GVR, hour) and the kind is
  excluded from snapshots — no log flood, no startup failure.

**The graph package keeps its typed per-kind logic.** A conversion shim at the top of
`Build` converts `*unstructured.Unstructured` → typed struct for kinds in a `typedFactories`
registry, so health rules and edge inferrers don't have to be rewritten against
unstructured field access. Unknown kinds (CRs) stay unstructured and flow through:

- **CR health (`health.go` `crHealth`)**: walks `status.conditions[]` for `Ready` or
  `Available`. `True` → Healthy, `False` → Degraded, missing → Unknown. CRs without
  `status.conditions` fall back to Healthy (existence == health), matching ConfigMap.
- **CR edges (`crdrefs.go`)**: a curated registry of vendor schemas (cert-manager
  Certificate, ExternalSecret, Argo Workflow, ArgoCD Application) emits typed
  `EdgeRefers` edges; a convention scanner walks `spec` for `{name, kind, apiGroup?,
  namespace?}` shapes and picks up the long tail of vendor `*Ref` fields without
  per-CRD config.

**Cluster scope** is a pseudo-namespace named `__cluster__` (DNS-1123-invalid, so it can
never collide with a real namespace). The client pins it to the top of the sidebar.
Server-side `SnapshotNamespace(__cluster__)` returns every cluster-scoped object;
`SnapshotNamespace(ns)` for a real namespace returns its namespaced objects **plus** the
cluster-scoped objects associated with the namespace — the ride-along policy that replaces
"every Node in every snapshot". Associated means:

- referenced one hop from a namespaced object: a PVC's `volumeName` → PV, a RoleBinding's
  `roleRef` → ClusterRole, plus ownerReferences. (A Pod's `nodeName` → Node is deliberately
  *excluded*: no relationship category draws the `scheduledOn` edge, so a rode-along Node only
  ever appears as a permanently-orphaned card — the pod↔node story lives in the Nodes view.)
- a ClusterRoleBinding that grants a ClusterRole to a ServiceAccount **in** the namespace, plus
  a second hop to that ClusterRole. This is the one reference resolved in *reverse* (the
  cluster-scoped binding names the namespaced SA, not vice-versa), so it costs a scan of every
  ClusterRoleBinding — acceptable given their low cardinality. Without it, a namespace's RBAC
  relationship view could never show the cluster-level grants its ServiceAccounts actually hold.

**Policy.csv** stays the kd app-layer authz surface. `resourceClasses(kind, group)`
returns BOTH the legacy class (pods/nodes/workloads/rbac/…) and the GVR group; the new
`Enforcer.EnforceAny` allows if either matches an allow rule and neither matches a deny,
so existing policy.csv files keep working AND operators can write group-targeted rules
for vendor CRs. The kd Casbin schema is `p, subject, namespace, resource, action, effect`
— a group-targeted rule looks like `p, alice, *, argoproj.io, *, allow` (the GVR group
fills the `resource` slot, replacing or layered on top of the legacy class). This is a kd
extension to the legacy-class vocabulary, not stock ArgoCD policy syntax.

**The All view** (`layoutGraphByKind`) groups every node by kind, lays each kind in its
own grid, then shelf-packs the kind boxes into the viewport. Ownership and reference
edges still draw across kind boxes. It replaces the previously-removed hairball with a
readable per-kind layout — important once CRs (which often have no edges to the workload
kinds) enter the picture.

# Consequences

- **Truly all resources.** Operators see Workflows, Certificates, ExternalSecrets,
  Crossplane composites, ArgoCD Applications — anything the cluster exposes — without per-
  CRD configuration. CR ownership chains down to Pods are visible by default.
- **Cluster scope at a glance.** `[cluster]` lands the operator on cluster-wide state in
  one click; the sidebar dot rolls up cluster-scoped resource health (Node Degraded, PV
  Lost, cert-manager ClusterIssuer Degraded, …).
- **No duplicated graph logic.** Typed-fixture tests stay valid; the conversion shim
  proves unstructured input produces the same graph as typed input
  (`TestBuildUnstructuredParity`).
- **Backwards-compatible RBAC.** Existing policy.csv files continue to authorize
  pods/nodes/workloads/rbac/logs/namespaces as before; new GVR-group rules layer on top.

# Impact

- **Wildcard ClusterRole** is broader than the prior allowlist — same trade-off ArgoCD
  makes. `deploy/README.md` documents the narrower starting point.
- **Memory** scales with discovered kinds × object count. The four-kind skip default
  (events/leases/endpointslices/controllerrevisions) keeps the eager set bounded on
  typical clusters; operators can widen or narrow via flags.
- **CRD removal** leaves a dead informer behind — its watch fails and is throttled
  silently. A per-GVR stop is a future improvement (dynamic factory lacks it in v1).
- **Convention scanner heuristic.** A `{name, kind}` shape is taken as a reference
  unless the map also has `value` (drops parameter-style pairs), `spec`, `status`,
  `metadata`, or `data` (drops embedded objects). False positives can produce extra
  edges; the curated registry (`crdRefRules`) is the trust anchor.
- **CR-defined edges beyond ownerReferences are heuristic** — for full accuracy operators
  who care can add to the curated registry. Per-cluster config is out of scope for v1.

# Alternatives

- **All-typed (continue with the curated list).** Rejected: closes the door on CRDs and
  the cluster-scope kinds operators actually want to see.
- **All-unstructured (rewrite the graph package).** Rejected for v1: the typed per-kind
  logic is heavily tested and the conversion shim avoids rewriting it. We can migrate
  individual rules to unstructured opportunistically if a kind needs it.
- **Lazy-only informers (start on first request).** Rejected as the headline default:
  operators expect snapshots to be instant. We do lazy-start the skipped high-cardinality
  kinds — those are exceptional, not the rule.
- **Per-CRD config file (operator declares which kinds to watch).** Rejected: doesn't
  meet the "truly all" ask. Kept as an opt-out (`--skip-kinds`).
- **One-shot discovery at startup (no CRD watcher).** Rejected: would silently drop newly
  installed CRDs until kd restarts, which is jarring in a cluster running Argo CD's
  ApplicationSet or any operator that installs CRDs on demand.

# Notes

- `__cluster__` is invalid as a real Kubernetes namespace (DNS-1123 disallows `_`), so
  the sentinel is safe as a path/query value with no escape needed.
- The convention scanner's false-positive rate is unknown on diverse CRD ecosystems. The
  scanner can be disabled in a future iteration if it produces noise; the curated registry
  alone covers the most common cases.
- Health rollup for `[cluster]` calls `SummarizeCluster` (a sibling of `Summarize` that
  iterates the cluster-scoped subset). A cordoned Node now flags the cluster entry but no
  longer flags every namespace.
- This ADR partially amends [`20260527-kubernetes-access-model.md`](./20260527-kubernetes-access-model.md)
  (read verbs widened to wildcard) and extends
  [`20260527-resource-relationship-graph.md`](./20260527-resource-relationship-graph.md)
  with the `refers` edge type and the CR-health rule.
