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
| `ConfigMap` (`*-policy`) | The declarative `policy.csv`. Hot-reloaded — edit `policy.csv` and re-apply, no restart. Disable with `policy.enabled=false`. |
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

### Authorization (policy.csv)

`policy.csv` is mounted into the pod and hot-reloaded. ArgoCD-style grammar:

```
p, <subject>, <namespace-glob>, <resource>, <action>, <effect>
g, <subject>, <role>
```

Subjects are usernames/groups from the identity header, or `role:*` tokens. Resources:
`namespaces | workloads | pods | logs | events | rbac | nodes | *`. Actions: `get | list | watch`.
Effect: `allow | deny` (deny overrides). Built-in roles `role:readonly` and `role:admin` always
exist; `config.defaultRole` is the role every authenticated user implicitly has — set it empty to
lock the cluster down (explicit grants only).

> The `*` namespace glob also matches the cluster pseudo-namespace (Nodes, PVs, ClusterRoles, CRDs,
> cluster-scoped CRs); narrow with explicit per-namespace rules if a user should only see
> namespaced resources.

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
        - endpoints
        - configmaps
        - secrets
        - persistentvolumeclaims
        - serviceaccounts
        - events
      verbs: ["get", "list", "watch"]
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
- `config.eagerKinds: "events"` — resource names to force-include, overriding both the defaults and
  `skipKinds`. Useful to feed the events view from cache rather than on-demand requests.
