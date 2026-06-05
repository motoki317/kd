# kd — Kubernetes dashboard

See a whole namespace as one picture. kd draws your resources and the links between them, so you can
tell at a glance which Deployment owns which Pods, what mounts a Secret, or why a Pod won't start —
without running a dozen `kubectl` commands.

It's read-only and live. It watches the cluster and updates as things change, and there's no login to
set up.

<!-- TODO: hero screenshot / short demo gif of the topology view -->

## Features

### Views

You arrange the canvas yourself. Switch how resources are grouped:

- **Relationship** — an ArgoCD-style tree, children fanning out from their parents.
- **Nodes** — bars sized by capacity and usage, to see where resources actually go.
- **Kind** — every resource boxed by type.

Then pick which links to draw: ownership, network, volumes, RBAC, or scheduling. Custom resources show
up too — Workflows, Certificates, ArgoCD Applications, and anything else a CRD defines, down to their
Pods. Unhealthy resources stand out in color, and troubled namespaces sort to the top.

<!-- TODO: gif showing the group-by switch and relationship filters -->

### Resource details

Click a resource to open its details: live logs (tail, per-container, previous crash, filter), recent
events, and the raw manifest.

### Search and sharing

Search by name, kind, label, image, status, host, or IP. The current view lives in the URL, so you can
share a link to exactly what you're looking at.

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
docker build -t <ref> .     # one static image, web embedded
kubectl apply -k deploy/    # read-only Deployment behind a forward-auth proxy
```

kd has no login of its own. It trusts a user header (`X-Forwarded-User`) from your proxy and checks
access with a `policy.csv` file (ArgoCD/Casbin style, reloaded when it changes). See
[deploy/README.md](deploy/README.md) for the full setup.

## How it works

One Go binary watches every resource type — CRDs included — with a client-go cache, builds the
relationship graph on the server, and serves it to a Solid.js + SVG web app over REST and SSE. Design
decisions are written up in [docs/ADR/](docs/ADR/).
