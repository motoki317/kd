// Capacity & usage view (the Nodes group-by) layout — extracted from layout.ts to isolate the
// most actively-developed, geometry-heavy view (see docs/ADR/20260603-nodes-capacity-usage-
// visualization.md). The relationship/kind graph layouts stay in layout.ts; this module owns the
// length-encoded bullet-bar geometry, its CAP_* constants, and the CapSeg/CapAggregate/CapRow shapes.
import type { KNode } from './types'
import { byName, type Layout, type PositionedNode } from './layout'

// A length-encoded "bullet bar" visualization (see docs/ADR/20260603-nodes-capacity-usage-
// visualization.md): each node is a horizontal TRACK whose length ∝ its allocatable capacity (on a
// GLOBAL px-per-unit scale, so node sizes are comparable across the canvas — the "feel the size"
// goal), and pods are SEGMENTS sized by their actual usage. Reserved (request) vs actual (usage) is
// shown either as two stacked sub-bars ('split') or one usage bar with a Σrequest marker ('overlay').
// Expanding a node unfolds per-pod bullet rows (usage fill + request/limit ticks + overshoot). A
// single resource is shown at a time (CPU or memory), so the two metrics never fight for one channel.

export type CapResource = 'cpu' | 'memory'

// CLUSTER_SCOPE_NS mirrors api.ts CLUSTER_SCOPE — the sentinel namespace under which the capacity
// view treats every pod as "own" (no dimming), since a cluster-scoped view spans all namespaces.
const CLUSTER_SCOPE_NS = '__cluster__'

// px length of the largest-capacity node's track; everything scales to this. Generous so a node a
// few× smaller than the biggest still draws a readable bar (the user's "an exceptionally large node
// shrinks everyone else" report — a longer top end gives the mid/small nodes more px). The scale is
// strictly LINEAR (CAP_TRACK_MAX / maxCapacity) so a pod bar is directly comparable to the node bar
// it sits on — a 4-unit pod is half an 8-unit node — which the expanded per-pod bullets rely on.
const CAP_TRACK_MAX = 1080
const CAP_TRACK_MIN = 130 // a node never narrower than this, so a tiny node stays readable/clickable
const CAP_ROW_LEFT = 48 // left gutter where every track starts — also holds the "Req"/"Use" axis labels
const CAP_LABEL_H = 22 // header line (node name · pod count) above the bars
// Use and Req bars share ONE height (the user asked they be equal). They read as the same channel,
// just stacked — Use on top (the live number first), Req below — rather than a fat bar over a thin one.
export const CAP_BAR_H = 18
const CAP_BAR_GAP = 3 // gap between the use and req sub-bars
const CAP_ROW_GAP = 26 // gap between node rows
// A per-pod expanded row mirrors the node bars: two stacked sub-bars (use over req), each
// CAP_BULLET_BAR_H tall, so the detail reads in the SAME visual language as the node-level bars
// instead of a separate one-bar-with-ticks idiom.
export const CAP_BULLET_BAR_H = 11
export const CAP_BULLET_BAR_GAP = 2
const CAP_BULLET_H = CAP_BULLET_BAR_H * 2 + CAP_BULLET_BAR_GAP // height of the two stacked bars
const CAP_BULLET_GAP = 8 // vertical gap between adjacent pod cards
// Each expanded pod is its own bordered CARD (the user can click it to zoom in and read the bars):
// padding around the content, a left inset holding the "Use"/"Req" axis labels, and the card height =
// pad + name line + the two bars + pad.
export const CAP_BULLET_PAD = 7
const CAP_BULLET_AXIS_W = 30 // how far left of the bar the card extends — holds the "Use"/"Req" axis label
// CAP_SEG_FOLD doubles as the fold threshold and the floor: a collapsed-bar segment that would draw
// narrower than this is not individually distinguishable, so it folds into the "small pods" aggregate
// (when ≥2 such pods share a node) or, alone, is floored to this width. Crucially it is NOT applied as
// a per-pod minimum to every segment — that floor, summed over many near-zero pods, inflated the
// stacked bar far past the node's true usage (21 pods at 1m each drew 21·4px though they sum to ~4px),
// making an 8%-used node look 70% full. Big pods draw at EXACT width (val·scale) so Σwidths = Σvalues.
const CAP_SEG_FOLD = 4
const CAP_MIN_SEG = 4 // bullets/aggregate blocks: a single block is floored so it stays visible/hittable
const CAP_TOP = 28
const CAP_BOTTOM_PAD = 12
const CAP_BAR_VALUE_W = 120 // trailing space reserved past each bar for its "value / capacity" label
// The node card border must contain its text. SVG <text> can't reflow, so we ESTIMATE text width from
// char count (node/pod names are narrow: digits, lowercase, hyphens) and grow the card to fit, rather
// than letting a long name or pod name spill past the border. Slight over-reserve is fine (a little
// right padding); under-reserve would clip into the border, which is the bug being fixed.
const CAP_HEADER_INSET = 26 // node-name header starts this far left of the bar gutter (packed into the card top-left)
const CAP_HEADER_CHAR_W = 6.6 // ~px/char of the 12px header font (name + " · N pods")
const CAP_BULLET_CHAR_W = 6.2 // ~px/char of the 11px expanded-bullet pod-name font
// Each expanded pod bar is drawn at the SAME global px-per-unit scale as the node tracks (not a private
// fixed-length gauge), so a pod's bar length is directly comparable to its node's — "feel how big each
// pod is". The fill = the pod's actual usage; a faint reference TICK marks its request (Req bar) / limit
// (Use bar), and when usage overshoots the bar simply EXTENDS past the tick (the part beyond is hatched)
// rather than wrapping in lap colours — extension reads as "over its limit/request" at a glance and keeps
// the one-scale comparison intact. The card spans the node's full content width (so the "value / ref"
// label always fits, reserved by the node's own CAP_BAR_VALUE_W), and is CAP_BULLET_CARD_H tall.
const CAP_BULLET_NAME_H = 14 // pod-name header line above its two bars (mirrors the node header)
const CAP_BULLET_CARD_H = CAP_BULLET_PAD + CAP_BULLET_NAME_H + CAP_BULLET_H + CAP_BULLET_PAD

// resourceOf reads the active resource's quantity (CPU millicores or memory bytes) off a Resources
// object, returning undefined when that resource is unset (the absent-request case the view marks).
const resourceOf = (r: { cpuMilli?: number; memBytes?: number } | undefined, res: CapResource): number | undefined =>
  !r ? undefined : res === 'cpu' ? r.cpuMilli : r.memBytes

// CapSeg is one of the SELECTED namespace's pods rendered as a bar segment (or, in the expanded
// detail, a per-pod bullet). It carries the raw values so the renderer can draw the usage fill, the
// request/limit ticks, and the overshoot/near-limit states, plus the box geometry that doubles as
// the selection hit target. Pods from OTHER namespaces are NOT individual segs — they collapse into
// one CapAggregate so the selected namespace's pods are easy to locate.
export interface CapSeg {
  node: KNode
  use: number // active-resource usage in canonical units; 0 when unknown
  req?: number // summed container request, undefined when no container sets it
  lim?: number
  over: boolean // usage exceeds request (and a request exists) — bursting past the reservation
  nearLimit: boolean // usage within 90% of the limit — OOM/throttle risk
  x: number
  y: number
  width: number
  height: number
  // Expanded-pod bullets only: the bordered card framing the pod's name + two bars. Clicking it zooms
  // the viewport to read the bars (the user's "click a pod box to read its bars clearly"). Absent on the
  // collapsed-bar segments, which carry no card.
  box?: { x: number; y: number; width: number; height: number }
  // Zoom-to-read horizontal extent, cardX-anchored: cardX → the bar's filled/tick end + its value label.
  // The card itself spans the FULL node-capacity width (box.width), most of which is empty space right of
  // a low-usage pod's short bars — fitting that whole card zooms OUT (the bars shrink). Fitting focusW
  // instead frames just the bars + labels, so a click actually enlarges them. Capped at box.width.
  focusW?: number
}

// CapAggregate is a folded block on a bar (or bullet) standing in for several pods, summed. Two
// variants: 'other' — every pod outside the selected namespace (gray; absent in cluster scope); and
// 'small' — the selected namespace's OWN pods too tiny to draw individually (folded so they neither
// vanish nor inflate the stacked length). Both are hoverable for their totals but not individually
// selectable (a block stands for many pods — click expands the node to see each as a bullet).
export interface CapAggregate {
  variant: 'small' | 'other'
  count: number // how many pods are folded into this block
  use: number
  req: number
  x: number
  y: number
  width: number
  height: number
  // The expanded "other namespaces" bullet's bordered card (mirrors CapSeg.box); absent on the
  // collapsed-bar aggregates.
  box?: { x: number; y: number; width: number; height: number }
  focusW?: number // zoom-to-read extent (mirrors CapSeg.focusW)
}

// CapBarItem is one own pod's per-resource numbers, the input to buildCapBar (which decides whether
// it draws individually or folds into the small aggregate). A superset of CapSeg's value fields.
interface CapBarItem {
  node: KNode
  use: number
  req?: number
  lim?: number
  over: boolean
  nearLimit: boolean
}

// buildCapBar lays one collapsed bar (req or use) for a node's own pods. Segments draw at EXACT
// proportional width (value·scale, no per-pod floor) so the stacked length faithfully equals the
// summed value. Healthy pods that would draw under CAP_SEG_FOLD fold into ONE "small pods" aggregate
// sized by their EXACT summed value (a single block can't N-inflate the bar); a lone sub-threshold
// pod is floored instead (≤1 min-width of slack). Unhealthy pods never fold — a troubled pod stays
// individually visible (with its health color) even at near-zero usage, so problems aren't hidden.
function buildCapBar(
  items: CapBarItem[],
  valueOf: (d: CapBarItem) => number,
  scale: number,
  x0: number,
  y: number,
  height: number,
): { segs: CapSeg[]; small?: CapAggregate; folded: KNode[]; endX: number } {
  const sized = items.map((d) => ({ d, w: valueOf(d) * scale }))
  const foldable = (s: { d: CapBarItem; w: number }) => s.w < CAP_SEG_FOLD && s.d.node.health === 'Healthy'
  const smallItems = sized.filter(foldable)
  const fold = smallItems.length >= 2
  const segs: CapSeg[] = []
  const folded: KNode[] = []
  let x = x0
  for (const s of sized) {
    if (fold && foldable(s)) {
      folded.push(s.d.node)
      continue
    }
    const width = Math.max(CAP_SEG_FOLD, s.w) // floors only a lone sub-threshold pod; big pods already exceed it
    segs.push({ ...s.d, x, y, width, height })
    x += width
  }
  let small: CapAggregate | undefined
  if (fold) {
    const sumV = smallItems.reduce((a, s) => a + valueOf(s.d), 0)
    const use = smallItems.reduce((a, s) => a + s.d.use, 0)
    const req = smallItems.reduce((a, s) => a + (s.d.req ?? 0), 0)
    const width = Math.max(CAP_MIN_SEG, sumV * scale)
    small = { variant: 'small', count: smallItems.length, use, req, x, y, width, height }
    x += width
  }
  return { segs, small, folded, endX: x }
}

// CapRow is one node: its track (length ∝ capacity), the SELECTED namespace's pod segments composing
// the requested and usage bars, the single "other namespaces" aggregate after them, totals, and the
// expanded per-pod bullets. The row is cluster-wide (a node's true reservation/usage), the selected
// namespace's pods just render bright and individually; the rest fold into one gray block.
export interface CapRow {
  host: string
  label: string
  node?: KNode // the Node resource; undefined for the synthetic "Unscheduled" bucket
  cap?: number // allocatable for the active resource (Req bar ceiling); undefined when unknown (orphan bucket)
  useCap?: number // total physical capacity (Use bar ceiling); falls back to allocatable when not reported
  reqTotal: number // Σrequest of ALL pods on the node (own + other namespaces)
  useTotal: number // Σusage of ALL pods on the node
  ownUseTotal: number // Σusage of just the selected namespace's pods (the bright block)
  ownCount: number // # of the selected namespace's pods on this node (some may be folded into smallUseSeg)
  otherCount: number // # of pods on this node from OTHER namespaces (0 in cluster scope)
  allPodIds: string[] // every pod on the node (own + other), so capRowBoxFor can frame the row a folded pod sits in
  nodeUse?: number // the node's TOTAL usage (all namespaces, from NodeMetrics) — context backdrop
  overcommit: boolean // Σrequest exceeds capacity — the node has promised more than it has
  expanded: boolean
  x: number
  y: number
  width: number
  height: number
  trackY: number // y of the usage bar top
  trackW: number // Req bar track length in px (allocatable · scale)
  useTrackW: number // Use bar track length in px (total capacity · scale); ≥ trackW
  reqBarY: number // y of the requested bar
  useSegs: CapSeg[] // the selected namespace's individually-drawn pods, sized by usage, composing the usage bar
  reqSegs: CapSeg[] // the selected namespace's individually-drawn pods with a request, sized by request
  smallUseSeg?: CapAggregate // own pods too tiny to draw individually, folded into one block on the usage bar
  smallReqSeg?: CapAggregate // own pods too tiny to draw individually, folded into one block on the requested bar
  otherUseSeg?: CapAggregate // the "other namespaces" block on the usage bar (after the own segs)
  otherReqSeg?: CapAggregate // the "other namespaces" block on the requested bar
  bullets: CapSeg[] // per-pod detail rows for the selected namespace's pods, present only when expanded
  otherBullet?: CapAggregate // the "other namespaces" bullet row (expanded), folding the rest
}

// CapacityLayout is a Layout (so selection/search/fit operate on `nodes` as usual) plus the per-node
// row model the capacity renderer draws. `nodes` are positioned at each pod's usage segment (the
// selection box) and each Node's header, so clicking a bar opens the right drawer.
export interface CapacityLayout extends Layout {
  rows: CapRow[]
  scale: number
  resource: CapResource
  hasUsage: boolean
}

export function layoutGraphByCapacity(
  nodes: KNode[],
  usage: Record<string, { cpuMilli?: number; memBytes?: number }> | undefined,
  resource: CapResource,
  // The selected namespace. Pods outside it render gray (dimmed) but still present, so a node's
  // real utilization shows. '' or the cluster sentinel → every pod is "own" (item: cluster view
  // shows all pods; namespace view dims other namespaces).
  currentNamespace: string,
  expanded: ReadonlySet<string> = new Set(),
): CapacityLayout {
  const base: CapacityLayout = { nodes: [], edges: [], width: 0, height: 0, rows: [], scale: 1, resource, hasUsage: false }
  if (nodes.length === 0) return base

  const hasUsage = !!usage && Object.keys(usage).length > 0
  const useOf = (id: string): number => {
    const u = usage?.[id]
    return (u ? resourceOf(u, resource) : undefined) ?? 0
  }

  const clusterScope = currentNamespace === '' || currentNamespace === CLUSTER_SCOPE_NS
  const isOwn = (p: KNode) => clusterScope || p.namespace === currentNamespace

  const nodeByName = new Map<string, KNode>()
  for (const n of nodes) if (n.kind === 'Node') nodeByName.set(n.name, n)

  const podsByHost = new Map<string, KNode[]>()
  const ORPHAN = '__orphan__'
  for (const n of nodes) {
    if (n.kind !== 'Pod') continue
    const key = n.host && nodeByName.has(n.host) ? n.host : ORPHAN
    if (!podsByHost.has(key)) podsByHost.set(key, [])
    podsByHost.get(key)!.push(n)
  }
  const hostNames = [...nodeByName.keys()].sort((a, b) => a.localeCompare(b))
  if (podsByHost.has(ORPHAN)) hostNames.push(ORPHAN)

  // Global scale: the largest node's TOTAL capacity maps to CAP_TRACK_MAX, so every other node's track
  // is proportional (a 2× node reads 2× as long). The Use bar gauges against total capacity (the
  // longest track), so the scale keys on capacity, not allocatable. When no capacities are known (a pure
  // orphan bucket), fall back to the largest demand so the bars still fill the canvas.
  let maxCap = 0
  let maxDemand = 0
  for (const host of hostNames) {
    const node = nodeByName.get(host)
    const total = resourceOf(node?.capacityRes, resource) ?? resourceOf(node?.allocatable, resource)
    if (total) maxCap = Math.max(maxCap, total)
    let use = 0
    let req = 0
    for (const p of podsByHost.get(host) ?? []) {
      use += useOf(p.id)
      req += resourceOf(p.requests, resource) ?? 0
    }
    maxDemand = Math.max(maxDemand, use, req)
  }
  const scale = CAP_TRACK_MAX / (maxCap || maxDemand || 1)

  const rows: CapRow[] = []
  const posNodes: PositionedNode[] = []
  let cursorY = CAP_TOP
  let maxRight = CAP_ROW_LEFT + CAP_TRACK_MIN

  for (const host of hostNames) {
    const nodeCard = nodeByName.get(host)
    const cap = resourceOf(nodeCard?.allocatable, resource) // schedulable — the Req bar's ceiling + overcommit ref
    const useCap = resourceOf(nodeCard?.capacityRes, resource) ?? cap // total physical — the Use bar's ceiling
    const all = podsByHost.get(host) ?? []
    // Only the SELECTED namespace's pods become individual segments; everything else folds into one
    // "other namespaces" block, so this namespace's pods are easy to locate at the left of the bar.
    const ownPods = all.filter(isOwn)
    const otherPods = all.filter((p) => !isOwn(p))

    const segData: CapBarItem[] = ownPods.map((p) => {
      const use = useOf(p.id)
      const req = resourceOf(p.requests, resource)
      const lim = resourceOf(p.limits, resource)
      return {
        node: p,
        use,
        req,
        lim,
        over: req !== undefined && use > req,
        nearLimit: lim !== undefined && lim > 0 && use >= 0.9 * lim,
      }
    })
    // Left→right by magnitude: the biggest consumer (max of usage/request) first, so the eye meets the
    // dominant pods at the left; ties by name for a stable order across SSE patches. buildCapBar then
    // tiles the small-pods fold after the individual segments, and the other-namespaces block last.
    segData.sort((a, b) => Math.max(b.use, b.req ?? 0) - Math.max(a.use, a.req ?? 0) || byName(a.node, b.node))
    // Other-namespace totals — one gray block stands in for all of them.
    const otherUse = otherPods.reduce((s, p) => s + useOf(p.id), 0)
    const otherReq = otherPods.reduce((s, p) => s + (resourceOf(p.requests, resource) ?? 0), 0)
    const ownUseTotal = segData.reduce((s, d) => s + d.use, 0)
    const ownReqTotal = segData.reduce((s, d) => s + (d.req ?? 0), 0)
    const useTotal = ownUseTotal + otherUse
    const reqTotal = ownReqTotal + otherReq
    // Two ceilings ⇒ two track lengths on ONE shared scale (so a pod's use/req segments stay comparable):
    // the Req bar fills to allocatable, the Use bar to total capacity (a touch longer, by the reserved
    // overhead). Both fall back to demand when the node's size is unknown (orphan bucket).
    const trackW = Math.max(CAP_TRACK_MIN, (cap ?? Math.max(useTotal, reqTotal)) * scale)
    const useTrackW = Math.max(CAP_TRACK_MIN, (useCap ?? Math.max(useTotal, reqTotal)) * scale)
    const label = host === ORPHAN ? 'Unscheduled' : host
    const overcommit = cap !== undefined && reqTotal > cap

    const headerY = cursorY
    // Use bar sits ON TOP (the live number reads first), Req below it — both the same height now.
    const useBarY = headerY + CAP_LABEL_H
    const reqBarY = useBarY + CAP_BAR_H + CAP_BAR_GAP

    // Usage bar: own pods sized by actual usage (or by request when metrics-server is absent), drawn
    // at exact width; the small ones fold; then the "other namespaces" block. The faint node-total
    // backdrop (NodeMetrics) is drawn by the renderer behind these.
    const useBar = buildCapBar(segData, (d) => (hasUsage ? d.use : d.req ?? 0), scale, CAP_ROW_LEFT, useBarY, CAP_BAR_H)
    const useSegs = useBar.segs
    const smallUseSeg = useBar.small
    let otherUseSeg: CapAggregate | undefined
    if (otherPods.length) {
      const width = Math.max(CAP_MIN_SEG, (hasUsage ? otherUse : otherReq) * scale)
      otherUseSeg = { variant: 'other', count: otherPods.length, use: otherUse, req: otherReq, x: useBar.endX, y: useBarY, width, height: CAP_BAR_H }
    }

    // Requested bar: own pods with a request, drawn at exact width; the small ones fold; then the
    // single "other namespaces" block. buildCapBar keeps the stacked length faithful (no per-pod floor).
    const reqBar = buildCapBar(
      segData.filter((d) => d.req !== undefined),
      (d) => d.req ?? 0,
      scale,
      CAP_ROW_LEFT,
      reqBarY,
      CAP_BAR_H,
    )
    const reqSegs = reqBar.segs
    const smallReqSeg = reqBar.small
    let otherReqSeg: CapAggregate | undefined
    if (otherPods.length && otherReq > 0) {
      const width = Math.max(CAP_MIN_SEG, otherReq * scale)
      otherReqSeg = { variant: 'other', count: otherPods.length, use: otherUse, req: otherReq, x: reqBar.endX, y: reqBarY, width, height: CAP_BAR_H }
    }

    // Selection/search anchors: one posNode per own pod, positioned on the usage bar. An individually
    // drawn pod anchors at its segment center; a folded small pod anchors at the small aggregate, so
    // search and selection still resolve it (drawer via capById, fit frames the whole row).
    for (const s of useSegs) {
      posNodes.push({ ...s.node, x: s.x + s.width / 2, y: useBarY + CAP_BAR_H / 2, width: s.width, height: CAP_BAR_H })
    }
    if (smallUseSeg) {
      for (const n of useBar.folded) {
        posNodes.push({ ...n, x: smallUseSeg.x + smallUseSeg.width / 2, y: useBarY + CAP_BAR_H / 2, width: smallUseSeg.width, height: CAP_BAR_H })
      }
    }

    let bottom = reqBarY + CAP_BAR_H // req is the lower of the two bars now
    const isExpanded = expanded.has(`host:${host}`)
    const bullets: CapSeg[] = []
    let otherBullet: CapAggregate | undefined

    // The node row's CONTENT right edge (tracks, value labels, header) — computed BEFORE the bullets so
    // each expanded pod card can span the FULL node width (the user's "extend the pod box end-to-end to
    // align with the node box"). Pod names also factor in, so a long name never overflows the card.
    const barEnd = Math.max(
      useBar.endX,
      reqBar.endX,
      otherUseSeg ? otherUseSeg.x + otherUseSeg.width : 0,
      otherReqSeg ? otherReqSeg.x + otherReqSeg.width : 0,
    )
    const valEnd = Math.max(trackW, useTrackW, useTotal * scale, reqTotal * scale)
    const headerChars = label.length + 10 + (otherPods.length ? 15 : 0) + (overcommit ? 13 : 0)
    const headerRight = CAP_ROW_LEFT - CAP_HEADER_INSET + headerChars * CAP_HEADER_CHAR_W
    // A pod card starts CAP_BULLET_AXIS_W left of the bars (room for the same "Use"/"Req" axis label the
    // node bars carry) so its bars sit directly UNDER and aligned with the node bars at the same scale —
    // a pod's bar length reads directly against the node track above it ("feel how big each pod is").
    const cardX = CAP_ROW_LEFT - CAP_BULLET_AXIS_W
    let podNameRight = 0
    if (isExpanded) {
      for (const d of segData) podNameRight = Math.max(podNameRight, cardX + 8 + d.node.name.length * CAP_BULLET_CHAR_W + CAP_BULLET_PAD)
      if (otherPods.length) podNameRight = Math.max(podNameRight, cardX + 8 + `other namespaces · ${otherPods.length} pods`.length * CAP_BULLET_CHAR_W + CAP_BULLET_PAD)
    }
    const contentRight = Math.max(
      CAP_ROW_LEFT + Math.max(trackW, useTrackW),
      barEnd,
      CAP_ROW_LEFT + valEnd + CAP_BAR_VALUE_W,
      headerRight,
      podNameRight,
    )

    // Each pod is its own full-width bordered CARD: a name header, then two stacked bars (Use over Req)
    // at the global `scale`, drawn from CAP_ROW_LEFT — the SAME left edge and scale as the node bars, so
    // the pod bar aligns under the node track. The card spans [cardX, contentRight] (the node's content
    // width). An overshoot extends the bar past its request/limit tick; the renderer recomputes each
    // bar's fill/extent from `scale`.
    const barX = CAP_ROW_LEFT
    const barExtent = (value: number, ref: number | undefined) => Math.max(CAP_MIN_SEG, Math.max(value, ref ?? 0) * scale)
    const cardW = contentRight - cardX
    if (isExpanded && (segData.length || otherPods.length)) {
      let by = bottom + CAP_BULLET_GAP
      for (const d of segData) {
        const useBarY = by + CAP_BULLET_PAD + CAP_BULLET_NAME_H
        const regionMax = Math.max(barExtent(d.use, d.lim), barExtent(d.use, d.req))
        const focusW = Math.min(cardW, CAP_BULLET_AXIS_W + regionMax + CAP_BAR_VALUE_W)
        bullets.push({ ...d, x: barX, y: useBarY, width: regionMax, height: CAP_BULLET_H, box: { x: cardX, y: by, width: cardW, height: CAP_BULLET_CARD_H }, focusW })
        by += CAP_BULLET_CARD_H + CAP_BULLET_GAP
      }
      if (otherPods.length) {
        // One folded "other namespaces" card: its Use bar = Σ usage, Req bar = Σ request (no single
        // request/limit tick — it stands for many pods), both at the global scale like the per-pod cards.
        const useBarY = by + CAP_BULLET_PAD + CAP_BULLET_NAME_H
        const regionMax = Math.max(barExtent(otherUse, undefined), barExtent(otherReq, undefined))
        const focusW = Math.min(cardW, CAP_BULLET_AXIS_W + regionMax + CAP_BAR_VALUE_W)
        otherBullet = { variant: 'other', count: otherPods.length, use: otherUse, req: otherReq, x: barX, y: useBarY, width: regionMax, height: CAP_BULLET_H, box: { x: cardX, y: by, width: cardW, height: CAP_BULLET_CARD_H }, focusW }
        by += CAP_BULLET_CARD_H + CAP_BULLET_GAP
      }
      bottom = by - CAP_BULLET_GAP
    }

    // The Node resource itself is selectable via its header label region.
    if (nodeCard) {
      posNodes.push({ ...nodeCard, x: CAP_ROW_LEFT + 70, y: headerY + CAP_LABEL_H / 2, width: 140, height: CAP_LABEL_H })
    }

    const rowRight = contentRight
    maxRight = Math.max(maxRight, rowRight)
    rows.push({
      host,
      label,
      node: nodeCard,
      cap,
      useCap,
      reqTotal,
      useTotal,
      ownUseTotal,
      ownCount: ownPods.length,
      otherCount: otherPods.length,
      allPodIds: all.map((p) => p.id),
      nodeUse: nodeCard ? useOf(nodeCard.id) || undefined : undefined,
      overcommit,
      expanded: isExpanded,
      x: CAP_ROW_LEFT,
      y: headerY,
      width: rowRight - CAP_ROW_LEFT,
      height: bottom - headerY,
      trackY: useBarY,
      trackW,
      useTrackW,
      reqBarY,
      useSegs,
      reqSegs,
      smallUseSeg,
      smallReqSeg,
      otherUseSeg,
      otherReqSeg,
      bullets,
      otherBullet,
    })
    cursorY = bottom + CAP_ROW_GAP
  }

  return {
    nodes: posNodes,
    edges: [],
    width: maxRight + CAP_ROW_LEFT,
    height: cursorY - CAP_ROW_GAP + CAP_BOTTOM_PAD,
    rows,
    scale,
    resource,
    hasUsage,
  }
}

// formatPair renders a "value / capacity" pair with BOTH parts in ONE unit, so a node's two stacked
// bars never clash units. The unit is picked from `unitRef` (default `cap`) — pass the NODE'S TOTAL
// CAPACITY as unitRef for both the Use and Req bars so they share a unit even though their own caps
// differ: a 1-core node's Use cap is 1000m (→ cores) but its Req cap is the ~940m allocatable (which,
// judged alone, fell under the 1-core line → millicores), producing the clashing "0.06 / 1" Use over
// "480m / 940m" Req. With unitRef = total capacity, both read cores ("0.06 / 1" and "0.48 / 0.94").
// Each bar still DISPLAYS its own cap; only the unit choice is shared. CPU: cores when the ref is ≥1
// core, else millicores; memory: the ref's binary unit. Real multi-core nodes always read cores; the
// bug only ever surfaced where allocatable dipped below a whole core (hidden on integer-core dev nodes).
export function formatPair(
  value: number | undefined,
  cap: number | undefined,
  res: CapResource,
  unitRef?: number,
): { value: string; cap: string } {
  if (cap === undefined) return { value: formatQuantity(value, res), cap: '' } // no reference unit to match
  const ref = unitRef ?? cap // the value that decides the unit; the displayed cap is unchanged
  if (res === 'cpu') {
    const cores = ref >= 1000
    const f = (v: number | undefined) => (v === undefined ? '—' : cores ? `${+(v / 1000).toFixed(2)}` : `${Math.round(v)}m`)
    return { value: f(value), cap: f(cap) }
  }
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi']
  let i = 0
  let n = ref
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const div = 1024 ** i
  const f = (v: number | undefined) => (v === undefined ? '—' : `${+(v / div).toFixed(i > 0 ? 1 : 0)}${units[i]}`)
  return { value: f(value), cap: f(cap) }
}

// formatQuantity renders a canonical-unit resource value for the capacity view's labels: CPU
// millicores as cores ("1.5") or millicores ("500m") and memory bytes as binary units ("8Gi").
export function formatQuantity(v: number | undefined, res: CapResource): string {
  if (v === undefined) return '—'
  if (res === 'cpu') {
    if (v === 0) return '0'
    if (v < 1000) return `${Math.round(v)}m`
    return `${+(v / 1000).toFixed(2)}` // cores, trailing zeros dropped (1500 → "1.5", 2000 → "2")
  }
  if (v === 0) return '0'
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi']
  let i = 0
  let n = v
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${+n.toFixed(i > 0 ? 1 : 0)}${units[i]}` // "8Gi" not "8.0Gi", "8.5Gi" kept
}
