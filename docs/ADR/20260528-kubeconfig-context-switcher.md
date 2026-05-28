---
date: "2026-05-28"
author: "@motoki317"
status: "accepted"
---

# Context

Before this change kd bound to exactly one Kubernetes cluster at process start:
`cmd/kd/main.go` built a single `kubernetes.Interface`, fed it to one shared `store.Cache`,
and every API handler read from that one cache. Switching clusters during local development
meant either running `kubectl config use-context <name>` (which mutates the host's global
kubeconfig and disrupts other tooling) or restarting kd against a different `--kubeconfig`
file. Neither fits the "open the dashboard, look at another cluster" workflow operators
already have with `kubectl`/`k9s`.

The deployed mode (in-cluster ServiceAccount, see
[20260527-kubernetes-access-model.md](20260527-kubernetes-access-model.md)) by definition
talks to exactly one API server and has no notion of contexts — any multi-context UI must be
invisible there.

# Decision

When kd is run against a local kubeconfig, expose the kubeconfig's contexts in the topbar and
let the user switch between them. Each accessed context gets its own informer cache, built
lazily on first access and kept warm for the rest of the process lifetime.

Concrete shape:

- `internal/kube/kubeconfig` exposes a snapshot of the merged kubeconfig (contexts,
  current-context) and a `RESTConfig(name)` builder using `clientcmd.ConfigOverrides`.
- `internal/kube/registry.Registry` maps context name → `*store.Cache`, single-flight on
  first access, with per-context `Status` (`pending`/`syncing`/`ready`/`error`) surfaced
  through `List()`.
- `internal/api` re-prefixes every namespaced route under `/api/v1/contexts/{ctx}/...` and
  adds `GET /api/v1/contexts`. Handlers resolve their per-request `Store` from the registry.
- Client: the active context lives in the URL as `?ctx=`, alongside the existing `?ns=` /
  `?view=` / `?sel=`. The `ContextSwitcher` topbar component is hidden when the API reports
  `enabled: false` (in-cluster mode) or when fewer than two contexts exist.
- In-cluster mode keeps exactly one cache under the sentinel context name `in-cluster`. The
  API still routes through `/api/v1/contexts/in-cluster/...` so the server has a single code
  path; the client uses the default from `GET /api/v1/contexts` and never shows a switcher.
- Only the default context's cache is pre-warmed at process start. Other contexts pay a
  one-time informer sync the first time the user selects them.

# Consequences

- Local users get one-click cluster switching without mutating their host's `current-context`
  or restarting kd.
- The deployed in-cluster experience is unchanged in shape (one cluster, no switcher) and one
  small URL-path migration away from the previous routes.
- The registry is a clean seam for future work: a per-cluster `policy.csv`, an allowlist flag
  to hide noisy kubeconfig entries, or a kubeconfig file watcher could all plug in here
  without rewiring handlers.

# Impact

- **Memory.** O(active contexts × cached cluster state). In the typical 2–3-context local
  workflow this is comfortable; pointing kd at a 50-context kubeconfig and visiting each
  context would cost roughly that many informer caches. Out of scope to bound this in v1.
- **Startup time.** Unchanged: the default context still pre-warms at boot, others sync
  lazily.
- **Hard route migration.** `/api/v1/namespaces/...` is gone, replaced by
  `/api/v1/contexts/{ctx}/namespaces/...`. The kd web client is the only known consumer of
  this API; no compatibility alias is provided.
- **Cross-cluster authz.** `policy.csv` continues to apply uniformly across every context.
  Operators wanting per-cluster permissions are not served by v1 (see Alternatives).
- **Error surface.** A context whose cache build fails (expired exec-plugin token, unreachable
  cluster, …) appears in `List()` with the raw client-go error string. This is intentional —
  the feature is local-dev only by definition, and the raw message tells the operator what to
  fix. The in-cluster mode never exposes this path.

# Alternatives

- **Single cache, rebuild on switch.** Lower memory but a switch would stall every open tab
  for the sync window and disrupt in-flight SSE streams across users. Rejected on UX.
- **`--context` flag at startup.** A minimal change but still requires a restart per cluster
  and offers no in-app affordance. The switcher subsumes it; if someone wants single-context
  mode, they curate `kubectl config view --minify --flatten --context=<name>` into a separate
  kubeconfig.
- **Per-context `policy.csv`.** Considered for v1 and deferred. The current usage is single-
  cluster-per-process; the multi-context surface here is local-dev. When this hits production
  multi-cluster deployments we'll layer per-context policy on top of the registry.
- **Kubeconfig file watcher.** Considered and deferred to keep v1 simple. Token rotation via
  exec plugins continues to work inside an already-built client; restarts pick up new
  contexts. A future watcher would need to invalidate a cache's informers on change, which
  affects open SSE streams — non-trivial.

# Notes

- The registry's `NewWithBuilder` constructor is exported so tests (and any future custom
  client factories — impersonation, a fake clientset for integration tests) can inject a
  builder without going through `kubeconfig.Loader`. `NewKubeconfig` is the production path.
- `api.FromRegistry` is a small adapter that bridges `*registry.Registry.Get` (returns
  `*store.Cache`) to the `api.Contexts` interface (returns `api.Store`). Go's nominal typing
  needs the explicit method shim even though the structural shape already matches.
