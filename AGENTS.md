# Agent guide

Compact navigation aid for AI agents working on this repo. Humans see [README.md](README.md);
ADRs ([docs/ADR/](docs/ADR/)) carry decisions; this file is the "where do I look" sheet.

## Repo at a glance

- Server: `cmd/kd/main.go` (entry) → `internal/server` (router, embed) → `internal/api` (REST+SSE).
- Cache: `internal/kube/store` (dynamic informer per discovered GVR, one factory per context).
- Graph: `internal/kube/graph` — `Build` produces nodes + edges (every relationship) from a cache
  snapshot; `Summarize`/`SummarizeBuilt` roll up to a health digest. The server streams the FULL
  graph; the client projects relationship subsets + grouping itself (no server-side view Filter).
- Auth: `internal/auth` (proxy header) + `internal/rbac` (Casbin-style policy.csv, hot-reloaded).
- Multi-context: `internal/kube/registry` (lazy per-context cache) + `internal/kube/kubeconfig`
  (merged kubeconfig snapshot at startup).
- Client: `web/src/` Solid + Vite. Entry `index.tsx` → `App.tsx`; shared state via signals/stores.

## Where things live

| Concern | File |
| --- | --- |
| Add a grouping layout | `web/src/layout.ts` + dispatch on `groupBy` in `web/src/components/Topology.tsx` |
| Add a kind icon | `web/src/icons.tsx` + extend `icons.test.ts` coverage |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) + alias if not substring |
| Add a graph edge kind | `internal/kube/graph/edges.go` + `EdgeType` in `model.go` + a `web/src/relationships.ts` category |
| Add a CR/CRD health rule | `internal/kube/graph/health_cr.go` (group/kind dispatch) + `health_cr_test.go` |
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

## Verifying UI changes live (agent-browser)

Tests alone miss real UI bugs (coalesced key events, toolbar overflow, focus escapes, a fade that
never fires, a length-encoding that overshoots on real data). For ANY visible/interactive change,
drive the **actual** UI with the **`agent-browser`** CLI (the `agent-browser` skill — NOT ad-hoc
Playwright). Build first; the server embeds the client:

```bash
just build                                                  # MUST rebuild (embed_web) or you test stale JS
pkill -f 'kd -dev-user'; ./kd -dev-user dev -addr :8099 &   # poll /healthz before driving it
```
Then drive it (run agent-browser from `/tmp` — `cd` shifts the persistent shell cwd; keep git/build at
the repo root):
```bash
agent-browser open "http://localhost:8099/?ctx=<ctx>&ns=<ns>&group=nodes" --wait domcontentloaded
sleep 6   # let the SSE graph settle; ~15s for a remote EKS context's FIRST informer sync
agent-browser eval --stdin <<'EOF'        # JS MUST be an IIFE — (() => { ... })() — bare `return` errors
(() => { /* query DOM, dispatch real events, return JSON.stringify(measurements) */ })()
EOF
agent-browser screenshot /tmp/x.png       # then Read the PNG to eyeball layout
agent-browser close
```
- **Measure what you changed**, don't just eyeball it: assert a class applied (`.faded`), a computed
  `fill`/`strokeDasharray`, an element's rect vs the drawer bounds, a count, a left-to-right order. A
  screenshot confirms layout; an `eval` measurement confirms behaviour. Re-test from a **narrow
  viewport** for overflow (the compact drawer caps at ~520px).
- **Dogfood against real data.** kd's merged kubeconfig exposes every context; pointing `?ctx=<arn>` at
  a real cluster hits production-scale shapes (dozens of pods/node, near-zero usages, terminal pods)
  that local `docker-desktop` never reproduces — that is how the capacity-view fidelity/overshoot bugs
  surfaced. NEVER let a real cluster/namespace/ARN name leak into a tracked file (code/test/doc/commit)
  — keep it in the browser session only (see the leakage rule under Conventions).

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

Apply the **four design principles** to every visual change — group **related** info so it reads at a
glance, and make the structure legible without a legend. Each is grounded in a real kd example:

- **Proximity** — related things together, unrelated apart; a number belongs next to what it
  describes. *kd:* each node bar carries its own `value / capacity` label at its right end (not crammed
  beside the node name); each pod container is one card pairing status + image, not two disjoint lists.
- **Alignment** — line elements up on shared edges/baselines so the eye scans one axis. *kd:* every
  node track starts at the same left gutter; the "Req"/"Use" axis labels right-align against the bars.
- **Repetition** — reuse ONE visual language per meaning; don't gratuitously differentiate. *kd:* the
  Req and Use bars share one colour scheme (req is not a lighter shade) so a pod is the same colour on
  both; the same "+N more" pill folds every crowded group across every view.
- **Contrast** — make different things look clearly different and pull the eye to what matters. *kd:*
  the live value is emphasized (`--text`, semibold) while its capacity is dim (`--text-dim`); a
  selected/hovered element stays bright while the rest fade; "other namespaces" is gray vs bright own.

Also:
- **Explicit over implicit** — first-time viewers won't know what a bare colour/shape means; prefer a
  label/text/tooltip over making the operator infer it. *kd:* the "other namespaces" block is a
  *labelled* bar (not just a gray colour); a folded tail says "N small pods — expand to see each".
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
- **Group-by + relationship filter (replaced the fixed views)**: there is no longer a server `View`
  or per-view tab. Two orthogonal, composable client controls drive the canvas: (1) a **group-by**
  segmented control (`GroupBy` = `relationship` | `nodes` | `kind`, default `relationship`) in the
  Topology toolbar selecting the layout — `relationship` → `layoutGraph` LR (depth-column tree, ArgoCD
  parent→child fan-left), `nodes` → `layoutGraphByCapacity` (the capacity & usage visualization, see
  the dedicated note below), `kind` → `layoutGraphByKind`; and (2) **relationship filter** chips
  (`RelCategory` = ownership/network/volumes/rbac/scheduling, `relationships.ts` maps each to
  EdgeTypes, Topology toolbar) that re-project which edges are drawn. `Topology.displayEdges` =
  `projectEdges(props.edges, relFilter)` (reverses `refers` so the referenced provider is the
  parent) and feeds the layout ONLY; `related()`/`ownerName()` keep walking the full `props.edges`
  so selection-spotlight and name-shortening stay relationship-agnostic. Adding a grouping = a new
  `GroupBy` value + a `layout()` case; adding a relationship dimension = a `relationships.ts`
  category. Both group-by and relFilter persist to `localStorage` (`kd:groupBy`, `kd:rels`) and the
  URL (`?group=`, `?rels=`); an empty `?rels=` is a real "no relationships" state, not the default.
  All of these controls — search, Group, Relationships, Health, Kinds — live in ONE control bar
  (`.topology-toolbar`, a full-width translucent strip across the top of the canvas, `left/right: 0`,
  bottom border) as inline-labelled facets in three short `.toolbar-row`s (search+Group,
  Relationships+Health, Kinds) to keep it shallow. The Kinds row is a strict single line
  (`flex-wrap: nowrap; overflow-x: auto`, its facet `.toolbar-facet-grow` fills the bar) so the bar
  height never grows with the kind count — it scrolls horizontally instead. `GROUP_OPTIONS` is
  exported from `Topology.tsx` so App's number-key shortcuts (1–3) + help overlay share one source
  of truth with the segmented control.
- **Nodes capacity view (`layoutGraphByCapacity`)**: the `nodes` group-by is NOT a card layout — it is
  a length-encoded bullet visualization (ADR `20260603-nodes-capacity-usage-visualization.md`).
  Each node is a horizontal track whose length ∝ allocatable capacity on ONE global px-per-unit scale
  (so node sizes compare across the canvas); pods are segments sized by live usage. The layout returns
  a `CapacityLayout` (a `Layout` superset) whose `nodes` are positioned at each pod's usage segment
  (the selection hit-box) + each Node's header, so selection/search/fit work unchanged; `rows` carries
  the bar/segment/bullet geometry the dedicated `cap-view` render branch draws (the generic card `<For>`
  is skipped for `groupBy==='nodes'`). One toolbar facet persisted to `localStorage` (`kd:capRes`):
  **Resource** (`CapResource` = cpu|memory — a single resource at a time, never both on one length
  channel). The bars are always the explicit **Use + Req** stacked form — **Use on top, Req below, BOTH
  the same height** (`CAP_BAR_H`; the user asked they be equal — they read as one channel, the live
  number first), each with a "Use"/"Req" axis label (the overlay/`Use`-only `CapMode` was retired after
  live review — see the ADR Refinements). Key
  behaviours: **collapsed-bar segments draw at EXACT proportional width (`value·scale`, no per-pod
  floor)** so Σwidths = Σvalues and the bar end is the node's true utilization — a per-segment minimum
  (the original "idle pod never vanishes" floor) was the overshoot bug: N near-zero pods each floored to
  `CAP_SEG_FOLD`px tiled past the track (a 940m/31-pod node at 8% use drew ~70%). To keep tiny pods from
  silently vanishing, **healthy** pods that would draw under `CAP_SEG_FOLD` fold via `buildCapBar` into
  ONE `smallUseSeg`/`smallReqSeg` `CapAggregate` (variant `small`) sized by their EXACT summed value —
  one block can't N-inflate; it's hoverable and click-expands the node. The small block is styled like a
  normal segment (accent fill, no border — a dashed outline collided with the selection stroke). A lone
  sub-threshold pod is floored instead; **unhealthy pods never fold** (a problem pod stays individually
  visible with its health colour). Segments are ordered **largest-first by `max(use, request)`**, so a
  bar reads: biggest own segs → small-own fold → gray other-ns fold. The **Req and Use bars share one
  colour scheme** (req is NOT a lighter shade — `.cap-seg.req` carries the same accent/health fills and
  `.selected` stroke as `.cap-seg.use`), so a pod is the same colour on both bars and selection emphasises both.
  The node's TOTAL usage (NodeMetrics) draws as a faint backdrop (non-pod/system overhead context);
  expanding a node (`host:<name>` in `expandedClusters`) unfolds per-pod bullets. **Each pod bullet is
  TWO stacked GAUGES (Use over Req, each `CAP_BULLET_BAR_H` tall, via the module-level `CapGauge`
  component) that BOTH fill with the same value — actual USAGE — and differ only in their reference
  ceiling**: the Use bar gauges usage against the LIMIT (`capUseCeiling` = `lim ?? req ?? use`), the Req
  bar against the REQUEST (`capReqCeiling` = `req ?? lim ?? use`). So each reads "how much of X am I
  using" (`usage / limit`, `usage / request`) — the Req bar shows usage, NOT the request value, which
  was the fix to it reading as always-full. Both bars are a FIXED-length track (`CAP_BULLET_TRACK` = the
  ceiling at 100%) reusing the SAME `.cap-track`/`.cap-seg use|req` classes as the node bars; the pod
  NAME is a header line ABOVE the bars (`CAP_BULLET_NAME_H`) and a `usage / ceiling` label sits past each
  bar (`CAP_BULLET_VALUE_W`), mirroring a node row. (This replaced the earlier variable-length
  `bulletScale` / `cap-bullet-fill` + req-tick idiom.) **Overshoot WRAPS** (`capBulletLaps`): usage past
  the ceiling tiles successive full-width laps left-to-right in escalating colours (lap 1 normal, 2
  amber, 3 orange, 4 red via `.cap-seg.lap-2|3|4`, capped at `CAP_MAX_LAPS`) so it stays inside the fixed
  width — so a pod bursting past its request shows the Req bar wrapping amber, one exceeding its limit
  shows the Use bar wrapping. Each pod's whole two-gauge group is ONE hover/click target (same
  `CapTipData` tooltip as the node-level segments); bullets show ONLY the FULL pod name (numbers are on
  hover). A **cursor-following HTML tooltip** (`capTip`,
  `.cap-tooltip`, fixed-position, enlarged) replaces the native `<title>` and the inline numbers on
  segments/bullets; its payload is normalized (`CapTipData`) so a pod seg and the aggregate share one
  render. **Hover-to-spotlight** (Grafana-style): hovering a segment/bullet sets `capHover` (a pod id or
  `small:<host>`/`other:<host>` marker) which spotlights it and fades the rest via `capSegFaded` /
  `capAggFaded`; with nothing hovered it falls back to `nodeFaded` (selection/search/filter). Aggregates
  fade whenever a specific pod is in focus (hovered/selected/searched/filtered) — fixing a bug where the
  bright accent block stayed lit while individual segments faded. **The whole node row is the
  expand/collapse click target** — a bordered card (`.cap-node-frame`); clicking anywhere that isn't a
  pod segment toggles it (segs/bullets `stopPropagation` so selecting a pod doesn't also toggle). No
  caret — the node name is packed into the card's top-left. **The card width grows to contain its text**
  (SVG `<text>` can't reflow): the header (name + pod count) and every expanded pod name are reserved
  from char-count estimates (`CAP_HEADER_CHAR_W`/`CAP_BULLET_CHAR_W`, header inset `CAP_HEADER_INSET`)
  so nothing overflows the border. **Per-bar totals (proximity):** capacity/use/request are NOT in the
  header — each bar carries a `value / capacity` label (`.cap-bar-value`) just past its right end
  (`84m / 940m` by Use, `910m / 940m` by Req); the header keeps only node identity + pod count.
  `CAP_BAR_VALUE_W` reserves the row width for it.
  - **Terminal pods excluded:** the capacity view shows LIVE utilization, so `buildCapacity` drops
    Succeeded/Failed pods (`stoppedPod` filter on the snapshot, before `graph.Build` and the usage feed)
    — a finished/errored pod reserves and uses nothing, so it must not pad a node's bars or pod count.
    (The topology graph still keeps Failed pods — actionable there; this filter is capacity-specific.)
  - **Cluster-wide by nature (NOT namespace-scoped):** the view draws from a dedicated cluster-wide
    `capacity` SSE event — `{ nodes: KNode[]; usage }` carrying ALL Nodes + ALL Pods (each tagged with
    `namespace`) + per-UID usage — built server-side from `store.SnapshotNodesAndPods()` (the only
    snapshot crossing the per-namespace ride-along boundary). It replaced the old per-namespace `usage`
    event. App holds it in the `capacity` signal (cleared on resubscribe) and passes `capacity` +
    `namespace` to Topology; the layout takes `currentNamespace`. Only the SELECTED namespace's pods
    become individual `CapSeg`s (bright, minus any folded into the small-pods block); every OTHER
    namespace's pod folds into ONE gray `CapAggregate` ("other namespaces") per bar + one per expanded
    bullet — `row.otherUseSeg`/`otherReqSeg`/`otherBullet` — hoverable for folded totals but not
    individually selectable (the `small` and `other` aggregate variants can coexist on one bar). Cluster scope
    (`''`/`__cluster__`) → every pod is own/individual, no aggregate. So cluster scope shows every pod,
    a namespace scope shows its own pods + one folded block, keeping the node total honest. A pod
    selected in cluster scope may not be in the namespace graph, so `App.selectedNode` falls back to
    `capById` (the capacity nodes) for the drawer, and the selection-fit frames the pod's whole node ROW
    (`capRowBoxFor`), not its `related()` subtree. The `capacity` event is re-sent on connect, on each
    debounced graph change, and on the ~15s usage tick; it does NOT auto-fit (fit keys on
    `scope`+`layoutKey`, not the capacity tick).
- **LR depth-column layout (`placeColumns`)**: the LR connectivity views do NOT use Dagre for
  placement — they use strict depth columns. `computeRanks` assigns every node (over the FULL graph,
  not the hub-stripped skeleton) an integer depth = longest path from a source; depth = column, so
  the most-parent resources share the leftmost column, their children the next, etc. A column's WIDTH
  is its widest unit, so a large same-kind group still wraps into a smart grid block (`blockDims`) and
  merely widens its column without breaking any other column's alignment. Vertical order within a
  column is *seeded* from Dagre (run on the skeleton only, via `dagreSeedY`, for its crossing-minimized
  order — its x is discarded), then the column is packed **contiguously** from the topmost unit's seed:
  same-kind neighbours separated by `COL_V_GAP`, different kinds by the wider `BLOCK_GAP`, so every
  kind reads as its own group (the user's "little spacing between kinds"). We anchor only the first
  unit to its seed and pack the rest tight rather than honouring each unit's seedY as a floor — a
  skeleton child (e.g. a StatefulSet seeded at its hub's centre) otherwise punched a tall hole into
  the hub's centred block stack, and adjacent kinds drifted to inconsistent gaps. This replaced the
  old "Dagre lays the skeleton, grids parked next to the hub card" placement, which (a) let a hub's
  wide reserved box shove its card out of its rank, (b) stranded wrapped leaves in a private near-hub
  column instead of their depth column, and (c) dragged a fan-in hub's *source* parents deep next to
  the node they point at (the Volumes "boxes everywhere" report — now every source sits in column 0).
  TB (test/legacy) still uses `placeWithDagre`. Cross-component column alignment is only approximate
  (each component normalizes independently); within a component it is exact.
- **Single-column packing**: `packComponents` stacks every component in one vertical column — one
  tree per row, left-aligned, never two side by side (the user's explicit "all views" arrangement).
  This replaced an earlier viewport-aspect bin-pack; do **not** reintroduce horizontal placement to
  "use the width." Vertical order is stable via `componentKey` (smallest kind/name, not the random
  node UID), so a tree keeps its row as pods churn.
- **Same-kind collapse (`__collapse__`)**: a crowded same-kind cluster shows its newest
  `COLLAPSE_VISIBLE` (=3) by `createdAt` and folds the older remainder behind a synthetic "+N older"
  pill — a `PositionedNode` with `kind === COLLAPSE_KIND` carrying `collapse: CollapseMeta`
  (`layout.ts`). The cluster unit is the kind box (All view) or a hub's
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
- **Fan-out only (`findHubs`)**: only a hub's degree-1 fan-OUT *children* are wrapped into leaf blocks.
  A fan-IN hub's many *parents* (e.g. the dozen Pods that all mount one Secret in Volumes) are NOT
  wrapped/folded — folding a subset of one kind while its siblings stay bare drew a confusing partial
  frame mid-column; left in the skeleton they instead align cleanly in the leftmost depth column.
- **Per-kind hub leaf blocks + frames (`collapseHubLeaves` → `connGroups`)**: a hub's degree-1 leaves
  are grouped **per kind** into separate column blocks (Services together, Secrets together, …), each a
  vertical column laid out by `blockDims` (fills down to `LEAF_COL_MAX` before wrapping) so the kind's
  "+ show N more" pill sits at the *bottom* of its column, vertically aligned under its cards. All blocks of
  one hub sit at a **single depth** (one column in LR; `placeColumns` puts every block at the hub's
  depth ±1 and stacks them down the cross axis, NOT the depth axis — TB's `placeWithDagre` uses
  `placeBlocksTB`), because they are all direct children: depth must not vary by kind, or kinds look
  like different tree levels. Each kind folds
  independently (its own `sib:<hub>:<kind>` pill + bundled edge). Multi-card blocks carry a per-kind
  `collapseGroup` (= the same `sib:` key) so `connGroups` draws one tight dashed grouping frame per
  kind — tight because each kind is a contiguous block, never interleaved (an earlier hub-level frame
  was abandoned once blocks made per-kind bboxes clean). A kind is framed only when it folds (has a
  pill), so the border and the show-more affordance appear together — unfolded kinds stay bare. The frame
  (`.conn-frame`, a `--text-dim` dashed border) turns accent (`.conn-frame.expanded`) when its kind is
  expanded. All/Nodes already box by kind/host, so `connGroups` is empty there (avoids a double border).
- **Scope-keyed auto-fit**: the fit-all effect in `Topology.tsx` keys on `scope` (ctx+namespace)
  and, separately, on a client `layoutKey` (`groupBy` + sorted `relFilter`), NOT node count. A
  node-count key re-fit on every shape change, yanking the viewport back to fit-all whenever the
  operator expanded a collapse cluster or an SSE patch added/removed a pod — both must preserve the
  current pan/zoom. The two triggers differ critically: a real ctx/ns switch resubscribes SSE and
  App resets the graph to empty, so `freshData`/width-0 guards the race (fit only the post-reset
  layout); a group-by/relationship change re-projects the SAME already-present graph with NO
  resubscribe and NO empty frame, so it must set `freshData=true` and fit the next frame
  immediately — gating it behind the width-0 wait would mean the fit never fires. `pendingFit`
  defers until the layout has geometry. A real context/namespace switch OR a grouping/relationship
  change re-fits; churn and expand/refold do not. **One exception (Nodes view):** clicking a node row
  to EXPAND it (`toggleCapRow`) fits the viewport to that row's box — expanding reveals the per-pod
  bullets and makes the row much taller, so the operator is zoomed to the pods they just opened (a tall
  many-pod row fits by zooming OUT, a small row by zooming IN; both are "fit to that node"). The fit
  reads `capRows()` AFTER the toggle (the memo recomputes synchronously, so the box is already the
  expanded geometry) and defers the actual fit one rAF for layout/DOM to settle. COLLAPSING does not
  re-fit (preserves pan/zoom). **Top-bar inset**: the full-width control bar
  overlays the top of the canvas, so `computeFitFor` reads the live `.topology-toolbar` height
  (`toolbarEl` ref) and frames the graph into the area BELOW it — shrinking the usable height and
  pushing the vertical centre down by the bar height — otherwise the topmost cards land hidden
  behind the bar. The `MIN_FIT_SCALE` overflow branch applies the same inset to its `ty` anchor.
- **Cluster-scope sentinel**: namespace `"__cluster__"` (`CLUSTER_SCOPE` / `store.ClusterScope`)
  is treated everywhere as a real namespace by route shape, but expands to the cluster's
  cluster-scoped snapshot server-side. The sidebar pins it above the namespace list.
- **Selection-spotlight edges**: `related()` walks `props.edges`, NOT `layout().edges`. Some
  views (Nodes) drop edges from the layout output — selecting a pod still needs to light its
  Node via the unrouted edge set.
- **PVC → PV edge** (cycle 235): emitted as `EdgeMounts` (not a new edge type) so the existing
  volumes view picks it up automatically. The "Pod → PVC → PV" chain is complete.
- **Orthogonal edge routing (`orthRoute`)**: connectivity views (LR) draw "blocky" edges — every link
  leaves its parent's RIGHT edge and enters its child's LEFT edge, with only horizontal/vertical
  segments (the ArgoCD resource-tree look). Dagre's spline interior is **discarded**; `orthRoute`
  re-routes purely from the two card boxes (forward edge → 3-segment "S" through the empty inter-rank
  gutter; same-row → one straight line; rare back/tight edge → outward stubs + a mid-y lane). This is
  why endpoints sit on the box EDGE now (arrowheads are visible) instead of under the card center, and
  why `cardCenter` was deleted — the positioned hub node already *is* the card center. `edgePath`
  (Topology) rounds each elbow with a clamped quadratic bezier. **Scoped to LR**: the All view (kind
  matrix, `layoutGraphByKind`) keeps straight cross-kind lines — its vertically-stacked columns have no
  parent-left semantics, so right-out/left-in would be wrong there; Nodes view draws no edges.
- **Composing filters**: `nodeFaded` checks selection first (selected node never fades), then
  kind filter, then search ∩ health ∩ related-subtree. Keep that order if you add a new filter.
- **Conventions for new layouts**: add a `layoutGraphBy<Whatever>` to `layout.ts`, dispatch in
  `Topology.tsx`, and add a `<View>Groups()` memo if your layout has named containers (kind
  groups, host groups). Test against fixture node sets in `layout.test.ts`.
