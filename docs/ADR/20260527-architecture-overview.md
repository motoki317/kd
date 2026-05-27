---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

kd is a web-served Kubernetes dashboard for two audiences: cluster-wide operators who
need to see the whole namespace/cluster state at a glance, and application developers who
mostly want to confirm pod status and read logs. The product priority is UX — the tool
must surface real problems without forcing users to learn a new mental model. The core
visual is an ArgoCD-style 2D resource view that makes parent-child relationships obvious
and supports drill-down into details and logs.

We need a baseline architecture that the rest of the ADRs refine.

# Decision

A **server/client split**, shipped as a **single Go binary** that embeds the built client.

- **Server: Go.** It connects to the Kubernetes API with `client-go`, runs **informers**
  per watched resource type to maintain an **in-memory cache** of cluster state, computes
  the **relationship graph** (see resource-relationship-graph ADR), and exposes an HTTP
  API (REST + SSE) plus pod log streaming. It owns authentication (proxy-header trust) and
  authorization (declarative policy.csv).
- **Client: Solid.js + Vite + TypeScript.** It renders the 2D topology, detail panels, and
  log viewer. Built assets are embedded into the Go binary via `go:embed` so deployment is
  one container/binary with no separate static host.
- **Cache-first reads.** API responses are served from the informer cache, not by hitting
  the API server per request, so the UI stays responsive and the cluster API is protected
  from dashboard traffic. Writes are out of scope for v1 (read-only dashboard).

High-level package layout:

```
cmd/kd/              # entrypoint, flag/env config wiring
internal/
  config/            # configuration model + loading
  auth/              # proxy-header identity extraction
  rbac/              # policy.csv loading + enforcement (Casbin)
  kube/              # client-go informers, store, graph builder
  api/               # HTTP handlers (REST, SSE, logs)
  server/            # router, middleware, embedded asset serving
web/                 # Solid.js + Vite client
docs/{ADR,plans}/
```

# Consequences

- Single-binary deployment matches the manifest repo's app conventions (one container
  behind a Traefik IngressRoute) and removes CORS/static-hosting complexity.
- Informer cache gives O(1) reads and natural change-feeds to drive real-time UI updates.
- Go + Solid keeps both halves small, fast, and dependency-light.

# Impact

- The server holds whole-namespace (or whole-cluster) state in memory; memory scales with
  object count. Acceptable for the target clusters; revisit with field selectors/sharding
  if it grows.
- Read-only v1 narrows the security surface (no mutating verbs needed in the ServiceAccount).

# Alternatives

- **Separate SPA host + API.** Rejected: adds CORS, a second deployable, and asset
  versioning skew, for no benefit at this scale.
- **Server-side rendering / HTMX.** Rejected: the interactive 2D graph with live updates is
  client-state-heavy; a reactive client framework fits better.
- **Per-request API-server reads (no cache).** Rejected: slow UX and risk of overloading the
  API server under multiple viewers.

# Notes

- Go 1.26 toolchain; client-go pinned to the cluster's minor version range.
- See sibling ADRs for auth, RBAC, kube access, graph model, transport, and frontend.
