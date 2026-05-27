# kd — Kubernetes Dashboard

A web-served Kubernetes dashboard focused on **UX**: an ArgoCD-style 2D resource topology
that makes parent-child relationships obvious, so cluster operators can read whole-namespace
state at a glance and app developers can jump straight to pod status and logs.

- **Server:** Go — `client-go` informer cache, relationship-graph builder, REST + SSE API,
  pod log streaming.
- **Client:** Solid.js + Vite — 2D SVG topology (Dagre layout), detail drawer, log viewer.
- **Auth:** proxy authentication — trusts an upstream identity header (`X-Forwarded-User`),
  matching the existing `traefik-forward-auth` + Grafana setup.
- **RBAC:** declarative `policy.csv` (ArgoCD/Casbin-style), hot-reloaded.
- **Ships as a single Go binary** with the client embedded.

## Status

Early development. See `docs/ADR/` for design decisions and `docs/plans/` (local, gitignored)
for the working roadmap.

## Development

Prerequisites: Go 1.26+, Node 24+, a reachable Kubernetes context (`kubectl` works). With Nix:
`nix develop` provides the toolchain.

```bash
just                 # list recipes
just dev             # run Go API (:8080) + Vite dev server (:5173) together
just test            # Go + client tests
just check           # vet + lint + typecheck
just build           # build client, embed, build the kd binary
```

In dev, the Vite server proxies `/api` to the Go server and injects a `dev` identity, so no
forward-auth proxy is needed locally.

## Architecture

See `docs/ADR/README.md` for the full set. Highlights:

| Concern | Decision |
| --- | --- |
| Topology | Single Go binary, informer cache, server-built relationship graph |
| Auth | Trust upstream `X-Forwarded-User`; no in-app login |
| RBAC | Declarative `policy.csv` (Casbin), app-level authz |
| K8s access | One read-only ServiceAccount, app-level authorization |
| Transport | Server-Sent Events for watch feed + logs |
| Client | Solid.js + Vite, Dagre layout, SVG |
