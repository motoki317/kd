# Deploying kd

A kustomize base that runs kd as a single read-only Deployment behind a forward-auth proxy.

```bash
kubectl apply -k deploy/
```

## What it creates

| Resource | Purpose |
| --- | --- |
| `Namespace kd` | Holds the deployment. |
| `ServiceAccount kd` + `ClusterRole kd-readonly` | The one identity kd runs as — read verbs only, plus `pods/log`. kd does its own authorization on top (see the access-model ADR). |
| `ConfigMap kd-policy` | The declarative `policy.csv` and `policy.default`. Hot-reloaded; edit and re-apply, no restart. |
| `Deployment` + `Service kd` | The kd server (`:8080` → Service `:80`), read-only root FS, non-root. |
| `IngressRoute kd` | Traefik route behind the `auth-admin` forward-auth middleware, which injects `X-Forwarded-User`. |

## Before applying

- **Image:** set `deployment.yaml`'s `image:` to your built tag (`docker build -t <ref> .`).
- **Policy:** edit `policy-configmap.yaml` for your users/groups. The defaults grant `toki` and
  the `kube-admins` group admin, scope an `app-team` group to `team-a-*`/`team-b-*`, and deny pod
  logs in `secure`. Set `policy.default` to empty to lock the cluster down (explicit grants only).
- **Auth edge:** `ingressroute.yaml` mirrors the Grafana setup (forward-auth → `X-Forwarded-User`).
  Change the host and middleware to match your cluster. If kd could be reached without the proxy,
  also pass `--trusted-proxies=<CIDR>` so a client cannot spoof the identity header.

## Identity header

kd defaults to trusting `X-Forwarded-User`. Override with `--user-header` / `--groups-header`
(or `KD_USER_HEADER` / `KD_GROUPS_HEADER`) to match your proxy.
