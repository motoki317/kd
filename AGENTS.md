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

## Verifying UI changes live

Tests alone miss real UI bugs (coalesced key events, toolbar overflow, focus escapes). For any
visible/interactive change, drive the **actual** UI:

```bash
just build                                 # MUST rebuild — the server embeds the client (embed_web)
pkill -f 'kd -dev-user'; ./kd -dev-user dev -addr :8099 &   # poll /healthz before driving it
```
- Playwright via `playwright-core` (scripts in `/tmp/pw`), `chromium.launch({ channel: 'chrome' })`,
  `goto(url, { waitUntil: 'domcontentloaded' })`, then `waitForTimeout(4500)` for the SSE graph to settle.
- Dispatch real events and **measure what you changed**: a class applied, the `<g transform>` scale,
  an element's rect vs the drawer bounds, a line count. Re-test from a narrower viewport for
  layout/overflow (the compact drawer caps at ~520px).
- `cd` shifts the persistent shell cwd — run node/playwright from `/tmp/pw`, git/build from repo root.

## Client UI gotchas (Solid / SVG / jsdom)

- **Eager `createMemo`**: it runs on creation, so referencing a memo/`const` declared *later* throws
  (TDZ). Read the underlying `props.x` directly, or declare in dependency order.
- **Signals commit synchronously**: a discrete handler (keypress) that `set`s then reads sees the new
  value at once — so apply repeated keyboard actions *instantly*, not via an animation that eases from
  the lagging signal, or rapid presses coalesce into one step.
- `on(dep, fn, { defer: true })` skips the initial run; wrap DOM reads in `queueMicrotask` when you
  need a just-set reactive class committed first. `ref={varName}` assigns the element to `varName`.
- **SVG**: `<text>` ignores CSS `text-overflow` (truncate in JS); markers default to
  `markerUnits="strokeWidth"` so arrowheads scale with a zoomed stroke; a `stroke="transparent"` wide
  path still receives pointer events — use it as a fat invisible hit target over a thin line.
- **CSS**: a two-class selector out-specifies a one-class one (no `!important`); gate animations behind
  `@media (prefers-reduced-motion: reduce)`; persist display prefs in `localStorage` under `kd:*` keys.
- **jsdom test limits**: `offsetParent` is always null (focus traps / visibility filters can't be
  exercised — assert the DOM contract instead), `scrollIntoView` and `Element.animate` are missing
  (stub them), `getBoundingClientRect` returns zeros, and `animationend` never fires (assert the class
  was *added*, not auto-removed). For these, unit-test the contract and verify the behavior live.

## UI design principles (user-stated)

- Group **related** info into one visual block so it reads at a glance — apply the four design
  principles (proximity, alignment, repetition, contrast). E.g. each pod container is one card pairing
  status + image, grouped Init/app with counts — not two disjoint lists.
- **Avoid icon-only UI** — users won't reliably know what bare icons mean. Use icons *with* text, a
  text label, or a segmented control; if a control row overflows, compact it or relocate it.

## Where durable state lives (docs layout)

Long-lived context must be **git-tracked** so it survives across agents and is visible to humans —
never parked in gitignored scratch:

- **`docs/backlog.md`** (git-tracked) — the persistent improvement backlog: open items, future/larger
  work, and a "rejected — do not re-propose" list. The single home for improvement tasks.
- **`docs/ADR/`** (git-tracked) — dated decision records; design rationale lives here, not in comments.
- **git log** — the authoritative per-change "what + why" (Conventional Commits, one per slice).
- **`docs/plans/`** (gitignored) — **volatile, single-session scratch only.** An agent may use it for
  working notes during one session; it is NOT durable and must not hold the backlog or long-term tasks.

For self-directed improvement work ("improve the UX", "find things to improve", work the backlog), use
the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`): discover (code + web) →
adversarially verify each candidate against the real code → implement one → verify live → test →
commit → log. The **`backlog-management`** skill defines the backlog format + lifecycle. Stop
generating when a strict re-survey yields ≈0 high-value items (the UX surface hit that at cycle 339).

## Reference facts (deployment environment)

- **Proxy auth:** upstream `motoki317-manifest/.common/traefik-forward-auth` emits `X-Forwarded-User`
  (the header kd trusts); Grafana consumes the same via `auth.proxy` in `monitor/values-grafana.yaml`.
- **ArgoCD RBAC** (pattern kd's policy.csv mirrors): `argocd/values.yaml` → `policy.default:
  role:readonly`, plus `g, <uuid>, role:admin` group bindings.
- **Toolchain:** go 1.26.2, node v24.14.1 (no pnpm/bun — use npm or corepack), kubectl v1.36, dev kube
  context `docker-desktop`.

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
- **PVC → PV edge** (cycle 235): emitted as `EdgeMounts` (not a new edge type) so the existing
  volumes view picks it up automatically. The "Pod → PVC → PV" chain is complete.
- **Composing filters**: `nodeFaded` checks selection first (selected node never fades), then
  kind filter, then search ∩ health ∩ related-subtree. Keep that order if you add a new filter.
- **Conventions for new layouts**: add a `layoutGraphBy<Whatever>` to `layout.ts`, dispatch in
  `Topology.tsx`, and add a `<View>Groups()` memo if your layout has named containers (kind
  groups, host groups). Test against fixture node sets in `layout.test.ts`.
