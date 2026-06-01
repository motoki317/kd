# Deploying kd

A kustomize base that runs kd as a single read-only Deployment behind a forward-auth proxy.

```bash
kubectl apply -k deploy/
```

## What it creates

| Resource | Purpose |
| --- | --- |
| `Namespace kd` | Holds the deployment. |
| `ServiceAccount kd` + `ClusterRole kd-readonly` | The one identity kd runs as — wildcard read (`*` `*` `get/list/watch`) so the dynamic-informer factory can discover every API resource the cluster exposes, including CRDs installed at runtime; plus `pods/log`. kd does its own authorization on top (see the access-model ADR). |
| `ConfigMap kd-policy` | The declarative `policy.csv` and `policy.default`. Hot-reloaded; edit and re-apply, no restart. |
| `Deployment` + `Service kd` | The kd server (`:9123` → Service `:80`), read-only root FS, non-root. |
| `IngressRoute kd` | Traefik route behind the `auth-admin` forward-auth middleware, which injects `X-Forwarded-User`. |

## Before applying

- **Image:** set `deployment.yaml`'s `image:` to your built tag (`docker build -t <ref> .`).
- **Policy:** edit `policy-configmap.yaml` for your users/groups. The defaults grant `toki` and
  the `kube-admins` group admin, scope an `app-team` group to `team-a-*`/`team-b-*`, and deny pod
  logs in `secure`. Set `policy.default` to empty to lock the cluster down (explicit grants only).
  Note that the `*` namespace glob now also matches the cluster pseudo-namespace (Nodes, PVs,
  ClusterRoles, CRDs, cluster-scoped CRs); narrow with explicit per-namespace rules if a user
  should only see namespaced resources.
- **Auth edge:** `ingressroute.yaml` mirrors the Grafana setup (forward-auth → `X-Forwarded-User`).
  Change the host and middleware to match your cluster. If kd could be reached without the proxy,
  also pass `--trusted-proxies=<CIDR>` so a client cannot spoof the identity header.

## Identity header

kd defaults to trusting `X-Forwarded-User`. Override with `--user-header` / `--groups-header`
(or `KD_USER_HEADER` / `KD_GROUPS_HEADER`) to match your proxy.

## Narrowing the ClusterRole

The default `kd-readonly` grants wildcard read across the cluster so dynamic informers can
discover CRDs at runtime — same model ArgoCD ships with. For a least-privilege footprint
you can replace the rules block with the pre-CRD allowlist below; the trade-off is that
new CRDs aren't visible until you add them here.

```yaml
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

kd handles the missing-permission case gracefully — informers that fail to start log a
single throttled warning per (GVR, hour) and the kind is excluded from snapshots — so a
narrow ClusterRole won't flood your stderr.

## Tuning eager-load

By default kd starts an informer for every discovered kind except the four high-cardinality
defaults (`events`, `leases`, `endpointslices`, `controllerrevisions`). Override via flags:

- `--skip-kinds=workflows,leases` — comma-separated resource names to skip in addition to the defaults.
- `--eager-kinds=events` — comma-separated resource names to force-include, overriding both
  the defaults and `--skip-kinds`. Useful if you want the events view to feed from cache
  rather than on-demand requests.

Same names accept env vars: `KD_SKIP_KINDS`, `KD_EAGER_KINDS`.
