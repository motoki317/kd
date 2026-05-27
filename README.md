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

## Features

**See the whole namespace at a glance**
- 2D topology across five lenses — ownership, network, node-placement, volumes (mounted
  ConfigMaps/Secrets/PVCs), and RBAC — laid out per connected component and packed to the viewport
  (no horizontal smear in dense namespaces).
- Status by exception: healthy resources stay calm; Degraded/Progressing/Suspended get a colored
  border. Failures that bare counts hide are surfaced too — a Deployment past its rollout deadline, a
  Service whose selector matches no ready pods. Select a node to fade everything unrelated; click a
  legend health to spotlight it.
- Search resources by name, kind, label, or image; the sidebar sorts troubled namespaces first, each
  with a health dot and a non-ready count (live for the namespace you're viewing).

**Drill into a resource**
- Detail drawer with Logs / Events / Manifest tabs. Owner chips walk up the tree (Pod → ReplicaSet →
  Deployment); age, restart count, host, node capacity, container images, labels, and per-container
  status inline; one-click copy of the name.
- Each kind surfaces its essential spec without opening the manifest: a Service's cluster IP, ports,
  and endpoint readiness; an Ingress's host/path → backend routes; a Role's granted resources/verbs;
  a RoleBinding's role and subjects (including the Users/Groups that aren't graph nodes).
- Logs: live tail with smart auto-scroll, a per-container picker, previous-(crashed)-container logs,
  a line filter, an optional timestamps toggle, and aggregated logs across all of a controller's pods
  (including pods created mid-rollout). Manifest as YAML (default) or JSON, copyable.
- Events: the resource and its descendants' Kubernetes events (newest first, warnings highlighted),
  with a live count badge.

**Keyboard & sharing**
- `j`/`k` step through resources (troubled first, scoped to the active filter), `/` filter,
  `1`–`5` switch views, `Esc` backs out, `?` shows shortcuts.
- Namespace, view, and selected resource live in the URL — links and reloads restore the same place;
  the selection follows you across views.
- Follows the OS light/dark preference.

## Status

Functional and verified against docker-desktop. See `docs/ADR/` for design decisions and
`docs/plans/` (local, gitignored) for the working roadmap.

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

## Deployment

`docker build -t <ref> .` builds a single static image (client embedded). Then:

```bash
kubectl apply -k deploy/
```

This runs kd as one read-only Deployment behind a forward-auth proxy, with a declarative
`policy.csv` ConfigMap (hot-reloaded). See [`deploy/README.md`](deploy/README.md) for the
ServiceAccount/RBAC, policy, and IngressRoute details. The release binary embeds the client via
the `embed_web` build tag (`just build`); the default build serves the API with a placeholder page.

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
