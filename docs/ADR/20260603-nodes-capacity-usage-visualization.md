---
date: "2026-06-03"
author: "@motoki317"
status: "accepted"
---

# Context

The `nodes` group-by (see the unified-view ADR) currently renders a plain grouped-pods layout:
`layoutGraphByHost` (`web/src/layout.ts`) buckets pods under host boxes as **fixed-size** cards
(`NODE_WIDTH=220 × NODE_HEIGHT=60`). It conveys *where* a pod is scheduled but nothing about
**size**: nodes differ in capacity and capability, pods differ in their CPU/memory requests, limits,
and actual consumption. An operator cannot feel "this node is twice the size of that one" or "this
pod is reserving a lot but barely using it" — exactly the questions the Nodes view should answer.

We want a view where larger nodes/pods are physically larger on screen, and where reserved
(request) versus actual (usage) is legible at a glance, scaling to ~50 nodes × ~200 pods of live
SSE data in SVG.

Three forces make the encoding choice hard:

1. **Magnitude perception.** "Feel the size precisely" argues against area encoding: humans judge
   position and length far more accurately than area (Cleveland & McGill's perceptual-task ranking;
   the "Raising the Bars" study found bars beat treemaps on magnitude accuracy).
2. **Kubernetes resource data is messy.** CPU requests/limits are *frequently absent* (a pod sized
   by CPU request would render at size zero); usage can *overshoot* the request up to the limit, or
   run unbounded when no limit is set. So size must be driven by **usage** (always defined), with
   request/limit as reference markers and overshoot as an explicit state.
3. **Resource kinds are not uniform.** CPU/memory are continuous scalars *with* a usage signal.
   Dynamic Resource Allocation (DRA) / extended resources (e.g. GPUs) are **discrete, countable
   devices with no in-tree usage metric** — allocation is integer, not fractional. The encoding must
   extend to both natures.

The data does not exist yet on the wire: node allocatable is captured only as a pre-formatted
display string (`fields.go` `nodeCapacity`), pod requests/limits are not captured at all, and there
is no usage source. The store keeps full `*unstructured.Unstructured`, so the values are derivable
server-side; `graph.Build` currently projects them away.

# Decision

Replace the `nodes` group-by layout with a **length-encoded (bullet/icicle) capacity-and-usage
visualization**, structured as two levels.

- **Encoding = bullet bars on a shared length scale.** A node is a horizontal track whose **length
  ∝ its allocatable capacity**, on a **global px-per-unit scale** so node sizes are comparable
  across the canvas. A pod is a segment whose **length ∝ actual usage**.
- **Node level (default).** Pods appear as segments composing the node track; the node shows both
  **reserved (Σrequest)** and **actual (Σusage)**. We ship **two presentations behind a toggle** and
  pick the keeper after live review: (A) two stacked sub-bars (REQ + USE), each segmented by pod;
  (B) a single USE bar segmented by pod with a Σrequest marker on the track.
- **Pod level (expand).** Expanding a node unfolds its pods into per-pod bullet rows: usage fill,
  **request tick**, **limit tick**, **overshoot** highlight (usage > request), near-limit warning.
  Absent request/limit simply omit their marker — a CPU view full of marker-less bars *is* the
  signal that those pods are unconstrained.
- **Resource toggle.** A single resource is shown at a time — **CPU and memory at launch** — with
  the toggle (and the node-bar A/B toggle) persisted to `localStorage` (`kd:*`) and the URL, mirroring
  the existing group-by / relationship-filter conventions.
- **Discrete (DRA) extension.** For a countable resource with no usage, the same track **degrades to
  discrete device segments** (`▣▣░░`): one allocation bar, no usage/request/limit split. v1 ships
  CPU/memory only, but the model, types, and render path are kept device-count-extensible so a DRA
  resource is a new toggle entry, not a new view.

Sketch of the encoding (same cluster — worker-1 has twice worker-2's capacity, so twice the track
length; legend: `▓` web `▒` db `█` ml-job `▤` cache `·` free/unreserved):

```
Node level · CPU · mode A (two stacked sub-bars, segmented by pod)
  worker-1 · 8 cores                                       req Σ1.0/8  use Σ4.3/8
    REQ │▓▓▓▒▒▒················································ unreserved ···│
    USE │▓▓▓▓▓▓▓▓▒▒▒▒████████████▤▤················ headroom ···············│
         └─ web ─┘└db┘└── ml-job ──┘└c┘   ← ml-job & cache use CPU with no request
  worker-2 · 4 cores                       req Σ1.0/4  use Σ0.8/4
    REQ │░░ api ░░······················│
    USE │▓▓▓▓▓···················· hd ···│

Node level · CPU · mode B (single USE bar + Σrequest marker ▏)
  worker-1 │▓▓▓▓▓▓▓▓▒▒▒▒████████████▤▤···········▏··········· headroom ·····│  use 4.3  ▏req 1.0
```

```
Pod level (expand a node) · CPU      █ within request   ▓ OVER request   ▏req  │limit
  ml-job  ██████████░░░░░░░░░░░░░░░░░░  use 2.0   req —    lim —
  web     ███▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░  use 1.4   req▏0.5  lim —    ⚡ bursting, unthrottled
  db      ███░░░░░░░░░░░░░░░░░░░░░░░░░  use 0.6   req▏0.5  lim│1.0
  cache   █░░░░░░░░░░░░░░░░░░░░░░░░░░░  use 0.3   req —    lim —
```

```
Discrete resource (DRA / GPU) · same track, no usage/markers → device segments
  worker-1 · 2 GPU    ml-job ▣ ▣            claims 2 / 2   (allocation only)
  worker-2 · 0 GPU    (none advertised)
```

To feed it:

- **Backend** gains structured node allocatable (CPU millicores, memory bytes, pods, + an extensible
  device map) and per-pod CPU/memory **requests and limits** (absent → null, not zero) on the graph
  `Node` model (`model.go` / `build.go` / `fields.go`).
- **Usage** comes from a **usage-provider interface with a metrics-server implementation now**
  (`metrics.k8s.io` Pod/Node metrics, per context), built so a Prometheus backend can be added later
  without touching the visualization. Usage streams as a **separate SSE event** keyed by UID, decoupled
  from the graph diff (usage churns ~15s; folding it into `Node` would re-diff the whole graph).
  metrics-server absence degrades silently to request-only rendering.

# Consequences

- Node and pod sizes are felt directly (track length ∝ capacity, segment length ∝ usage), on a scale
  that is honest about magnitude (length, not area).
- Reserved-vs-actual is a glance: the REQ/USE offset surfaces under-reserved/risky nodes and
  over-provisioned/wasteful ones; pods running with no request (common for CPU) are visibly absent
  from the reserved bar.
- The messy-data reality is first-class: optional request/limit, usage overshoot, and near-limit OOM
  risk each have an explicit visual state rather than being silently lost.
- One primitive spans both resource natures — continuous-with-usage (rich bullet) and
  discrete-without-usage (segment count) — so DRA is an additive toggle.
- Usage updates resize bar widths only; with the separate `usage` event and width-only patches there
  is no relayout or pan/zoom reset on the ~15s tick.

# Impact

- **Backend:** `internal/kube/graph/model.go` (structured allocatable, pod requests/limits),
  `build.go`, `fields.go` (new extractors beside `nodeCapacity`; keep the legacy string for the
  drawer); new `internal/kube/metrics/` (provider interface + metrics-server client) wired through
  `internal/kube/registry`; `internal/api/sse.go` (new `usage` event); `internal/rbac` + `deploy/`
  RBAC sample for `metrics.k8s.io`.
- **Client:** `web/src/layout.ts` (new `layoutGraphByCapacity` replacing `layoutGraphByHost`; track +
  segment + bullet geometry on a shared scale), `web/src/components/Topology.tsx` (dispatch, node-bar
  A/B modes + toggle, node expand, resource toolbar facet, auto-fit), `web/src/types.ts` (structured
  allocatable/requests/limits/usage), `web/src/api.ts` (`usage` event merge), new bullet/segment
  render components, `web/src/layout.test.ts`.
- **Reuse:** the `__collapse__` / `splitForFold` fold for crowded nodes (tiny-segment aggregation),
  the scope/`layoutKey` auto-fit keying (so a usage tick or node expand does not re-fit), and the
  `kd:*` + URL persistence pattern. The **Unscheduled** group (host-less pods) and drained
  (zero-usage) nodes still render.
- **Risks / constraints:** a new runtime dependency on metrics-server (optional, degradable);
  cross-node scale must be global, not per-node, or sizes stop being comparable; structured numbers —
  not the legacy capacity string — must drive the layout. Open items for execution: usage transport
  (separate event vs Node fields — leaning separate), per-pod vs per-container granularity (v1
  per-pod aggregate), metrics push-vs-poll cadence, and crowded-node fold threshold.

# Alternatives

- **Treemap (nested area ∝ value).** The densest, "prettiest" option and the only one that extends to
  any scalar uniformly. Rejected as the primary encoding: area is the least-accurate magnitude
  channel; it cannot overlay request/limit/overshoot on a cell; usage overshooting request violates
  the sum-to-parent invariant; small device counts (2 vs 3 GPUs) read as area rather than a count;
  and squarified layouts reshuffle under live SSE. It loses every row of the comparison the bullet
  bar wins.
- **Unit-grid (count of fixed quanta; generalized kube-ops-view).** The most precise channel
  (counting) and native for *discrete* resources (1 device = 1 cell, no quantum). Rejected for the
  continuous launch resources: it requires a quantum, and no single quantum satisfies both "smallest
  pod ≥ 1 cell" and "largest node not a wall of cells" once a cluster mixes very different node sizes
  / tiny sidecars (the capacity:request ratio ceiling). The bullet bar *becomes* a unit-grid in its
  discrete-segment mode, so we keep that strength where it applies without paying the quantum cost on
  CPU/memory.
- **Size pods by request instead of usage.** Rejected: CPU requests are commonly absent, which would
  render those pods at size zero. Usage is always defined; request becomes a marker.
- **Prometheus for usage from the start.** Rejected for v1 as a heavier dependency (HTTP client,
  per-context endpoint, PromQL, auth) before the view works; deferred behind the usage-provider
  interface.
- **Add a new group-by instead of replacing `nodes`.** Rejected: the brief was to reconsider the
  Nodes view itself; a second near-identical option dilutes the control set.

# Notes

**Accepted and implemented** (`layoutGraphByCapacity` + the `cap-view` render branch; backend
`graph.Resources`/`Usage` + the metrics-server `usage` SSE event). Two refinements emerged in live
dogfooding and are now part of the design: tiny pods fold into a "small pods" aggregate so the stacked
length stays faithful without an idle pod vanishing (see the 2026-06-04 refinement — this superseded an
earlier per-segment minimum that inflated busy nodes), and the node's TOTAL usage (NodeMetrics) draws as a faint backdrop so a namespace's small
footprint reads against real node utilization rather than the full empty capacity. The node-bar A/B
toggle is deliberately a *temporary* fork: ship both,
choose one after live evaluation, then retire the loser. The encoding ranking was the crux of the
design discussion and reversed twice as constraints surfaced — optional-requests/overshoot favored
the bar over the treemap, then DRA's discrete nature favored the grid; the bullet bar wins because it
is the only primitive that is precise (length), continuous (no quantum), carries usage-vs-request-vs-
limit, *and* degenerates into the grid's discrete-count form where there is no usage.

## Refinements (2026-06-04)

A second round of live dogfooding settled several open points and reshaped the data flow. These
supersede the corresponding parts of the original Decision:

- **Cluster-wide by nature — the view always shows every pod on a node.** A node hosts pods from
  every namespace, so its true reservation/utilization cannot be drawn from one namespace's pods.
  The namespace-scoped `usage` event is replaced by a **cluster-wide `capacity` SSE event** carrying
  *all* Nodes + *all* Pods (each tagged with its namespace) plus per-UID usage. New store seam
  `SnapshotNodesAndPods()` (the only snapshot that crosses the per-namespace ride-along boundary).
  The client renders the selected namespace's pods **bright and individual**; every other namespace's
  pod folds into ONE gray **"other namespaces"** block per bar (and one per expanded bullet) —
  `CapAggregate` — so this namespace's pods are easy to locate and a busy node doesn't bury them under
  many gray segments. The block is hoverable for its folded totals (count, usage, request) but not
  individually selectable. Cluster scope shows every pod individually (no aggregate). (Note: this
  serves cluster-wide pod counts/totals to a namespace-scoped client; acceptable for a single-operator
  infra view, revisit if multi-tenant RBAC must gate it.) A pod selected in cluster scope resolves its
  drawer from the capacity feed (the namespace graph holds no pods there).
- **Req + Use chosen; overlay retired.** The A/B node-bar fork is resolved in favor of the explicit
  two-stacked-bar form (`split`); the overlay/`Use`-only mode and its `CapMode` toggle are removed.
  Each bar carries an explicit **"Req" / "Use"** axis label. (A this-namespace/other-namespaces colour
  legend was tried, then removed once the gray block became an explicitly *labelled* "other namespaces"
  bar/bullet — the label is the legend.)
- **Variable-length expanded bullets, name-only.** Per-pod bullets draw the colored bar's *length* ∝
  usage on the shared per-node scale (a faint baseline runs to the pod's furthest req/limit marker),
  rather than a fixed-length track with a varying fill — so a small pod's bar is physically shorter.
  Request / limit are ticks; bursting is the hatch overlay. The bullet prints only the **full pod
  name** — the usage/request/limit numbers were too cluttered inline and now live on hover.
- A **Grafana-style hover tooltip** (a cursor-following HTML card, enlarged for readability, naming the
  pod/other-ns block and its usage/request/limit) replaces the native SVG `<title>` and the inline
  bullet numbers.
- **Selection fit** frames the selected pod's whole node *row*, not its `related()` subtree (whose
  edges belong to the namespace graph, not this feed).
- **Faithful stacked length — the per-pod minimum was the bug, not the floor.** Live production data
  (a 940m node running 31 pods, 21 of them at 1m CPU) exposed that a per-segment minimum width is
  fundamentally incompatible with summed-length fidelity: N near-zero pods each floored to ~4px tile to
  ≥`N·4`px regardless of their true sum, so an 8%-used node drew a bar filling ~70% of its track — the
  stacked length stopped meaning anything. The minimum was the very thing introduced in the first round
  ("an idle pod never vanishes"); reconsidered from the bottom, **collapsed-bar segments now draw at
  EXACT proportional width (value·scale, no floor)** so Σwidths = Σvalues and the bar end lands at the
  node's true utilization. To keep tiny pods from *silently* vanishing without re-inflating the bar,
  healthy pods that would draw under `CAP_SEG_FOLD` fold into ONE **"small pods"** `CapAggregate`
  (variant `small`) sized by their EXACT summed value — a single block can't N-inflate, and it is
  hoverable ("N small pods — expand to see each") and click-expands the node. The small block is styled
  exactly like a normal pod segment (same accent fill, no border — an earlier dashed outline collided
  with the selected-pod stroke); it is identified by hover + its position after the individual segments.
  A lone sub-threshold pod is floored instead (≤1 min-width of slack). **Unhealthy pods never fold** — a
  troubled pod stays individually visible with its health colour even at ~0 usage. Segments are ordered
  **largest-first by max(use, request)** so the dominant consumers sit at the left, then the small-pods
  fold, then the other-namespaces block. This is the collapsed/aggregate vs expanded/detail split: the
  bars compare nodes on one global scale (small stuff folds honestly); expanding reads every pod on the
  per-node zoom. The Req and Use bars share ONE colour scheme (the req bar is not a lighter shade), so a
  pod reads as the same colour on both and selecting it emphasises both identically.
- **Expanded bullets zoom to usage+request, not limit.** The per-node bullet scale that was meant to
  make small pods legible was itself defeated by limits: one pod limiting 1 CPU but using 1m set
  `bulletMax`, crushing every usage fill to a sub-pixel sliver. The scale is now `max(use, request)`;
  a limit still draws as a tick but its reach is **capped at the track end** (the exact value is on
  hover) so an outlier limit can no longer dominate the visualization.
- **Hover-to-spotlight (Grafana-style) + aggregate fade fix.** Hovering a pod segment/bullet (not just
  clicking) spotlights it and fades the rest, for faster reading. A `capHover` key (a pod id, or a
  `small:<host>`/`other:<host>` aggregate marker) drives the fade; with nothing hovered it falls back to
  the standard selection/search/filter fade, so a selected pod stays spotlit after the cursor leaves.
  This also fixed a bug where the bright accent aggregate block stayed lit while every individual
  segment faded on selection — aggregates now fade whenever a specific pod is in focus (hovered,
  selected, searched, or filtered), since a block is never the single focused pod.
- **The whole node row is the expand target (a bordered card).** The tiny ▸/▾ caret was too small to
  click (and was later removed entirely); each node is a bordered card (`.cap-node-frame`) and clicking
  anywhere on it that isn't a pod segment toggles expand/collapse (segments/bullets `stopPropagation` so
  selecting a pod doesn't also toggle the node). The node name is packed into the card's top-left. This
  improves both the hit target and the visual grouping (each node reads as one unit).
- **The card border always contains its text.** SVG `<text>` can't reflow, so the card width is grown
  to fit the header (node name + pod count) and, when expanded, every full pod name — estimated from
  char count (`CAP_HEADER_CHAR_W` / `CAP_BULLET_CHAR_W`) — instead of letting a long name or pod name
  spill past the border. Slight over-reserve (a little right padding) is preferred to clipping.
- **Terminal pods are excluded.** The capacity view shows live utilization, so the server drops
  Succeeded/Failed pods from the feed (`stoppedPod` filter in `buildCapacity`) — a finished or errored
  pod holds no reservation and consumes nothing, so it must not pad a node's bars or pod count. (The
  topology graph still keeps Failed pods, which are actionable there; this filter is capacity-specific.)
- **Totals sit next to their bar, not the node name (proximity).** Capacity/use/request used to crowd
  the header beside the node name; each bar now carries its own `value / capacity` label just past its
  right end (`910m / 940m` by the Req bar, `84m / 940m` by the Use bar; the value emphasized, capacity
  dim). The header keeps only identity + pod count. This applies the proximity principle — the number
  reads with the bar it describes — and makes the reservation-vs-usage gap obvious per bar.
- **Use bar on top, Req below, equal height.** The bars were a fat Use bar over a thin Req bar
  (22 vs 12px) with Req on top; they now share ONE height (`CAP_BAR_H`) with **Use on top** (the live
  number reads first) and Req below. Equal weight + a single height reinforce that the two are the same
  channel measured two ways, not a primary/secondary pair.
- **Expanded pod bullets mirror the node bars (two stacked sub-bars).** A per-pod bullet was a single
  usage bar with request/limit drawn as ticks — a different visual idiom from the node-level
  Use/Req bars right above it. Each bullet is now **two stacked sub-bars (Use over Req)** reusing the
  same `.cap-track`/`.cap-seg` classes, so the detail reads as a zoomed-in node row in one consistent
  language (repetition). Widths still come from the per-node `bulletScale`; the limit remains a tick on
  the Use bar, bursting a hatch on it. The whole two-bar group is one hover/click target showing the
  same `CapTipData` tooltip as the node-level segments.
- **Expanding a node fits the viewport to it.** Expanding reveals the per-pod bullets and makes the row
  much taller, so the click now fits the viewport to that node's row (`toggleCapRow`) — the operator is
  zoomed straight to the pods they just opened. A tall many-pod row fits by zooming out, a small row by
  zooming in; both are "fit to that node". Collapsing does not re-fit (it preserves the current
  pan/zoom), so folding the detail back never throws the viewport away.
- **Expanded pod bars are usage gauges against limit AND request, with overshoot wrapping.** The first
  two-bar pass drew the Use bar as usage and the Req bar as the request value, normalised to one shared
  ceiling — so the request bar read as always-full whenever the request was the largest value, and it
  showed the reservation rather than what the pod was doing. The bars are now two GAUGES that BOTH fill
  with actual USAGE and differ only in their reference: the Use bar against the limit (`capUseCeiling`),
  the Req bar against the request (`capReqCeiling`). Each reads "how much of X am I using"
  (`usage / limit`, `usage / request`), so under-using a reservation reads as a partial Req bar and
  bursting past it reads as the Req bar going over 100%. Both bars are a fixed-length track (the ceiling
  at 100%); the pod name moved to a header above the bars and a `usage / ceiling` label sits past each,
  mirroring a node row. **Overshoot wraps** (`capBulletLaps`): usage beyond the ceiling tiles successive
  full-width laps left-to-right in escalating colours (normal → amber → orange → red, capped at
  `CAP_MAX_LAPS`) so an overshoot stays inside the fixed width and the lap count reads as "N× over" —
  rather than a bar running off-canvas or being silently clamped. The per-node `bulletScale` (and its
  variable-length bullets, request/limit ticks, and burst hatch) were retired with this change.
- **Node-level tooltips minimised; Use bar gauges against total capacity, not allocatable.** The bars
  already print "use / cap" and "req / cap" at their right end, so the node-bar hover tooltip was
  reduced to the single amount of the hovered part — a Use segment → its usage, a Req segment → its
  request, a fold → its Σ, the node-usage backdrop → just the **non-pod/system overhead**
  (`max(0, nodeUse − useTotal)`; `useTotal` already nets out other-namespace pods, so the remainder is
  kubelet/runtime, NOT other namespaces). Hovering the backdrop also spotlights it (fades every other
  part, like a pod hover). The gray "other namespaces"/overhead fills were brightened to a solid
  mid-gray (they're real usage, not an empty hint). Finally, the **Use bar's ceiling is the node's TOTAL
  physical capacity** (`status.capacity` → structured `KNode.capacityRes`), while the **Req bar keeps
  allocatable**: usage can legitimately spill into the system-reserved region (the overhead the backdrop
  shows), so gauging it against allocatable would falsely read as overflow. Two ceilings ⇒ two track
  lengths (`trackW` for Req, `useTrackW` for Use) on one shared px-per-unit scale, so a pod's use/req
  segments stay directly comparable; the scale now keys on max capacity. Capacity falls back to
  allocatable when unreported (e.g. Fargate, which reports them equal), collapsing the two tracks.
