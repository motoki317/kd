# Frontend internals — topology canvas

Deep mechanics of how `web/src/` draws the SVG topology: layouts, collapse, edge routing, and
viewport fit. AGENTS.md is the nav sheet and lists the *surprising* one-liners; this file holds the
canvas internals an agent needs **only when changing the layout/render path**. Design rationale for
the big surfaces lives in ADRs — this file is the "how it works / what will bite you" companion.

- Capacity view → [`ADR 20260603-nodes-capacity-usage-visualization`](ADR/20260603-nodes-capacity-usage-visualization.md)
- Group-by + relationship filter → [`ADR 20260603-unified-view-relationship-filter-grouping`](ADR/20260603-unified-view-relationship-filter-grouping.md)
- Viewport fit math vs headless animation → [`ADR 20260605-testing-view-math-vs-headless-animation`](ADR/20260605-testing-view-math-vs-headless-animation.md)

Key files: `layout.ts` (relationship/kind layouts + shared geometry), `capacityLayout.ts` (the Nodes
view — imports only `byName`/`Layout`/`PositionedNode` from `layout.ts`, no cycle),
`relationships.ts` (RelCategory → EdgeTypes), `Topology.tsx` (dispatch + render + fit).

## Group-by + relationship filter

Two orthogonal, composable client controls replaced the old fixed server-side views (no server
`View`/Filter; the server streams the FULL graph). See the ADR for the why; the mechanics:

- **Group-by** (`GroupBy = relationship | nodes | kind`, default `relationship`) selects the layout:
  `relationship` → `layoutGraph` (LR depth-column tree), `nodes` → `layoutGraphByCapacity`,
  `kind` → `layoutGraphByKind`. Add a grouping = new `GroupBy` value + a `layout()` case in
  `Topology.tsx`. `GROUP_OPTIONS` is exported from `Topology.tsx` so App's number-key shortcuts (1–3)
  + help overlay share one source of truth with the segmented control.
- **Relationship filter** chips (`RelCategory = ownership/network/volumes/rbac/scheduling`,
  `relationships.ts` maps each → EdgeTypes) re-project which edges are drawn. Add a dimension = a new
  `relationships.ts` category. The `scheduling` id is labelled **"Disruption"** and maps to `guards`
  only — `scheduledOn` (pod→Node) is deliberately surfaced by NO category, since the Nodes group-by is
  its richer home (it builds pod↔node from the capacity feed, not from projected edges).
- `Topology.displayEdges = projectEdges(props.edges, relFilter)` (reverses `refers` so the referenced
  provider is the parent) feeds the **layout only**; `related()`/`ownerName()` keep walking the full
  `props.edges` so selection-spotlight and name-shortening stay relationship-agnostic.
- Persistence: group-by and relFilter round-trip through `localStorage` (`kd:groupBy`, `kd:rels`) and
  the URL (`?group=`, `?rels=`). An empty `?rels=` is a real "no relationships" state, not the default.
- **One control bar.** Search, Group, Relationships, Health, Kinds all live in `.topology-toolbar` (a
  full-width translucent strip across the canvas top, `left/right: 0`, bottom border) as inline-labelled
  facets in three short `.toolbar-row`s. The Kinds row is a strict single line
  (`flex-wrap: nowrap; overflow-x: auto`, facet `.toolbar-facet-grow`) so the bar height never grows
  with the kind count — it scrolls horizontally.

## Nodes capacity view (`layoutGraphByCapacity`)

The `nodes` group-by is a **length-encoded bullet visualization**, not a card layout. The
[ADR](ADR/20260603-nodes-capacity-usage-visualization.md) is the authoritative design record
(encoding choice, the per-segment-minimum overshoot bug, the cluster-wide data flow, every live
refinement). What an agent editing it must keep in mind:

**Invariants (don't regress these):**
- **One global linear px-per-unit `scale`** keyed on the larger of max node capacity and max row
  demand, so node *and* pod bars compare across the canvas and a pod bar reads directly against its
  node track. `CAP_TRACK_MAX` (1080px) keeps a node a few× smaller than the biggest still readable.
  Demand participates because the Unscheduled bucket has no capacity: a pending pod requesting more
  than the biggest node otherwise drew its track kilopixels off-canvas and poisoned the auto-fit
  (the node rows shrinking in proportion IS the honest picture).
- **Two ceilings ⇒ two track lengths** on that one scale: **Req** fills to allocatable
  (`row.cap`/`trackW`), **Use** fills to total physical capacity (`row.useCap`/`useTrackW`, ≥ allocatable
  — usage can spill into the system-reserved region; requests can't). Capacity from structured
  `KNode.capacityRes`; falls back to allocatable when unreported (tracks coincide).
- **Collapsed segments draw at EXACT proportional width** (`value·scale`, no per-pod floor) so
  Σwidths = Σvalues and the bar end is true utilization. A per-segment minimum was the overshoot bug
  (N near-zero pods tiling past the track). Tiny **healthy** pods fold into ONE `small` `CapAggregate`
  sized by exact summed value; a lone sub-threshold pod is floored; **unhealthy and near-limit pods
  never fold** — problems stay individually visible.
- **Risk states survive any segment width:** bursting (use > request) is a hatch overlay
  (`.cap-burst-overlay`); near-limit (use ≥ 90% of limit — the urgent one) draws a FIXED-SIZE red
  notch above the segment (`.cap-near-marker` — the `.near` outline stroke alone vanishes at a few
  px), and the hover tooltip words both states ("near its CPU limit — throttling" / "using more than
  it requested").
- **Use + Req bars share ONE colour scheme and ONE height** (`CAP_BAR_H`, Use on top): a pod is the
  same colour on both, selection emphasises both. Segments ordered largest-first by `max(use, request)`.
- **Per-bar totals (proximity):** each bar carries its own `value / capacity` label past its right end
  (`.cap-bar-value`); the header keeps only node identity + pod count.
- **Cluster-wide by nature.** Draws from a dedicated cluster-wide `capacity` SSE event
  (`{ nodes: KNode[]; usage }`, ALL nodes + ALL pods tagged with namespace + per-UID usage) built from
  `store.SnapshotNodesAndPods()`. Only the SELECTED namespace's pods are bright/individual; every other
  namespace folds into a gray `other` `CapAggregate` per bar. Cluster scope → every pod individual.
- The node's TOTAL usage (NodeMetrics) is a faint `.cap-track-nodeuse` backdrop on the Use bar; its
  hover shows only the **overhead** (`max(0, nodeUse − useTotal)` = non-pod/system). The Use bar's right
  label is `max(useTotal, nodeUse)` (own-ns pod sum undercounts when other namespaces + overhead run on
  the node).
- **Terminal pods excluded** (`stoppedPod` filter in `buildCapacity`, server-side) — a finished pod
  reserves/uses nothing. The topology graph still keeps Failed pods (actionable there).

**Render path:** `layoutGraphByCapacity` returns a `CapacityLayout` (a `Layout` superset); `nodes` are
positioned at each pod's usage segment (selection hit-box) + each Node header, so selection/search/fit
work unchanged; `rows` carries the bar/segment/bullet geometry the dedicated `cap-view` branch draws
(the generic card `<For>` is skipped for `groupBy==='nodes'`).

**Expanded pods:** each pod is a full-width bordered CARD (`.cap-bullet-frame`, whole card is the click
target) with TWO stacked bars (Use over Req) drawn at the same global scale and left edge as the node
tracks. Both fill with usage; a tick marks the limit (Use) / request (Req); overshoot EXTENDS past the
tick, hatched (`.cap-burst-overlay`). All cards in a node share one width (the node's content width).
Clicking a card selects the pod and fits the viewport to its **bar region** (`CapSeg.focusW`), not the
empty-to-the-right full card.

**Interaction state:** `Resource` facet (`CapResource = cpu|memory`, one at a time) is owned by App,
persisted to `kd:capRes` + `?capRes=`. Hover-to-spotlight: `capHover` (a pod id, a `small:`/`other:`/
`overhead:<host>` marker) drives `capSegFaded`/`capAggFaded`, falling back to `nodeFaded` when nothing
is hovered. A cursor-following HTML tooltip (`.cap-tooltip`, payload `CapTipData = {title, sub?,
value, hint?}`) replaces native `<title>` + inline numbers; `hint` is the view-composed action line on
aggregate folds ("Click to expand into per-pod cards") whose click falls through to the row toggle.
The whole node row (`.cap-node-frame`) toggles expand/collapse; segments/bullets `stopPropagation`. Card width grows to contain SVG text via char-count
estimates (`CAP_HEADER_CHAR_W`/`CAP_BULLET_CHAR_W`).

## LR depth-column layout (`placeColumns`)

The LR connectivity views do NOT use Dagre for placement — they use strict depth columns. `computeRanks`
assigns every node (over the FULL graph, not the hub-stripped skeleton) an integer depth = longest path
from a source; depth = column, so the most-parent resources share the leftmost column. A column's WIDTH
is its widest unit, so a large same-kind group wraps into a grid block (`blockDims`) and merely widens
its column without breaking other columns' alignment.

Vertical order within a column is *seeded* from Dagre (run on the skeleton only via `dagreSeedY`, for
its crossing-minimized order — its x is discarded), then packed **contiguously** from the topmost unit's
seed: same-kind neighbours separated by `COL_V_GAP`, different kinds by the wider `BLOCK_GAP`, so each
kind reads as its own group. We anchor only the first unit to its seed and pack the rest tight (rather
than honouring each seedY as a floor) — a skeleton child seeded at its hub's centre otherwise punched a
tall hole into the centred block stack. TB (test/legacy) still uses `placeWithDagre`. Cross-component
column alignment is approximate (each component normalizes independently); within a component, exact.

This replaced "Dagre lays the skeleton, grids parked next to the hub card", which let a hub's reserved
box shove its card out of its rank, stranded wrapped leaves in a private near-hub column, and dragged a
fan-in hub's *source* parents deep next to the node they point at.

## Single-column packing (`packComponents`)

Stacks every component in one vertical column — one tree per row, left-aligned, never two side by side.
Do **not** reintroduce horizontal placement to "use the width" (an earlier viewport-aspect bin-pack was
deliberately removed). Vertical order is stable via `componentKey` (smallest kind/name, not the random
node UID), so a tree keeps its row as pods churn.

## Same-kind collapse (`__collapse__`)

A crowded same-kind cluster keeps the **head + tail** of its natural-sorted run (`COLLAPSE_HEAD=1` +
`COLLAPSE_TAIL=2` → `COLLAPSE_VISIBLE=3` stay visible) and folds the **MIDDLE** behind a synthetic pill
(a `PositionedNode` with `kind === COLLAPSE_KIND` carrying `collapse: CollapseMeta`). Keeping a
contiguous head+tail of the same order the expanded view uses means expanding just fills the middle gap
without reshuffling visible cards (the old "newest-N-by-`createdAt`" fold reshuffled on expand and was
replaced).

The cluster unit is the kind box (kind view) or a hub's degree-1 same-kind siblings (connectivity views,
where hidden leaves' hub edges aggregate into one bundled hub→pill edge). Expansion is an ephemeral
per-cluster signal in `Topology.tsx` keyed `kind:`/`host:`/`sib:`. The pill is a **two-way toggle**:
collapsed "+ show N more", expanded "− show N fewer" (bundled edge suppressed), driven by
`CollapseMeta.expanded` which `splitForFold` populates by keeping the would-fold set even when expanded.
Pills are excluded from search/nav and folded back into `kindStats` **only while collapsed** (expanded,
the cards are real and counted directly). Collapses only when the hidden middle has
≥`COLLAPSE_MIN_HIDDEN` (2). This is a CLIENT-side reveal-able fold of *live* resources — distinct from
the server-side permanent drop of dead ReplicaSets/Pods (`graph/build.go` `isHistorical`).

**Triage representatives.** While the health filter is active, `splitForFold`'s `prioritize` predicate
floats *matching* cards into the visible slots (matches first in natural order, then the natural-order
prefix of the rest) instead of the name-ordinal head+tail — a Degraded resource must never hide behind
a "+N more" pill the operator is filtering for. The predicate reaches **every** fold site: kind boxes
(`layoutGraphByKind`), sibling-subtree pills (`foldSiblingSubtrees` — a floated sibling brings its
subtree back), hub leaf grids (`collapseHubLeaves`), and orphan folds. Expanding under the filter keeps
the visible reps in their slots and appends the remainder (same no-reshuffle invariant). Health-filter
only — live search stays fade-only, so typing never relayouts.

## Hub leaf blocks (`findHubs` → `collapseHubLeaves` → `connGroups`)

- **Fan-out only.** Only a hub's degree-1 fan-OUT *children* are wrapped into leaf blocks. A fan-IN
  hub's many *parents* (e.g. the dozen Pods mounting one Secret) are NOT wrapped — folding a subset of
  one kind while siblings stay bare drew a confusing partial frame; left in the skeleton they align
  cleanly in the leftmost depth column.
- **Per-kind blocks + frames.** A hub's leaves are grouped **per kind** into separate column blocks
  (`blockDims`, fills down to `LEAF_COL_MAX` before wrapping) so each kind's "+ show N more" pill sits at
  the bottom of its column. All blocks of one hub sit at a **single depth** (`placeColumns` puts every
  block at the hub's depth ±1 and stacks them down the cross axis — depth must not vary by kind, or
  kinds look like different tree levels). Each kind folds independently (`sib:<hub>:<kind>` pill + bundled
  edge). Multi-card blocks carry a per-kind `collapseGroup` so `connGroups` draws one tight dashed
  `.conn-frame` per folded kind (accent `.conn-frame.expanded` when expanded). A kind is framed only when
  it folds. Kind/Nodes views box by kind/host already, so `connGroups` is empty there (avoids double
  borders).

## Orthogonal edge routing (`orthRoute`)

Connectivity (LR) views draw "blocky" ArgoCD-style edges: every link leaves its parent's RIGHT edge and
enters its child's LEFT edge, horizontal/vertical segments only. Dagre's spline interior is **discarded**;
`orthRoute` re-routes purely from the two card boxes (forward → 3-segment "S" through the inter-rank
gutter; same-row → straight line; back/tight → outward stubs + a mid-y lane). This is why endpoints sit
on the box EDGE (arrowheads visible) and why `cardCenter` was deleted. `edgePath` (Topology) rounds each
elbow with a clamped quadratic bezier. **Scoped to LR**: the kind view (`layoutGraphByKind`) keeps
straight cross-kind lines (its stacked columns have no parent-left semantics); the Nodes view draws no
edges.

## Selection-spotlight + filter composition

- **`related()` walks `props.edges`, NOT `layout().edges`.** Some views (Nodes) drop edges from the
  layout output — selecting a pod still needs to light its Node via the unrouted edge set.
- **`nodeFaded` order:** selection first (a selected node never fades), then kind filter, then
  search ∩ health ∩ related-subtree. Keep that order if you add a filter.
- **Ghost selections don't spotlight.** When the selected resource has no card on canvas (it was
  deleted; see the drawer terminal state below), `related()` returns null — an empty spotlight
  subtree would fade EVERYTHING. The 'f'-refit and edge spotlight degrade the same way.

## Drawer resource gauges (`resourceBars.ts` + `UsageGauges`)

Per resource (CPU/Mem), one bar per bound — a container's Lim+Req, a Node's Cap+Alloc, a Pod's or
workload's summed Lim+Req — all on ONE shared linear scale (`scaleBars`): the fill is live usage (identical
length on every bar in the group), each bar's TRACK length encodes its bound, and usage past a bound
extends the track with a hatched overshoot (the Nodes-view bullet idiom). Key invariants:

- **A pod shows the summed gauge AND per-card bars.** The top gauge is the pod total against its
  summed req/lim, as a plain fill (user-requested); each container card below carries its OWN bars —
  that container's usage against ITS req/lim — because the summed gauge can't say which container is
  near the ceiling. Finished containers get no bars; a container with a reading but no bounds gauges
  against the host node's capacity (the "Node" bar) or, when that's unknown too, a dashed "ungauged"
  track. Memory ≥90% of the container's OWN limit additionally alarms in words on the card.
- **Workload stacks split by pod or by container.** The rollup gauge's fill is a stack of segments
  (`UsageSegment`) — one per POD by default (replicas should pull even weight; an outlier segment is
  the finding; names use the topology's "…-suffix" relative form) — with a persisted caption-row
  toggle (`kd:workloadGaugeBy`) to per-container-NAME summed fleet-wide (sidecar overhead). Widths
  are proportional to each share, colours from `CONTAINER_PALETTE` (`ContainerCards.tsx` — leads
  with the accent so a stack's first segment matches the single-fill colour; deliberately no
  green/red/amber, a segment colour must never read as a status). The stack's total width equals the
  plain fill: it changes WHO, never HOW MUCH. No cards follow the rollup, so a `metric-legend` row
  names the colours.
- **Workload remainder.** The rollup sums per-pod breakdowns by name (`aggregateWorkloadUsage`); a
  pod mid-report carries no breakdown but still counts in the total, so any shortfall past 2%
  renders as an explicit dim "not yet attributed" segment — partial shares never stretch to fill.
- **Server gate.** The wire only carries a breakdown for pods with >1 container reading (joinUsage);
  a single-container pod's card reads the pod total as its own usage (the omitted breakdown would
  just repeat it).

## Deleted-resource terminal state (drawer)

When the inspected resource vanishes from the live graph (a rollout replaced the pod, a crashlooper
was reaped, a finished job was cleaned up), the drawer does NOT close. App keeps the last *resolved*
selection (`lastResolved` behind the `drawerNode` memo) while `selectedId` still points at the
vanished id, and the drawer renders that ghost with an explicit `.drawer-deleted` banner (aria-live)
over the last-known facts — the final status and log lines are exactly what a rollout-watcher wants
to keep reading. Owner chips derive from the ghost, so the surviving ReplicaSet/Job chip is the
one-click path to the replacement (in the rollout case the OLD ReplicaSet leaves the graph too —
`isHistorical` drops superseded RS — so no chip there). Any new selection, explicit deselect, or
namespace switch clears the ghost. The banner is a **sibling** of `.drawer-header`, not a child: a
zero-basis flex item "fits" on a 100%-width sibling's wrapped line and collapses to 0px wide.

## Phone-width overlay layers (≤640px)

Desktop is three side-by-side flex columns (sidebar · canvas · drawer). At the phone breakpoint
(`NARROW_SCREEN_QUERY` in App.tsx; matching tagged `@media` blocks in index.css) the panels become
full-width overlays instead of squeezing the canvas. The z order, bottom-up:

| z | layer | note |
| --- | --- | --- |
| 2 | `.topology-toolbar` | floats over the canvas top at every width |
| 5 | `.topbar` | app chrome |
| 30 | `.drawer` (overlay mode) | full-width over canvas + toolbar |
| 40 | `.sidebar` (overlay mode) | above the drawer — opened deliberately; picking a namespace auto-dismisses it |
| 60 | help panel | full-screen barrier |

The sidebar also seeds HIDDEN at this width when no `kd:sidebarHidden` pref is stored, and the
topbar compacts (brand text drops, switcher/crumb truncate) so the offline-retry pill stays reachable.

## Scope-keyed auto-fit

The fit-all effect keys on `scope` (ctx+namespace) and, separately, on a client `layoutKey`
(`groupBy` + sorted `relFilter`) — **NOT node count** (a count key re-fit on every pod churn / collapse
expand, yanking the viewport back). The two triggers differ:

- A **ctx/ns switch** resubscribes SSE and App resets the graph to empty, so `freshData`/width-0 guards
  the race (fit only the post-reset layout).
- A **group-by/relationship change** re-projects the SAME graph with no resubscribe / no empty frame, so
  it sets `freshData=true` and fits the next frame immediately (gating behind width-0 would never fire).
  `pendingFit` defers until the layout has geometry.

So a real ctx/ns switch OR a grouping/relationship change re-fits; churn and expand/refold preserve
pan/zoom.

**Nodes-view exceptions** (`toggleCapRow` re-fits asymmetrically): **collapse** → `fitCapBox` centres the
now-short row (zoom back IN). **Expand** → `fitCapRowExpanded` drives zoom from the row WIDTH not height
(fitting a tall many-pod stack vertically crushed the width-proportional bars to noise); a stack taller
than the viewport is TOP-anchored (heaviest pods up top). A per-pod **card click** fits to the card's bar
region (`fitCapBox` on `CapSeg.focusW`) so global-scale bars enlarge instead of framing the empty card.
Both read `capRows()` AFTER the toggle (the memo recomputes synchronously) and defer the fit one rAF.

**Top-bar inset:** the full-width control bar overlays the canvas top, so `computeFitFor` reads the live
`.topology-toolbar` height (`toolbarEl` ref) and frames the graph into the area BELOW it — otherwise the
topmost cards land hidden behind the bar. The `MIN_FIT_SCALE` overflow branch applies the same inset.

> The viewport-fit *math* is pure and unit-tested (`viewport.ts`); the live transform can't be verified
> headless (rAF is frozen). See [`ADR 20260605`](ADR/20260605-testing-view-math-vs-headless-animation.md)
> and the dogfooding playbook's "Measurement pitfalls".

## Adding a new layout

Add a `layoutGraphBy<Whatever>` to `layout.ts` (or its own file for a large geometry-heavy view, like
`capacityLayout.ts`), dispatch on `groupBy` in `Topology.tsx`, and add a `<View>Groups()` memo if the
layout has named containers (kind groups, host groups). Test against fixture node sets in
`layout.test.ts`.
