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
just dev         # Go API :9123 + Vite :5173 (proxied)
cd web && npx vitest run    # web tests only (cwd matters: must be web/)
go test ./...                # Go tests only
```

**CWD gotcha**: `npx tsc`/`npx vitest` need to run from `web/` — a compound
`cd web && npx ...` shifts the parent shell's cwd, which then breaks the next call. Always
`cd <repo>/web` before web tooling; git ops from the repo root.

## Conventions

- Conventional Commits, **English**. Commit per coherent slice. Git ops ONLY when explicitly
  asked, or when moving between phases.
- **No machine-local or environment leakage.** Git-tracked files (code, comments, tests, docs)
  and commit messages must read identically on any machine. Never commit machine-local paths
  (`/Users/...`, `/home/...`, home dirs) or machine-global / private-environment state — real
  kubectl context or cluster names, cloud ARNs, account IDs, internal hostnames, private product
  names. Use generic placeholders instead: `<repo>/web` for paths, example identifiers for ARNs
  (AWS's docs account `111122223333`, region `us-west-2`, a neutral cluster name like
  `prod-cluster`). If you need a real value to reproduce something, keep it in gitignored scratch
  (`docs/plans/`), not in a tracked file.
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

- **Proxy auth:** upstream `github.com/motoki317/manifest/.common/traefik-forward-auth` emits `X-Forwarded-User`
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
- **Per-view layout dispatch**: Ownership/Network/Volumes/RBAC all = `layoutGraph` with `'LR'`
  (parent→child fans left-to-right, ArgoCD-style — Ownership was briefly TB and then LR-bin-packed,
  now LR like the rest per user request); Nodes = `layoutGraphByHost` (host-grouped containers, no
  scheduledOn edges drawn); All = `layoutGraphByKind`. Adding a view = adding to `View` type + a
  layout case in `Topology.tsx`.
- **Single-column packing**: `packComponents` stacks every component in one vertical column — one
  tree per row, left-aligned, never two side by side (the user's explicit "all views" arrangement).
  This replaced an earlier viewport-aspect bin-pack; do **not** reintroduce horizontal placement to
  "use the width." Vertical order is stable via `componentKey` (smallest kind/name, not the random
  node UID), so a tree keeps its row as pods churn.
- **Same-kind collapse (`__collapse__`)**: a crowded same-kind cluster shows its newest
  `COLLAPSE_VISIBLE` (=3) by `createdAt` and folds the older remainder behind a synthetic "+N older"
  pill — a `PositionedNode` with `kind === COLLAPSE_KIND` carrying `collapse: CollapseMeta`
  (`layout.ts`). The cluster unit is the kind box (All view), a host's pods (Nodes view), or a hub's
  degree-1 same-kind siblings (connectivity views, where the hidden leaves' hub edges aggregate into
  one bundled hub→pill edge). Expansion is an ephemeral per-cluster signal in `Topology.tsx` keyed
  `kind:`/`host:`/`sib:`. The pill is a **two-way toggle**: collapsed it reads "+ show N more"
  (expands); expanded it stays as "− show N fewer" (refolds) with the bundled edge suppressed — the
  fold is by age but the label deliberately never surfaces "older". Driven by
  `CollapseMeta.expanded`, which `splitByAge` populates by keeping the would-fold set even when
  expanded. Pills are excluded from search/nav and folded back into `kindStats` **only while
  collapsed** (expanded, the cards are real and counted directly — folding back too would
  double-count). It only collapses when it hides ≥2. This is a CLIENT-side, reveal-able fold of
  *live* resources — distinct from the server-side permanent drop of dead ReplicaSets/Pods in
  `graph/build.go` (`isHistorical`).
- **Per-kind hub leaf blocks + frames (`collapseHubLeaves` → `connGroups`)**: a hub's degree-1 leaves
  are grouped **per kind** into separate column blocks (Services together, Secrets together, …), each a
  vertical column laid out by `blockDims` (fills down to `LEAF_COL_MAX` before wrapping) so the kind's
  "+ show N more" pill sits at the *bottom* of its column, vertically aligned under its cards. All blocks of
  one hub sit at a **single depth** (one x in LR / one y in TB — `hubArea` + `placeBlocksLR`/
  `placeBlocksTB` stack them along the cross axis, NOT the depth axis), because they are all direct
  children: depth must not vary by kind, or kinds look like different tree levels. Each kind folds
  independently (its own `sib:<hub>:<kind>` pill + bundled edge). Multi-card blocks carry a per-kind
  `collapseGroup` (= the same `sib:` key) so `connGroups` draws one tight dashed grouping frame per
  kind — tight because each kind is a contiguous block, never interleaved (an earlier hub-level frame
  was abandoned once blocks made per-kind bboxes clean). A kind is framed only when it folds (has a
  pill), so the border and the show-more affordance appear together — unfolded kinds stay bare. The frame
  (`.conn-frame`, a `--text-dim` dashed border) turns accent (`.conn-frame.expanded`) when its kind is
  expanded. All/Nodes already box by kind/host, so `connGroups` is empty there (avoids a double border).
- **Scope-keyed auto-fit**: the fit-all effect in `Topology.tsx` keys on `scope` (ctx+namespace) +
  `viewId`, NOT node count. A node-count key re-fit on every shape change, yanking the viewport back
  to fit-all whenever the operator expanded a collapse cluster or an SSE patch added/removed a pod —
  both must preserve the current pan/zoom. `pendingFit` defers the fit until the new scope's layout
  has geometry (the first SSE frame can land after the scope flips, while width is still 0). A real
  context/namespace/view switch still re-fits; churn and expand/refold do not.
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
