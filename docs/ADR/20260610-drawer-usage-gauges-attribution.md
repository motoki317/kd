---
date: "2026-06-10"
author: "@motoki317"
status: "accepted"
---

# Context

The drawer's CPU/memory gauges answer two different operator questions that one display kept
conflating:

1. **"How much is this thing using vs what it reserved?"** — the total, for right-sizing.
2. **"WHO is using it / who is near a ceiling?"** — attribution, for triage (which container is about
   to OOM; which replica is the outlier).

The first iteration showed a pod-summed gauge whose fill stacked one coloured segment per container,
keyed to the container cards by colour swatches, with each card carrying its declared bounds as a
labelled text row ("cpu req 10m | mem req 192Mi · lim 192Mi"). Two rounds of user feedback drove a
redesign: a pod-summed bar — even segmented — cannot say which container is hitting **its own**
request/limit (bounds belong to containers, not pods), and once each container gauges itself the
bounds text row is redundant; but dropping the summed gauge entirely lost the at-a-glance total,
which was asked back. Separately, the workload rollup (a Deployment's usage summed across replicas)
only attributed by container name, hiding per-replica imbalance.

# Decision

- **Each container card carries its own bars**: live usage gauged against *its* request/limit on the
  shared-scale model (`drawerResourceBars`). A finished container gets no bars; a bound-less
  container gauges against its host node's capacity (the "Node" ceiling), or a dashed "ungauged"
  track when that is unknown too. The bounds-as-text row is retired — the bars carry the numbers.
  Memory ≥90% of the container's own limit still alarms in words on the card.
- **The pod keeps a summed gauge above the cards**, as a **plain fill** — no per-container stack, no
  swatches: attribution lives on the cards directly below, so re-keying colours would duplicate it.
- **The workload rollup's fill splits one segment per POD by default**, toggleable to
  per-container-name summed fleet-wide. Rationale for the default: replicas *should* pull even
  weight, so an uneven segment IS the finding (it exposed a real 4× memory imbalance between two
  replicas the day it shipped); the container split answers the narrower "is the sidecar overhead
  material?". Segment names reuse the topology's "…-suffix" relative form so the legend and the
  canvas agree on what a pod is called. The choice persists (`kd:workloadGaugeBy`); the toggle hides
  when both splits are single-segment. A pod split sums exactly (unmetered pods are excluded from
  both sides); the container split can undercount mid-rollout, so a >2% shortfall renders as an
  explicit dim "not yet attributed" segment rather than stretching partial shares.
- **A non-zero reading never displays as "0"**: when the pair's shared unit is too coarse (2m under
  a cores-keyed ceiling), the affected side borrows its natural unit ("2m / 1") — unit consistency
  yields to truthfulness in exactly the rounds-to-zero corner.

# Consequences

- "Which container is near ITS limit" reads directly off the card; the summed read stays one glance
  up. The two questions get two displays instead of one compromised one.
- Module boundaries follow the design: `resourceBars.ts` (shared-scale model) → `UsageGauges.tsx`
  (rendering + segments + legend + palette) ← `ResourceSummary.tsx` (pod/Node top gauge, workload
  rollup + split toggle) / `ContainerCards.tsx` (per-card bars); rollup math in `usageAggregate.ts`.
- Colours stay a non-status vocabulary (no green/red/amber in the segment palette) so a segment
  never reads as health; stacks change WHO, never HOW MUCH (a stack's total width equals the plain
  fill).
- Rejected along the way: collapsing equal Req+Lim bars into one "Req=Lim" bar
  (breaks the per-card repetition idiom; the fixed sublabel column can't fit it), and per-pod
  swatches on container cards (cards stopped needing a colour join once they gauge themselves).

# Impact

`web/src/resourceBars.ts`, `web/src/components/UsageGauges.tsx`, `web/src/components/ContainerCards.tsx`,
`web/src/components/ResourceSummary.tsx`, `web/src/usageAggregate.ts`, `web/src/capacityLayout.ts`
(`formatPair`); invariants summarized in docs/frontend-internals.md "Drawer resource gauges".
