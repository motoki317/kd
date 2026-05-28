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
- 2D topology across six lenses — each lens uses the layout that fits its relationship:
  Ownership reads top-down (the workload tree), Network / Volumes / RBAC read left-to-right
  (traffic / dependency / binding flow), Nodes view groups pods inside labeled host containers
  (containment carries scheduledOn, no fan of edges), and the All view groups every resource by
  kind. Each lens lays out per connected component and packs to the viewport (no horizontal
  smear in dense namespaces).
- Every kind the cluster exposes is watched via a dynamic informer factory, including custom
  resources defined by CRDs. Workflows, Certificates, ExternalSecrets, ArgoCD Applications,
  Crossplane composites — all render in the topology with their ownership chains down to Pods.
- A pinned `[cluster]` entry at the top of the sidebar shows cluster-scoped state (Nodes, PVs,
  ClusterRoles, CRDs, cluster-scoped CRs) at one click. Cluster-scoped objects also ride along
  into namespace views when referenced (a Pod's Node, a PVC's PV) — so a namespace doesn't
  silently hide the cluster-scoped resources its workloads depend on.
- Every card carries a large kind-specific silhouette (Pod=circle, Deployment=stacked layers,
  Service=hub-spokes, Secret=key, PVC=cylinder, …) with a small kubectl-style kind label below it
  (DEPL, RS, STS, DS, SVC, …) so types read by shape at a glance; a relative-age tag ("7d", "30s")
  updates in place so a freshly-restarted pod next to a 90d release pops out.
- Health on the card body: the whole card wears a pastel tint + colored border matching its state
  (healthy soft green, degraded red, progressing amber). Non-healthy cards add a quiet halo so
  trouble announces itself at zoom-out across a packed canvas.
- Selecting a card smoothly zooms the canvas to frame its full ownership subtree, with every
  unrelated resource fading. Click the background to clear; pan with two-finger trackpad scroll,
  zoom with pinch / cmd-scroll / mouse wheel. SSE patches glide between layouts — additions fade
  in, removals fade out, position shifts ease — so a rollout is visible as motion, not a jump cut.
- The topbar carries a proportional health-distribution stripe along its bottom edge so
  "what is this cluster doing right now?" reads without parsing legend numbers.
- Search resources by name, kind, label, image, status, host, or IP — kubectl short names (svc, sts,
  hpa, pdb, netpol …) match too. Click a kind chip under the search to spotlight only that kind
  (multi-select; composes with the legend-health filter). Pods carry a distinct indigo accent so
  the fundamental workload reads at a glance. The sidebar sorts troubled namespaces first, each
  with a health dot and a non-ready count colored to match (live for the namespace you're viewing,
  computed on the unfiltered graph so a view that filters out the unhealthy resource doesn't lie).
  Resource count + current filter subset shown in the topology corner. The active kind filter
  persists in the URL so a filtered view is shareable.

**Drill into a resource**
- Detail drawer with Logs / Events / Manifest tabs. The drawer header carries the same kind
  silhouette as the card, so a click reads as "this card, expanded." Owner chips walk up the tree
  (Pod → ReplicaSet → Deployment), each chip with its kind icon. Age, restart count, host (click to
  jump to the Node), node capacity, container images, labels, and per-container status inline;
  one-click copy of the name. Rich hover tooltips on cards reveal everything at zoomed-out scale.
- Each kind surfaces its essential spec without opening the manifest: a Service's cluster IP,
  external address (LoadBalancer / externalIPs), ports, and endpoint readiness; an Ingress's
  host/path → backend routes; a Role's granted resources/verbs; a RoleBinding's role and subjects
  (including Users/Groups that aren't graph nodes — each row tagged with its kind icon).
- Logs: live tail with smart auto-scroll, a per-container picker, previous-(crashed)-container logs,
  a line filter, an optional timestamps toggle, and aggregated logs across all of a controller's pods
  (including pods created mid-rollout). Manifest as YAML (default) or JSON, with `apiVersion`/`kind`
  stamped on so a copy applies cleanly.
- Events: the resource and its descendants' Kubernetes events (newest first, warnings highlighted),
  with a live count badge. Aggregated events show which descendant emitted them — click the source
  pill to jump straight to the offending pod.

**Keyboard & sharing**
- `j`/`k` (or `↓`/`↑`) step through resources (troubled first, scoped to the active filter), `/`
  focuses the namespace filter, `1`–`6` switch views (the 6th is "all"), `Esc` backs out, `?`
  shows shortcuts.
- The topbar shows a "kd › <namespace>" breadcrumb and a live/connecting/offline connection pill.
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

When kd loads a local kubeconfig (instead of in-cluster config), the topbar gains a context
switcher listing every context in the merged kubeconfig — switching reloads the dashboard
against that cluster's API server without touching your host's `kubectl config current-context`.
Only the kubeconfig's `current-context` is pre-synced at startup; other contexts pay a one-time
informer sync on first selection. The switcher is hidden in deployed (in-cluster) mode.

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
| Topology | Single Go binary, dynamic-informer cache (every discovered GVR incl. CRDs), server-built relationship graph |
| Auth | Trust upstream `X-Forwarded-User`; no in-app login |
| RBAC | Declarative `policy.csv` (Casbin), app-level authz with legacy class + GVR group dual-class |
| K8s access | One read-only ServiceAccount, wildcard read (`*` `*` get/list/watch), app-level authorization |
| Transport | Server-Sent Events for watch feed + logs |
| Client | Solid.js + Vite, Dagre layout, SVG |
