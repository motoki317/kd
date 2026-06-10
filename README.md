# kd — Kubernetes dashboard

See a whole namespace as one picture. kd draws your resources and the links between them, so you can
tell at a glance which Deployment owns which Pods, what mounts a Secret, or why a Pod won't start —
without running a dozen `kubectl` commands.

It's read-only and live. It watches the cluster and updates as things change, and there's no login to
set up.

![A namespace as one picture: Ingress → Services → Pods ← ReplicaSets ← Deployments, with a Service's details open](docs/screenshot.png)

## Features

### Views

You arrange the canvas yourself. Switch how resources are grouped:

- **Relationship** — an ArgoCD-style tree, children fanning out from their parents.
- **Nodes** — bars sized by capacity and usage, to see where resources actually go. Pods bursting
  past their requests or running near their limits are flagged on the bar.
- **Kind** — every resource boxed by type.

Then pick which links to draw: ownership, network, volumes, RBAC, or disruption. Custom resources show
up too — Workflows, Certificates, ArgoCD Applications, and anything else a CRD defines, down to their
Pods. Unhealthy resources stand out in color, and troubled namespaces sort to the top.

### Resource details

Click a resource to open its details. The summary answers "what is this and how is it doing" without
opening the manifest: status with its reason, container states, live CPU/memory gauges against
requests and limits, and each kind's defining facts — a Service's selector and endpoints, an Ingress's
routes, a ConfigMap's keys, a Node's taints. Tabs carry live logs (multi-container streams merged and
labelled, previous-crash output, level and text filters), recent events rolled up from the resource's
children, and the raw manifest (YAML or JSON, with in-pane find). Owner chips walk up the tree, and
the panel expands when log lines need the room.

### Search and sharing

Search by name, kind, label, image, status, host, or IP. The current view lives in the URL, so you can
share a link to exactly what you're looking at.

Works where you are: full keyboard control on a desktop (press `?` for the reference), and a
phone-sized layout — panels overlay the canvas, drag to pan, pinch to zoom — for checking a page
from wherever it finds you.

## Run it

You need Go 1.26+, Node 24+, and a working `kubectl` context. With Nix, `nix develop` sets up the tools.

```bash
just dev   # API on :9123, web on :5173 — open http://localhost:5173
```

To run the real binary against your kubeconfig, build it and start it:

```bash
just build
./kd
```

With no proxy auth configured, kd starts read-only as a `dev` user, so this just works. Run `just` to
see every command.

## Deploy

```bash
docker build -t <ref> .                                      # one static image, web embedded
helm install kd ./charts/kd --namespace kd --create-namespace  # read-only Deployment behind a forward-auth proxy
```

kd has no login of its own. It trusts a user header (`X-Forwarded-User`) from your proxy and checks
access with a `policy.csv` file (ArgoCD/Casbin style, reloaded when it changes). See
[charts/kd/README.md](charts/kd/README.md) for the full setup and every value.

## How it works

One Go binary watches every resource type — CRDs included — with a client-go cache, builds the
relationship graph on the server, and serves it to a Solid.js + SVG web app over REST and SSE. Design
decisions are written up in [docs/ADR/](docs/ADR/).
