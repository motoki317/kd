# Agent guide

Navigation for AI agents. Humans see [README.md](README.md); decisions live in
[docs/ADR/](docs/ADR/); canvas mechanics in [docs/frontend-internals.md](docs/frontend-internals.md);
live debugging in [docs/live-debug.md](docs/live-debug.md).

## Repo map

- Server: `cmd/kd/main.go` → `internal/server` (router/embed) → `internal/api` (REST/SSE).
- Cache: `internal/kube/store` (dynamic informers); contexts: `internal/kube/registry` and
  `internal/kube/kubeconfig` (merged startup snapshot).
- Graph: `internal/kube/graph`; `Build` creates graphs and `Summarize*` creates health digests. The
  server streams the full graph, and the client projects views.
- Auth: `internal/auth`; declarative, hot-reloaded policy: `internal/rbac`.
- Client: `web/src/` (Solid + Vite); `App.tsx` wires `appKeyboard.ts`, `urlState.ts`,
  `graphSubscription.ts`, `clusterSession.ts`, `selection.ts`, and `sidebarHealth.ts`.
  `components/Topology.tsx` owns the SVG canvas; `layout/` holds layouts; `web/src/index.css` orders styles.

## Where things live

| Concern | File |
| --- | --- |
| Add a grouping layout | `web/src/layout/` or `web/src/capacityLayout.ts`; dispatch in `web/src/components/Topology.tsx` |
| Add a kind icon | Add an official Argo CD glyph to `web/scripts/import-k8s-icons.mjs` and regenerate `web/src/k8sIconPaths.ts`, or add a kd glyph in `web/src/icons.tsx`; extend `web/src/icons.test.ts` and preserve `NOTICE` attribution |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) plus an alias when the label is not a substring |
| Add a graph edge kind | `internal/kube/graph/edges.go`, `internal/kube/graph/model.go`, and `web/src/relationships.ts` |
| Surface a kind's declarative essence | `internal/kube/graph/spec_<domain>.go`; recipe in `spec.go` |
| Add a CR/CRD health rule | `internal/kube/graph/health_cr.go`, `internal/kube/graph/health_cr_<family>.go`, and `internal/kube/graph/health_cr_test.go` |
| Touch styles | `web/src/styles/<area>.css`; cascade order is documented in `web/src/index.css` |
| Touch drawer usage gauges | `web/src/resourceBars.ts` → `web/src/components/UsageGauges.tsx`; consumers: `web/src/components/ResourceSummary.tsx`, `web/src/components/ContainerCards.tsx`; rollup: `web/src/usageAggregate.ts`; invariants: "Drawer resource gauges" in `docs/frontend-internals.md` |
| Add an SSE event | `internal/api/sse.go` and `web/src/api.ts` |
| Touch log streaming | `internal/api/logstream.go`; one endpoint `/resources/{kind}/{name}/log/stream` serves pods and controllers — a goroutine per descendant pod fans into one channel drained by a single writer |
| Touch RBAC policy | `internal/rbac/`, `charts/kd/values.yaml`, and `charts/kd/README.md` |
| Record a decision | `docs/ADR/YYYYMMDD-title.md`; template: `docs/ADR/_template.md` |

Client UI work follows [docs/design.md](docs/design.md) and
[docs/client-gotchas.md](docs/client-gotchas.md).

## Build and test

```bash
just build       # Vite build → embedded web → Go build; release authority
just test        # Go tests + npm test
just check       # gofmt, go vet, advisory golangci-lint, project-reference tsc
just dev         # Go API :9123 + proxied Vite :5173
```

- Use `npm test`, NOT bare `npx vitest`; the latter may use a cached Vitest without jsdom.
- Use `npm run typecheck`, NOT bare `tsc --noEmit`; only the former follows project references.
- Run web tools from `web/` and Git from the repo root; a compound `cd web && …` changes later calls' CWD.

## Releases

App tag `vX.Y.Z` publishes image `ghcr.io/motoki317/kd:X.Y.Z` (no `v`). Before tag `chart-vX.Y.Z`,
bump chart `version` first (CI rejects mismatch) and set no-`v` `appVersion` to the image tag. Use the
`release` skill; rationale: `docs/ADR/20260612-release-pipeline.md`.

## Conventions

- Conventional Commits, English, one coherent slice. Git ops only when requested or between phases.
- **No machine-local or environment leakage — this is absolute.** Git-tracked files **and commit
  messages** must read identically on any machine and reveal nothing about the author's clusters.
  NEVER write a locally-visible resource name into the repo — no real namespace, cluster, context,
  node, service, pod, or product name; no cloud ARN, account ID, internal hostname, or
  machine-local path. No exception for the tempting cases that have leaked before: a
  dogfooding/"verified live" note, a **test fixture or its expected value**, a doc example —
  invent a placeholder and use it consistently on both the input and expected side. Use
  clearly-fictional placeholders: `<repo>/web` for paths; AWS docs identifiers (`111122223333`,
  `us-west-2`, `prod-cluster`); invented namespaces/workloads (`team-a`, `api-b`, `shop`). Real
  values stay in gitignored scratch. **Enforced by `internal/leakcheck`** — it derives the real
  names from your kubeconfig; names it can't surface go in a gitignored `.leakcheck` denylist
  (copy `.leakcheck.example`). Run `go test ./internal/leakcheck/` before committing dogfooding
  notes.
- ADRs hold design rationale; comments explain why, never what.
- Use TDD for pure logic (`auth`, `rbac`, graph/layout/store mapping); prefer YAML fixtures for graph tests.
- The client is Solid, not React: `createMemo`/`createEffect`; stores use `createStore` + `reconcile`.

## Live verification

For visible/interactive changes or backend-wire questions, follow [docs/live-debug.md](docs/live-debug.md):
`just demo-up`, `just build`, then the `agent-browser` skill. Measure the changed property with `eval`
and retest narrow viewports; screenshots alone do not prove behavior. Use real clusters only as an
escalation, and never copy their names into tracked files.

## Durable project state

- `docs/backlog.md`: Open and Future work; lifecycle is in the `backlog-management` skill.
- `docs/ADR/`: decisions; `git log`: shipped what and why.
- `docs/frontend-internals.md`, `docs/design.md`, `docs/client-gotchas.md`, `docs/live-debug.md`: focused guides.
- `docs/plans/`: gitignored session scratch only. Long-lived context must be git-tracked.

For self-directed improvement, use the `improvement-cycle` skill and stop when a strict re-survey
finds about zero high-value items.

## Reference facts

- Proxy auth trusts `X-Forwarded-User` from `github.com/motoki317/manifest/.common/traefik-forward-auth`;
  Grafana uses the same header via `auth.proxy`.
- Toolchain: Go 1.26.2, Node 24.14.1 (npm/corepack only), kubectl 1.36.

## Traps

- Plain `go build` serves a placeholder; `just build` sets `embed_web` (`internal/server/assets_*.go`).
- Events are live, not cached: do NOT read them from `SnapshotNamespace` or enable them in the handler
  fixture (`internal/api/events.go`, `internal/api/api_test.go`).
- Graph `nodes` and `edges` are `[]`, never `null`; preserve the server wire guard and defensive client
  reducers (`internal/kube/graph/build.go`, `web/src/graphState.ts`).
