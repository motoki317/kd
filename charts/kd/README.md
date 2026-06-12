# kd Helm chart

Runs [kd](https://github.com/motoki317/kd) — a read-only, ArgoCD-style Kubernetes topology
dashboard — as a single Deployment behind a forward-auth proxy.

```bash
helm install kd ./charts/kd --namespace kd --create-namespace
```

## What it creates

| Resource | Purpose |
| --- | --- |
| `ServiceAccount` + `ClusterRole` + `ClusterRoleBinding` | The one identity kd runs as — wildcard read (`*` `*` `get/list/watch`) so the dynamic-informer factory can discover every API resource the cluster exposes, including CRDs installed at runtime; plus `pods/log`. kd does its own authorization on top. Disable with `rbac.create=false`. |
| `ConfigMap` (`*-policy`) | The declarative `policy.yaml`. Hot-reloaded — edit the policy and re-apply, no restart. Disable with `policy.enabled=false`. |
| `Deployment` + `Service` | The kd server (container `:9123` → Service `:80`), read-only root FS, non-root. |
| `Ingress` *(optional)* | A standard Kubernetes Ingress (`ingress.enabled=true`). |
| `IngressRoute` *(optional)* | A Traefik route behind a forward-auth middleware (`ingressRoute.enabled=true`). |

## Configuration

All values are documented inline in [`values.yaml`](values.yaml) and validated against
[`values.schema.json`](values.schema.json) (regenerate with `just chart-schema`, or
`cd charts/kd && helm schema`).

### Image

Set `image.repository` / `image.tag` to your built reference. The tag defaults to the chart's
`appVersion` when left empty.

### Authorization (policy.yaml)

The `policy.*` values (everything except `policy.enabled`) are rendered into a `policy.yaml`
ConfigMap, mounted into the pod, and hot-reloaded. Three concepts:

- **Roles** bundle access rules. Two are built in: `viewer` (read everything) and `admin`
  (every action). Define your own under `roles`.
- **Users and groups** (the names your auth proxy sends in the identity/groups headers) are
  **assigned roles** under `users` / `groups`. `defaultRoles` is assigned to everyone.
- **Deny beats allow** — always, across all of a caller's roles. The top-level `deny` block
  binds every caller, even admins.

```yaml
policy:
  enabled: true
  # Everyone may read everything; set [] to lock down to explicit assignments.
  defaultRoles: [viewer]

  roles:
    team-a:
      description: Read everything in team-a's namespaces, except pod logs.
      allow:
        - namespaces: [team-a-*]
      deny:
        - namespaces: [team-a-*]
          resources: [logs]
    cluster-viewer:
      description: Read cluster-scoped resources (Nodes, PVs, CRDs, ...), nothing namespaced.
      allow:
        - clusterScoped: true

  users:
    alice: [admin]
  groups:
    platform-team: [admin]
    team-a-developers: [team-a, cluster-viewer]

  # Nobody — not even admins — reads pod logs in the secure namespace.
  deny:
    - namespaces: [secure]
      resources: [logs]
```

Each allow/deny rule scopes where it applies (`namespaces` / `clusterScoped`) and what it
covers (`resources` / `actions`). The list fields hold `*`-glob patterns, and **omitting a
field matches everything** (an explicitly empty list is rejected at load, since it would
match nothing):

- `namespaces` — namespace names, e.g. `[team-a-*]`. A rule that lists namespaces applies
  only to namespaced resources — not even `[*]` reaches cluster scope.
- `clusterScoped: true` — the rule instead targets cluster-scoped resources (Nodes, PVs,
  ClusterRoles, CRDs, cluster-scoped CRs); combining it with `namespaces` is a load error —
  write two rules. A rule with *neither* scope field covers both worlds, which is what makes
  bare `deny` guardrails (and the built-in roles) airtight; `clusterScoped: false` restricts
  such a rule to namespaced resources.
- `resources` — kd's coarse classes `namespaces | workloads | pods | logs | events | rbac |
  nodes`, or an API group name to scope every custom resource in that group (e.g.
  `argoproj.io` covers Workflows, CronWorkflows, …).
- `actions` — `get | list | watch` (kd is read-only; `admin` is future-proofed with `*`).

A policy file that fails to parse — a typo'd key, a reference to an undefined role, an empty
pattern list — is rejected at startup and *ignored* on hot reload (the last good policy stays
active and the error is logged), so a bad edit cannot silently widen access.

### Identity header

kd trusts `X-Forwarded-User` by default (`config.userHeader`). If kd could be reached without going
through the proxy, set `config.trustedProxies` to the proxy's CIDR so a client cannot spoof the
header. Set `config.groupsHeader` to enable group-based policy.

### Auth edge

- **Standard Ingress** (`ingress.enabled=true`): bring your own auth — most operators front kd with
  an auth annotation/middleware on the Ingress.
- **Traefik IngressRoute** (`ingressRoute.enabled=true`): set `ingressRoute.host` and
  `ingressRoute.middlewares` to a forward-auth middleware that emits the identity header, e.g.:

  ```yaml
  ingressRoute:
    enabled: true
    host: kd.example.com
    middlewares:
      - name: auth-admin
        namespace: auth
  ```

## Narrowing the ClusterRole

The default grants wildcard read so dynamic informers can discover CRDs at runtime — the same model
ArgoCD ships with. For a least-privilege footprint, replace `rbac.rules` with an explicit allowlist;
the trade-off is that new CRDs aren't visible until you add them. kd handles missing permissions
gracefully — informers that fail to start log a single throttled warning per (GVR, hour) and the
kind is excluded from snapshots, so a narrow ClusterRole won't flood stderr.

```yaml
rbac:
  rules:
    - apiGroups: [""]
      resources:
        - namespaces
        - nodes
        - pods
        - services
        - configmaps
        - secrets
        - persistentvolumeclaims
        - serviceaccounts
        - events
      verbs: ["get", "list", "watch"]
    # Without this, every usage gauge goes dark: the capacity view's Use bars and the drawer's
    # CPU/memory gauges read live consumption from metrics-server under the same identity.
    - apiGroups: ["metrics.k8s.io"]
      resources: ["pods", "nodes"]
      verbs: ["get", "list"]
    - apiGroups: [""]
      resources: ["pods/log"]
      verbs: ["get"]
    - apiGroups: ["apps"]
      resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
      verbs: ["get", "list", "watch"]
    - apiGroups: ["batch"]
      resources: ["jobs", "cronjobs"]
      verbs: ["get", "list", "watch"]
    - apiGroups: ["networking.k8s.io"]
      resources: ["ingresses"]
      verbs: ["get", "list", "watch"]
    - apiGroups: ["rbac.authorization.k8s.io"]
      resources: ["roles", "rolebindings", "clusterroles", "clusterrolebindings"]
      verbs: ["get", "list", "watch"]
```

## Tuning eager-load

By default kd starts an informer for every discovered kind except the high-cardinality defaults
(`events`, `leases`, `endpoints`, `endpointslices`, `controllerrevisions`, and Kyverno's
`ephemeralreports`):

- `config.skipKinds: "workflows,leases"` — extra resource names to skip, on top of the defaults.
- `config.eagerKinds: "leases"` — resource names to force-include, overriding both the defaults and
  `skipKinds`. (Not useful for `events`: the Events tab always queries the API live — short-lived,
  high-cardinality events are deliberately never cached.)
