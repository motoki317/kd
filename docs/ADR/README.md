# Architecture Decision Records (ADR)

ADRs capture the significant architectural decisions behind **kd** — the why, the
trade-offs, and the alternatives we rejected. They let a future contributor (human or
agent) understand a decision without re-deriving it, and avoid re-litigating settled
questions.

## Creating an ADR

1. Copy `_template.md`.
2. Name it `YYYYMMDD-<title>.md` — the date matches the `date` front-matter field, and
   the title is a short, concrete English phrase (e.g. `20260527-proxy-authentication.md`).
3. Fill in every section: Context, Decision, Consequences, Impact, Alternatives, Notes.

## Status

- **proposed** — under discussion (open PR).
- **accepted** — merged; treated as binding.
- **superseded** — replaced by a newer ADR. Prefix the old filename with `_`, and
  cross-link the old and new ADRs.

Front-matter carries the canonical `date`, `author`, and `status`. Git history is the
authoritative timeline; the filename date is a convenience for sorting.

## Index

| Date | ADR | Summary |
| --- | --- | --- |
| 2026-05-27 | [Architecture overview](./20260527-architecture-overview.md) | Go server + Solid.js client, single binary, informer-backed cache |
| 2026-05-27 | [Proxy authentication](./20260527-proxy-authentication.md) | Trust an upstream identity header (`X-Forwarded-User`), no login flow |
| 2026-05-27 | [Declarative RBAC via policy.csv](./_20260527-declarative-rbac-policy-csv.md) *(superseded)* | ArgoCD/Casbin-style policy file, app-level authorization — superseded by policy.yaml |
| 2026-05-27 | [Kubernetes access model](./20260527-kubernetes-access-model.md) | Single read-only ServiceAccount, app-level authz (not impersonation) |
| 2026-05-27 | [Resource relationship graph](./20260527-resource-relationship-graph.md) | ownerReferences + inferred edges, server-built graph model |
| 2026-05-27 | [Real-time transport (SSE)](./20260527-realtime-transport-sse.md) | Server-Sent Events for watch updates and log streaming |
| 2026-05-27 | [Frontend stack](./20260527-frontend-stack.md) | Solid.js + Vite + TypeScript, Dagre layout, SVG topology |
| 2026-05-28 | [Kubeconfig context switcher](./20260528-kubeconfig-context-switcher.md) | Parallel per-context informer caches in kubeconfig mode; hidden in-cluster |
| 2026-05-28 | [Dynamic informers + cluster scope](./20260528-dynamic-informers-and-cluster-scope.md) | One dynamic informer per discovered GVR (incl. CRDs); `[cluster]` pseudo-namespace; CR health/edges heuristics |
| 2026-06-03 | [Nodes capacity & usage visualization](./20260603-nodes-capacity-usage-visualization.md) | The `nodes` group-by as a length-encoded capacity/usage bullet view (two ceilings, exact-proportional segments, small-pod fold) |
| 2026-06-03 | [Unified view: relationship filter + grouping](./20260603-unified-view-relationship-filter-grouping.md) | Replace fixed views with two composable client controls (group-by + rel-filter); server streams the full graph |
| 2026-06-05 | [Testing view math vs headless animation](./20260605-testing-view-math-vs-headless-animation.md) | Headless agent-browser freezes rAF/animation; extract pure fit math to `viewport.ts` and unit-test the target, not the live transform |
| 2026-06-10 | [Drawer usage gauges: attribution vs totals](./20260610-drawer-usage-gauges-attribution.md) | Per-container bars on the cards (own req/lim), plain summed gauge above, workload fill split by pod (default) or container |
| 2026-06-11 | [Workload counts never read Degraded](./20260611-workload-counts-never-degraded.md) | Replica counts can't distinguish outage from normal startup; count-zero reads Progressing, Degraded needs pod-level evidence |
| 2026-06-12 | [Declarative authorization via policy.yaml](./20260612-policy-yaml-authorization.md) | Human-first YAML policy (roles/users/groups/deny) replaces the ArgoCD/Casbin policy.csv; strict validating parse; first-class `clusterScoped` rule scope |
| 2026-06-12 | [Release pipeline](./20260612-release-pipeline.md) | Two independent semver tracks: `v*` → GoReleaser (binaries + ghcr image), `chart-v*` → Helm chart as OCI artifact; chart pins `appVersion` |
