---
date: "2026-06-03"
author: "@motoki317"
status: "proposed"
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

Status is **proposed** — this records the design decision; implementation follows in phases
(data → metrics → view). The node-bar A/B toggle is deliberately a *temporary* fork: ship both,
choose one after live evaluation, then retire the loser. The encoding ranking was the crux of the
design discussion and reversed twice as constraints surfaced — optional-requests/overshoot favored
the bar over the treemap, then DRA's discrete nature favored the grid; the bullet bar wins because it
is the only primitive that is precise (length), continuous (no quantum), carries usage-vs-request-vs-
limit, *and* degenerates into the grid's discrete-count form where there is no usage.
