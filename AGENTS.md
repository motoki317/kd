# Agent guide

Compact navigation aid for AI agents working on this repo. Humans see [README.md](README.md);
ADRs ([docs/ADR/](docs/ADR/)) carry decisions; this file is the "where do I look" sheet.

## Repo at a glance

- Server: `cmd/kd/main.go` (entry) → `internal/server` (router, embed) → `internal/api` (REST+SSE).
- Cache: `internal/kube/store` (dynamic informer per discovered GVR, one factory per context).
- Graph: `internal/kube/graph` — `Build` produces nodes + edges from a cache snapshot; `Filter`
  projects onto a view; `Summarize`/`SummarizeBuilt` roll up to a health digest.
- Auth: `internal/auth` (proxy header) + `internal/rbac` (Casbin-style policy.csv, hot-reloaded).
- Multi-context: `internal/kube/registry` (lazy per-context cache) + `internal/kube/kubeconfig`
  (merged kubeconfig snapshot at startup).
- Client: `web/src/` Solid + Vite. Entry `index.tsx` → `App.tsx`; shared state via signals/stores.

## Where things live

| Concern | File |
| --- | --- |
| Add a new view layout | `web/src/layout.ts` + dispatch in `web/src/components/Topology.tsx` |
| Add a kind icon | `web/src/icons.tsx` + extend `icons.test.ts` coverage |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) + alias if not substring |
| Add a graph edge kind | `internal/kube/graph/edges.go` + `EdgeType` in `model.go` + view spec |
| Add an SSE event | `internal/api/sse.go` (server) + `web/src/api.ts` (client handler) |
| Touch RBAC policy | `internal/rbac/` + sample `policy.csv` in `deploy/policy-configmap.yaml` |
| ADR for a decision | `docs/ADR/YYYYMMDD-title.md` (template at `_template.md`) |

## Build / test

```bash
just build       # vite build → embed → go build
just test        # go test + npm test
just dev         # Go API :8080 + Vite :5173 (proxied)
cd web && npx vitest run    # web tests only (cwd matters: must be web/)
go test ./...                # Go tests only
```

**CWD gotcha**: `npx tsc`/`npx vitest` need to run from `web/` — a compound
`cd web && npx ...` shifts the parent shell's cwd, which then breaks the next call. Always
`cd <repo>/web` before web tooling; git ops from the repo root.

## Conventions

- Conventional Commits, **English**. Commit per coherent slice. Git ops ONLY when explicitly
  asked, or when moving between phases.
- ADRs are dated `YYYYMMDD-title.md`; design rationale lives there, not in comments.
- TDD for pure logic (`auth`, `rbac`, `graph`, layout, store mapping). Fixture-driven where
  possible (`graph_test.go` decodes YAML into runtime objects).
- Code comments explain WHY (non-obvious decisions, hidden constraints) — never WHAT.
- The client is Solid, not React. `createMemo` / `createEffect` (no `useEffect`). Stores via
  `createStore` + `reconcile` for SSE patches.

## Working state

The roadmap and per-cycle log live in `docs/plans/master-plan.md` and `docs/plans/ux-cycles.md`
(both gitignored). Update them as cycles land — they're the durable state across compactions.

## Common surprises

- **`embed_web` build tag**: the default `go build` does NOT embed the client (placeholder
  page). `just build` sets the tag.
- **SSE `summary` event** (cycle 201): server emits a per-stream `summary` computed on the
  UNFILTERED graph; the client overrides the sidebar entry with that. Never roll up filtered
  nodes on the client — the bug fix is the whole reason `rollupHealth` was deleted.
- **Per-view layout dispatch** (cycles 205–207): Ownership = TB; Network/Volumes/RBAC = LR;
  Nodes = `layoutGraphByHost` (host-grouped containers, no scheduledOn edges drawn); All =
  `layoutGraphByKind`. Adding a view = adding to `View` type + a layout case in `Topology.tsx`.
- **Cluster-scope sentinel**: namespace `"__cluster__"` (`CLUSTER_SCOPE` / `store.ClusterScope`)
  is treated everywhere as a real namespace by route shape, but expands to the cluster's
  cluster-scoped snapshot server-side. The sidebar pins it above the namespace list.
- **Selection-spotlight edges**: `related()` walks `props.edges`, NOT `layout().edges`. Some
  views (Nodes) drop edges from the layout output — selecting a pod still needs to light its
  Node via the unrouted edge set.
