// Relationship-view layout: connected components in LR depth columns, stacked in one vertical
// column, with kind-grouped orphans beneath.
//
// A namespace is many small, disconnected trees. We lay out each connected component on its own
// (so one Dagre graph never smears every tree across a single rank), then stack the components in
// a single vertical column — one tree per row, left-aligned, never two side by side. Each tree
// flows left-to-right internally (LR rankdir), so the whole view reads like ArgoCD's resource
// tree: every tree starts at the same left edge and the eye scans straight down the list.
//
// WHY a strict column and not a viewport-aspect bin-pack (the previous design): mixing horizontal
// and vertical placement broke that single-axis scan — two trees would sometimes sit side by side,
// so "which tree am I reading" stopped being answerable by y alone. The user asked for a strict
// column across every view; we trade a taller canvas (more panning) for that uniform alignment.

import dagre from '@dagrejs/dagre'
import type { KEdge, KNode } from '../types'
import {
  BLOCK_GAP,
  type Box,
  byName,
  COL_V_GAP,
  COLLAPSE_KIND,
  type CollapseMeta,
  COLUMN_GAP,
  COMPONENT_GAP,
  type Component,
  EDGE_STUB,
  FANOUT_MIN,
  HUB_GAP,
  type Layout,
  LEAF_GAP_X,
  LEAF_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  type Point,
  type PositionedEdge,
  type PositionedNode,
} from './core'
import { foldSiblingSubtrees, splitForFold } from './collapse'
import { blockDims, findHubs, type Hub, hubArea, type LeafBlock } from './hubs'
import { type KindGroup, kindGroups, layoutGraphByKind } from './kind'

// placeSkeletonNode positions a single skeleton card at (cx, cy) and lifts a pre-fold pill's
// _collapse tag onto the PositionedNode (real cards have no _collapse, so they pass straight
// through). Used by both placers so a foldSiblingSubtrees pill carries its CollapseMeta into render.
function placeSkeletonNode(n: KNode, cx: number, cy: number): PositionedNode {
  const { _collapse, _pillSlot, ...rest } = n as KNode & { _collapse?: CollapseMeta; _pillSlot?: number }
  return { ...rest, x: cx, y: cy, width: NODE_WIDTH, height: NODE_HEIGHT, ...(_collapse ? { collapse: _collapse } : {}) }
}

// orphanBlock lays one kind's UNCONNECTED (parentless) nodes into a single collapsible grid block —
// the same compact fold a hub's per-kind leaves get, but with no hub to hang off. The ownership view
// keeps every resource in the namespace (filter.go allNodes), so a namespace's loose ConfigMaps,
// Secrets, EphemeralReports, … would otherwise be a wall of single cards; folded per kind they read as
// one framed "+N more" block. Every cell carries the `orphan:<kind>` collapseGroup so connGroups draws
// the dashed frame, and the pill drives expand/collapse through the same key as any other fold.
function orphanBlock(kind: string, list: KNode[], expanded: ReadonlySet<string>, prioritize?: (n: KNode) => boolean): Component {
  const key = `orphan:${kind}`
  const isExpanded = expanded.has(key)
  const split = splitForFold(list, isExpanded, byName, prioritize)
  const cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }> = [...split.visible]
  if (split.hidden.length) {
    const meta: CollapseMeta = { key, groupKind: kind, hidden: split.hidden, expanded: isExpanded }
    cells.splice(split.pillIndex, 0, { id: `${COLLAPSE_KIND}:${key}`, kind: COLLAPSE_KIND, name: `+${split.hidden.length} more`, health: 'Healthy', collapse: meta })
  }
  const dims = blockDims(cells.length)
  const nodes: PositionedNode[] = cells.map((cell, i) => ({
    ...cell,
    collapseGroup: key, // frame the whole block via connGroups, like a hub's per-kind leaf block
    x: Math.floor(i / dims.rows) * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2,
    y: (i % dims.rows) * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }))
  return { nodes, edges: [], width: dims.w, height: dims.h }
}

// layoutGraph lays out each connected component on its own, then stacks the components in a single
// vertical column (see packComponents). Edges with a missing endpoint are dropped defensively (the
// server should not emit them). `rankdir` switches the per-component direction — 'LR' (what every
// relationship view passes) reads left-to-right so a parent's children fan out to its right, like
// an ArgoCD tree; 'TB' (the default, kept for callers/tests) reads top-down. `prioritize` (the active
// health filter) reaches every fold site — sibling-subtree pills, orphan blocks, hub leaf grids — so
// triage never hides a matching card behind a "+N more" pill.
export function layoutGraph(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set(), prioritize?: (n: KNode) => boolean): Layout {
  // Fold crowded same-kind sibling subtrees (e.g. many Workflows under one WorkflowTemplate) before
  // anything else, so the rest of the pipeline lays out the reduced graph + its pills normally.
  ;({ nodes, edges } = foldSiblingSubtrees(nodes, edges, expanded, prioritize))
  const present = new Set(nodes.map((n) => n.id))
  const laidEdges = edges.filter((e) => present.has(e.from) && present.has(e.to))

  // Group a crowded same-kind set of unconnected nodes into one collapsible block at the bottom (see
  // orphanBlock); below the fan-out threshold they stay individual cards and flow through the normal
  // per-component path unchanged, so a couple of loose resources still read as plain cards.
  const touched = new Set<string>()
  for (const e of laidEdges) (touched.add(e.from), touched.add(e.to))
  const orphansByKind = new Map<string, KNode[]>()
  for (const n of nodes) {
    if (touched.has(n.id) || n.kind === COLLAPSE_KIND) continue
    const l = orphansByKind.get(n.kind)
    if (l) l.push(n)
    else orphansByKind.set(n.kind, [n])
  }
  const blocked = new Set<string>()
  const orphanComponents: Component[] = []
  for (const [kind, list] of [...orphansByKind].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < FANOUT_MIN) continue
    orphanComponents.push(orphanBlock(kind, list, expanded, prioritize))
    for (const n of list) blocked.add(n.id)
  }

  const groups = connectedComponents(blocked.size ? nodes.filter((n) => !blocked.has(n.id)) : nodes, laidEdges)
  // Stable vertical order: each tree keeps its row across SSE patches. node.id is a random UID, so
  // ordering by it would shuffle trees arbitrarily; the smallest kind/name in a component is stable
  // (adding/removing a pod doesn't change it) and reads sensibly (workload roots sort near the top).
  groups.sort((a, b) => componentKey(a.nodes).localeCompare(componentKey(b.nodes)))
  const components = groups.map((g) => layoutComponent(g.nodes, g.edges, rankdir, expanded, prioritize))

  // Grouped orphan blocks pack after the connectivity trees, so the tree backbone reads first.
  return packComponents([...components, ...orphanComponents])
}

// Vertical gap between the relationship trees and the kind-grouped orphan section below them.
const ORPHAN_SECTION_GAP = 96

export interface OrphanLayout extends Layout {
  // Kind bands for the orphan section, already offset into the combined coordinate space, so the
  // renderer draws the same per-kind boxes the Kind grouping uses — but only over the orphans.
  orphanGroups: KindGroup[]
}

// layoutGraphWithOrphans lays the relationship grouping out as TWO stacked regions: the connectivity
// trees on top (the usual LR depth-column layout), then — when orphans are shown — a Kind-grouped
// section beneath them, so unconnected resources read as a tidy per-kind inventory instead of a wall
// of single cards strung along the tree column. The caller decides which orphans are visible (Show
// orphaned, or the Degraded triage exception) and passes them split from the connected set; this
// function only composes the geometry. `prioritize` biases each orphan kind box's folded
// representatives toward the active health filter, matching the Kind view.
export function layoutGraphWithOrphans(
  connected: KNode[],
  orphans: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string> = new Set(),
  prioritize?: (n: KNode) => boolean,
): OrphanLayout {
  const rel = layoutGraph(connected, edges, 'LR', expanded, prioritize)
  if (orphans.length === 0) return { ...rel, orphanGroups: [] }
  // Orphans have no edges between them (that is what makes them orphans), so the Kind layout's
  // cross-kind edges resolve to nothing — pass an empty edge set.
  const section = layoutGraphByKind(orphans, [], expanded, prioritize)
  // Stack the section below the trees; no leading gap when there are no trees (an all-orphan namespace
  // then opens flush at the top instead of with dead space above it).
  const dy = rel.nodes.length ? rel.height + ORPHAN_SECTION_GAP : 0
  const orphanNodes = section.nodes.map((n) => ({ ...n, y: n.y + dy }))
  const orphanGroups = kindGroups({ ...section, nodes: orphanNodes })
  return {
    nodes: [...rel.nodes, ...orphanNodes],
    edges: rel.edges, // the orphan section contributes none
    width: Math.max(rel.width, section.width),
    height: dy + section.height,
    orphanGroups,
  }
}

// componentKey is a stable sort key for a component: the lexicographically smallest "kind/name"
// among its nodes. Independent of node.id (a random UID) and of node array order, so the vertical
// stacking order holds steady as the graph churns.
function componentKey(nodes: KNode[]): string {
  let min = `${nodes[0].kind}/${nodes[0].name}`
  for (const n of nodes) {
    const k = `${n.kind}/${n.name}`
    if (k < min) min = k
  }
  return min
}

// connectedComponents groups nodes into weakly-connected components (edges treated as undirected)
// via union-find, so each ownership tree / cluster is laid out and packed independently.
function connectedComponents(nodes: KNode[], edges: KEdge[]): { nodes: KNode[]; edges: KEdge[] }[] {
  const parent = new Map<string, string>()
  nodes.forEach((n) => parent.set(n.id, n.id))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (const e of edges) union(e.from, e.to)

  const byRoot = new Map<string, { nodes: KNode[]; edges: KEdge[] }>()
  for (const n of nodes) {
    const r = find(n.id)
    if (!byRoot.has(r)) byRoot.set(r, { nodes: [], edges: [] })
    byRoot.get(r)!.nodes.push(n)
  }
  for (const e of edges) byRoot.get(find(e.from))!.edges.push(e)
  return [...byRoot.values()]
}

// orthRoute builds an orthogonal ("blocky") connector between two card boxes — only horizontal and
// vertical segments, the ArgoCD resource-tree look. In LR every link leaves the source's RIGHT edge
// and enters the target's LEFT edge, so a parent's links all fan out of its right side and a child's
// all arrive at its left side; that single rule is what makes a dense graph's arrows legible. The
// common forward edge (target clearly to the right — guaranteed by hub wrapping keeping parents on
// the left) becomes a three-segment "S": horizontal out to a mid-x gutter, vertical to the target's
// row, horizontal in. A same-row edge collapses to one straight line. A rare edge whose target is
// not clearly to the right detours through a mid-y lane via outward stubs so it still leaves-right /
// enters-left rather than cutting back through a box. TB mirrors the whole thing onto the y axis
// (bottom→top) for the test-only vertical layout.
function orthRoute(a: Box, b: Box, rankdir: 'TB' | 'LR'): Point[] {
  if (rankdir === 'TB') {
    const start = { x: a.x, y: a.y + a.height / 2 }
    const end = { x: b.x, y: b.y - b.height / 2 }
    if (Math.abs(start.x - end.x) < 0.5) return [start, end]
    if (end.y - start.y >= 2 * EDGE_STUB) {
      const midY = (start.y + end.y) / 2
      return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]
    }
    const oy = start.y + EDGE_STUB
    const iy = end.y - EDGE_STUB
    const midX = (start.x + end.x) / 2
    return [start, { x: start.x, y: oy }, { x: midX, y: oy }, { x: midX, y: iy }, { x: end.x, y: iy }, end]
  }
  const start = { x: a.x + a.width / 2, y: a.y }
  const end = { x: b.x - b.width / 2, y: b.y }
  if (Math.abs(start.y - end.y) < 0.5) return [start, end]
  if (end.x - start.x >= 2 * EDGE_STUB) {
    const midX = (start.x + end.x) / 2
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]
  }
  const ox = start.x + EDGE_STUB
  const ix = end.x - EDGE_STUB
  const midY = (start.y + end.y) / 2
  return [start, { x: ox, y: start.y }, { x: ox, y: midY }, { x: ix, y: midY }, { x: ix, y: end.y }, end]
}

// computeRanks assigns each node an integer depth (longest path from a source) over the FULL graph —
// every node, including a hub's wrapped leaves. Computing depth on the whole graph (not the
// hub-stripped skeleton) is what keeps a fan-in hub's wrapped PARENTS at their true shallow depth
// instead of parked next to the deep node they point at. Sources are depth 0; an edge from→to forces
// depth(to) ≥ depth(from)+1. Bounded relaxation tolerates the rare cycle without looping forever.
function computeRanks(nodes: KNode[], edges: KEdge[]): Map<string, number> {
  const rank = new Map(nodes.map((n) => [n.id, 0]))
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const e of edges) {
      const rf = rank.get(e.from)
      const rt = rank.get(e.to)
      if (rf === undefined || rt === undefined) continue
      if (rt < rf + 1) { rank.set(e.to, rf + 1); changed = true }
    }
    if (!changed) break
  }
  return rank
}

// dagreSeedY runs Dagre over the skeleton (uniform card sizes) purely to borrow its crossing-minimized
// vertical ORDER as a seed — placeColumns keeps the y and discards Dagre's x (the depth columns own x).
function dagreSeedY(skeleton: KNode[], edges: KEdge[], wrapped: ReadonlySet<string>): Map<string, number> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: COLUMN_GAP, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of skeleton) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  for (const e of edges) if (!wrapped.has(e.from) && !wrapped.has(e.to)) g.setEdge(e.from, e.to)
  dagre.layout(g)
  return new Map(skeleton.map((n) => [n.id, g.node(n.id).y as number]))
}

// A column-placement unit: one card or one wrapped leaf block, at a depth, with a seed y and a placer
// that emits its PositionedNode(s) once the column's x and the unit's stacked top are resolved. `kind`
// drives the inter-group gap: same-kind neighbours pack tight (COL_V_GAP), different kinds get the
// wider BLOCK_GAP so each kind reads as its own group (the user's "little spacing between kinds").
// `group` identifies a set of same-parent same-kind siblings (a StatefulSet's pods): siblings are
// ordered among THEMSELVES by natural name (so they read web-0,1,2), and the group as a whole is
// centred on the mean of its referrers' placed positions. `name` is the natural-sort key within a
// group ('' for leaf blocks). `id` (skeleton card only) lets a child column read this card's placed
// centre; `parent` is the PRIMARY parent (the grouping key — see parentOf); `parents` is EVERY
// shallower referrer (a hub id for its leaf blocks), so a multi-referenced group can centre on all
// of them rather than snapping to one.
interface ColUnit {
  rank: number
  kind: string
  group: string
  name: string
  w: number
  h: number
  seedY: number
  id?: string
  parent?: string
  parents?: string[]
  // Set on a foldSiblingSubtrees pill: its target row among the visible siblings of its group, so the
  // pill slots between head and tail (collapsed) / at the bottom (expanded) instead of sorting by name.
  pillSlot?: number
  place: (left: number, top: number) => void
}

// placeColumns is the LR layout: strict depth columns. Every node sits in the column of its graph
// depth (computeRanks over the full graph), so the most-parent resources share the leftmost column,
// their children the next, and so on — the alignment an operator expects even when relationships fan
// out (the Volumes "boxes everywhere" report). A column's WIDTH grows to fit the widest unit in it, so
// a large same-kind group still wraps into a smart grid block (blockDims) and merely makes its column
// wider — without knocking any other column out of depth alignment. Vertical order within a column is
// seeded from Dagre's crossing-minimized ordering, then de-overlapped downward so nothing collides
// while staying near its seed (which keeps children roughly across from their parent). This replaces
// the old "Dagre lays the skeleton, grids are parked next to their hub card" placement, which let a
// hub's wide reserved box shove its card out of its rank and stranded wrapped leaves in a private
// near-hub column instead of their true depth column.
function placeColumns(nodes: KNode[], edges: KEdge[], hubs: Hub[], wrapped: Set<string>): PositionedNode[] {
  const rank = computeRanks(nodes, edges)
  const skeleton = nodes.filter((n) => !wrapped.has(n.id))
  const seedY = dagreSeedY(skeleton, edges, wrapped)
  const out: PositionedNode[] = []
  const units: ColUnit[] = []

  // Every shallower source of an edge into a node is a "referrer" — with several relationship
  // categories active a Pod collects more than one (its ReplicaSet via ownerReference, a Service
  // via selects). The PRIMARY parent defines sibling grouping (same parent + same kind ⇒ one
  // name-ordered, tightly-packed group): an ownerReference wins over the looser reference edges,
  // then the shallower source, then the smaller id. Picking by rank alone let a rank tie fall
  // through to the id comparison — a random UID — so whether a tree's pods grouped under their
  // ReplicaSet or their Service was a per-tree coin flip that read as non-deterministic placement.
  // ALL referrers stay on the unit: the group's vertical position reconciles them (`desired` below).
  // A node with no shallower neighbour (a root / fan-in source) is its own group, left in Dagre's
  // order.
  const ownerPrio = (e: KEdge) => (e.type === 'ownerReference' ? 0 : 1)
  const referrersOf = new Map<string, KEdge[]>()
  for (const e of edges) {
    if (wrapped.has(e.from) || wrapped.has(e.to)) continue
    const rf = rank.get(e.from) ?? 0
    const rt = rank.get(e.to) ?? 0
    if (rf >= rt) continue // only a shallower source reads as a parent of e.to
    const list = referrersOf.get(e.to)
    if (list) list.push(e)
    else referrersOf.set(e.to, [e])
  }
  const parentOf = new Map<string, string>()
  for (const [id, refs] of referrersOf) {
    const best = refs.reduce((b, e) => {
      if (ownerPrio(e) !== ownerPrio(b)) return ownerPrio(e) < ownerPrio(b) ? e : b
      const re = rank.get(e.from) ?? 0
      const rb = rank.get(b.from) ?? 0
      if (re !== rb) return re < rb ? e : b
      return e.from < b.from ? e : b
    })
    parentOf.set(id, best.from)
  }

  for (const n of skeleton) {
    const r = rank.get(n.id) ?? 0
    const par = parentOf.get(n.id)
    // A foldSiblingSubtrees pill joins its siblings' column group (keyed by the real kind it stands in
    // for) so it shares their frame and slots in by row, rather than forming a stray __collapse__ group.
    const meta = n as KNode & { _collapse?: CollapseMeta; _pillSlot?: number; collapseGroup?: string }
    const isPill = n.kind === COLLAPSE_KIND && !!meta._collapse
    const groupKind = isPill ? meta._collapse!.groupKind : n.kind
    // A folded sibling group carries ONE collapseGroup key on every member AND its pill. Group by that
    // key when present so the pill always lands in its siblings' column — keying by primary parent
    // splits them when the pill's owning parent differs from the siblings' shallowest parent (a
    // multi-parent group: NodeClaims' pill hangs off the NodePool, but the cards' shallowest parent is
    // the EC2NodeClass, so the pill stranded at the column's bottom instead of between head and tail).
    const group = meta.collapseGroup ?? (par !== undefined ? `${par}|${groupKind}` : `root:${n.id}`)
    units.push({
      rank: r, kind: groupKind, group, name: n.name,
      w: NODE_WIDTH, h: NODE_HEIGHT, seedY: seedY.get(n.id) ?? 0, id: n.id, parent: par,
      parents: referrersOf.get(n.id)?.map((e) => e.from),
      pillSlot: isPill ? meta._pillSlot : undefined,
      place: (left, top) => out.push(placeSkeletonNode(n, left + NODE_WIDTH / 2, top + NODE_HEIGHT / 2)),
    })
  }
  for (const hub of hubs) {
    const hr = rank.get(hub.id) ?? 0
    const r = hub.after ? hr + 1 : hr - 1 // children sit one column right; fan-in parents one column left
    const areaH = hubArea(hub.blocks, 'LR').h
    let top = (seedY.get(hub.id) ?? 0) - areaH / 2 // seed only; the block stack is re-centred on the hub below
    for (const b of hub.blocks) {
      const block = b
      units.push({
        rank: r, kind: block.kind, group: `block:${hub.id}:${block.kind}`, name: '',
        w: block.w, h: block.h, seedY: top + block.h / 2, parent: hub.id, parents: [hub.id],
        place: (left, t) => placeBlockCells(block, left, t, out),
      })
      top += block.h + BLOCK_GAP
    }
  }

  // Column x: each depth's width is its widest unit; columns run left→right separated by COLUMN_GAP.
  const colWidth = new Map<number, number>()
  for (const u of units) colWidth.set(u.rank, Math.max(colWidth.get(u.rank) ?? NODE_WIDTH, u.w))
  const ranks = [...colWidth.keys()].sort((a, b) => a - b)
  const colLeft = new Map<number, number>()
  let cx = 0
  for (const r of ranks) { colLeft.set(r, cx); cx += colWidth.get(r)! + COLUMN_GAP }

  // Within each column we place one GROUP (same parent + same kind) at a time, vertically CENTRED on
  // the MEAN of its referrers' already-placed centres — columns are processed left→right (ranks
  // ascending), so by the time a child column is laid out every referrer in a shallower column has a
  // real position recorded in `placedCenter`. With one referrer (the ownership view) that mean IS the
  // parent's centre: this is what keeps children "right next to" their parent — re-packing a parent
  // column moves a card off its raw Dagre seed, and a child centred on the seed (the old behaviour)
  // drifted away. With several referrers (Ownership + Network: a Pod fed by both its ReplicaSet and a
  // Service) the group sits midway between them, so every tree reads the same instead of each pod
  // snapping to whichever single referrer happened to win the primary-parent pick. A group with no
  // placed referrer (a root / fan-in source) falls back to its own seed. Units INSIDE a group are
  // ordered by natural name (so a StatefulSet's pods read web-0,1,2) and packed tight (COL_V_GAP).
  //
  // Overlapping groups are de-overlapped by a standard 1-D cluster merge rather than a one-directional
  // push-down: when a group would collide with the one above it the two merge into a CLUSTER laid out
  // contiguously, and the cluster is positioned to minimise the squared distance of every member from its
  // own desired centre (T = mean(desired − offset)). So a parent's many children straddle the parent's
  // height instead of all starting at it and cascading down — the "centred around the parent" the user
  // asked for. The connecting gap is kind-aware (same kind COL_V_GAP, different kinds the wider BLOCK_GAP)
  // so each kind still reads as its own group and a dense column never blows up vertically.
  const placedCenter = new Map<string, number>()
  for (const r of ranks) {
    const col = units.filter((u) => u.rank === r)
    const groups = new Map<string, ColUnit[]>()
    for (const u of col) (groups.get(u.group) ?? groups.set(u.group, []).get(u.group)!).push(u)
    const blocks = [...groups.entries()].map(([key, gusRaw]) => {
      // Real cards order by natural name; pills splice into their slot (ascending) afterwards, so a
      // folded sibling group reads head → "+N more" → tail down the column.
      const reals = gusRaw.filter((u) => u.pillSlot === undefined).sort((a, b) => byName(a, b) || a.seedY - b.seedY)
      const pillsInGroup = gusRaw.filter((u) => u.pillSlot !== undefined).sort((a, b) => a.pillSlot! - b.pillSlot!)
      for (const p of pillsInGroup) reals.splice(Math.min(p.pillSlot!, reals.length), 0, p)
      const gus = reals
      const h = gus.reduce((s, u) => s + u.h, 0) + Math.max(0, gus.length - 1) * COL_V_GAP
      const parent = gus[0].parent
      // Barycenter over the group's DISTINCT placed referrers: one shared Service selecting all of a
      // ReplicaSet's pods pulls once, not once per pod.
      const refs = [...new Set(gus.flatMap((u) => u.parents ?? []))].filter((p) => placedCenter.has(p))
      const desired = refs.length
        ? refs.reduce((s, p) => s + placedCenter.get(p)!, 0) / refs.length
        : gus.reduce((s, u) => s + u.seedY, 0) / gus.length
      return { key, gus, h, kind: gus[0].kind, parent, desired }
    })
    blocks.sort((a, b) => a.desired - b.desired || a.key.localeCompare(b.key))
    // Tight COL_V_GAP only between groups that are the SAME kind AND the SAME parent — i.e. one logical
    // cluster (fan-in roots all share an undefined parent). Two same-kind groups under DIFFERENT parents
    // (e.g. each CronWorkflow's own wrapped Workflow block) are distinct, separately-framed groupings and
    // get the wider BLOCK_GAP, matching the margin between a parent's differing-kind child groups.
    const gapBefore = blocks.map((b, i) =>
      i === 0 ? 0 : b.kind === blocks[i - 1].kind && b.parent === blocks[i - 1].parent ? COL_V_GAP : BLOCK_GAP,
    )

    // Greedy cluster merge: each cluster is a contiguous run of blocks laid out from its top `t`; `off` is
    // a block's centre offset within the cluster. A new block joins as its own cluster, then merges left
    // while it overlaps the cluster above it. After each merge the cluster's bounding box is recentred on
    // the mean of its members' desired centres — so the whole run STRADDLES the parent (its geometric
    // middle on the parent's height) instead of starting at the parent and cascading down. Centring the
    // bbox (not the least-squares mean of per-block offsets) is what the user asked for: a tall wrapped
    // block in the run must not skew where the extent sits relative to the parent.
    type Member = { blk: (typeof blocks)[number]; off: number }
    const clusters: { members: Member[]; height: number; top: number }[] = []
    const recenter = (c: (typeof clusters)[number]) => {
      const meanDesired = c.members.reduce((s, m) => s + m.blk.desired, 0) / c.members.length
      c.top = meanDesired - c.height / 2
    }
    for (const blk of blocks) {
      const c = { members: [{ blk, off: blk.h / 2 }], height: blk.h, top: blk.desired - blk.h / 2 }
      clusters.push(c)
      while (clusters.length >= 2) {
        const cur = clusters[clusters.length - 1]
        const prev = clusters[clusters.length - 2]
        const gap = gapBefore[blocks.indexOf(cur.members[0].blk)]
        if (prev.top + prev.height + gap <= cur.top) break // no overlap — leave both placed
        const base = prev.height + gap
        for (const m of cur.members) prev.members.push({ blk: m.blk, off: base + m.off })
        prev.height = base + cur.height
        recenter(prev)
        clusters.pop()
      }
    }

    for (const c of clusters) {
      for (const m of c.members) {
        let cursor = c.top + m.off - m.blk.h / 2 // cluster top + block-centre offset − half block = block top
        for (const u of m.blk.gus) {
          u.place(colLeft.get(r)!, cursor)
          if (u.id !== undefined) placedCenter.set(u.id, cursor + u.h / 2)
          cursor += u.h + COL_V_GAP
        }
      }
    }
  }
  return out
}

// placeWithDagre is the TB (test/legacy) placement: Dagre lays the skeleton, reserving a tall box per
// hub so its leaf grid stacks below the card. The LR connectivity views use placeColumns instead.
function placeWithDagre(nodes: KNode[], edges: KEdge[], hubs: Hub[], wrapped: Set<string>, rankdir: 'TB' | 'LR'): PositionedNode[] {
  const hubById = new Map(hubs.map((h) => [h.id, h]))
  const areaById = new Map(hubs.map((h) => [h.id, hubArea(h.blocks, rankdir)]))
  const skeleton = nodes.filter((n) => !wrapped.has(n.id))
  const skeletonEdges = edges.filter((e) => !wrapped.has(e.from) && !wrapped.has(e.to))
  const ranksep = rankdir === 'LR' ? 80 : 52
  const hubGap = rankdir === 'LR' ? ranksep : HUB_GAP
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir, nodesep: 24, ranksep, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of skeleton) {
    const hub = hubById.get(n.id)
    if (hub) {
      const area = areaById.get(n.id)!
      if (rankdir === 'LR') {
        g.setNode(n.id, { width: NODE_WIDTH + hubGap + area.w, height: Math.max(NODE_HEIGHT, area.h) })
      } else {
        g.setNode(n.id, { width: Math.max(NODE_WIDTH, area.w), height: NODE_HEIGHT + hubGap + area.h })
      }
    } else {
      g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
  }
  for (const e of skeletonEdges) g.setEdge(e.from, e.to)
  dagre.layout(g)

  const positioned: PositionedNode[] = []
  for (const n of skeleton) {
    const p = g.node(n.id)
    const hub = hubById.get(n.id)
    if (!hub) {
      positioned.push(placeSkeletonNode(n, p.x, p.y))
      continue
    }
    const area = areaById.get(n.id)!
    const boxH = NODE_HEIGHT + hubGap + area.h
    const top = p.y - boxH / 2
    const cardY = hub.after ? top + NODE_HEIGHT / 2 : p.y + boxH / 2 - NODE_HEIGHT / 2
    const gridTop = hub.after ? top + NODE_HEIGHT + hubGap : top
    positioned.push({ ...n, x: p.x, y: cardY, width: NODE_WIDTH, height: NODE_HEIGHT })
    placeBlocksTB(hub, p.x, gridTop, area.w, positioned)
  }
  return positioned
}

// layoutComponent lays out one connected component at origin (0,0) and returns its bounding size.
// rankdir picks the strategy: 'LR' (every connectivity view) uses placeColumns — strict depth columns
// with grid-wrapped hubs; 'TB' (test/legacy) uses placeWithDagre. Edge routing, bundled hub↔pill
// edges, and normalization are shared across both.
function layoutComponent(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set(), prioritize?: (n: KNode) => boolean): Component {
  const { hubs, wrapped } = findHubs(nodes, edges, expanded, prioritize)
  const positioned = rankdir === 'LR'
    ? placeColumns(nodes, edges, hubs, wrapped)
    : placeWithDagre(nodes, edges, hubs, wrapped, rankdir)

  const posById = new Map(positioned.map((n) => [n.id, n]))
  const positionedEdges: PositionedEdge[] = []
  // Route every edge orthogonally between its two card boxes — right-of-parent → left-of-child (LR).
  // Wrapped hub↔leaf edges and Dagre skeleton edges resolve through the SAME box-to-box routing: we
  // discard Dagre's spline interior, because a blocky line in the empty inter-rank gutter reads far
  // better than a diagonal and the gutter is clear by construction (cards live within ranks, not the
  // gaps). Edges into a hub anchor on the hub CARD (its positioned node is the card, not the wide
  // reserved box). An edge to a hidden (folded) leaf finds no positioned target and is dropped — the
  // bundled hub↔pill edge below stands in for the whole fold.
  for (const e of edges) {
    const a = posById.get(e.from)
    const b = posById.get(e.to)
    if (a && b) positionedEdges.push({ ...e, points: orthRoute(a, b, rankdir) })
  }

  // Bundled hub↔pill edges (D6): one orthogonal connector standing in for the many edges to the
  // leaves the pill folds away, typed by the relationship the siblings shared with the hub. Drawn in
  // the real direction so the arrow flows the same way as the unfolded edges would: children fold →
  // hub→pill, parents fold → pill→hub.
  for (const hub of hubs) {
    if (!posById.has(hub.id)) continue
    for (const pill of hub.pills) {
      if (!posById.has(pill.id)) continue
      const [from, to] = hub.after ? [hub.id, pill.id] : [pill.id, hub.id]
      positionedEdges.push({ from, to, type: pill.type, points: orthRoute(posById.get(from)!, posById.get(to)!, rankdir) })
    }
  }

  const xs = positioned.flatMap((n) => [n.x - n.width / 2, n.x + n.width / 2])
  const ys = positioned.flatMap((n) => [n.y - n.height / 2, n.y + n.height / 2])
  const width = xs.length ? Math.max(...xs) - Math.min(...xs) : NODE_WIDTH
  const height = ys.length ? Math.max(...ys) - Math.min(...ys) : NODE_HEIGHT
  // Normalize so the component's top-left is at (0,0) for packing.
  const minX = xs.length ? Math.min(...xs) : 0
  const minY = ys.length ? Math.min(...ys) : 0
  for (const n of positioned) {
    n.x -= minX
    n.y -= minY
  }
  for (const e of positionedEdges) e.points = e.points.map((p) => ({ x: p.x - minX, y: p.y - minY }))
  return { nodes: positioned, edges: positionedEdges, width, height }
}

// placeBlockCells fills one per-kind block's cells column-major (top-to-bottom, then the next column
// rightward) into a box whose top-left is (blockLeft, blockTop), so the block's pill (its last cell)
// lands at the bottom of its last column, vertically aligned under the kind's cards.
function placeBlockCells(b: LeafBlock, blockLeft: number, blockTop: number, out: PositionedNode[]): void {
  b.cells.forEach((cell, i) => {
    const col = Math.floor(i / b.rows)
    const row = i % b.rows
    const x = blockLeft + col * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2
    const y = blockTop + row * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2
    out.push({ ...cell, x, y, width: NODE_WIDTH, height: NODE_HEIGHT })
  })
}

// placeBlocksTB lays a hub's per-kind blocks left-to-right below the hub at a single y (all children
// on the same level), the whole row centered on the hub's centerX, each block filling its column down.
function placeBlocksTB(hub: Hub, centerX: number, gridTop: number, areaW: number, out: PositionedNode[]): void {
  let x = centerX - areaW / 2
  for (const b of hub.blocks) {
    placeBlockCells(b, x, gridTop, out)
    x += b.w + BLOCK_GAP
  }
}

// packComponents stacks each component in a single vertical column — one per row, left-aligned,
// never two side by side — so the view reads top-to-bottom as a list of trees (the ArgoCD shape the
// user asked for). Components keep their incoming order; callers pre-sort into a stable sequence
// (layoutGraph by componentKey; the grouped views alphabetically) so a tree holds its slot across
// patches. gap overrides COMPONENT_GAP where group boxes need more breathing room.
function packComponents(components: Component[], gap = COMPONENT_GAP): Layout {
  if (components.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const margin = 28
  const allNodes: PositionedNode[] = []
  const allEdges: PositionedEdge[] = []
  let cursorY = margin
  let maxRight = 0

  for (const c of components) {
    // Every component's left edge sits at `margin`, so all trees share one left gutter — the
    // alignment that lets the eye scan straight down the roots.
    const dx = margin
    const dy = cursorY
    for (const n of c.nodes) allNodes.push({ ...n, x: n.x + dx, y: n.y + dy })
    for (const e of c.edges) allEdges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
    maxRight = Math.max(maxRight, dx + c.width)
    cursorY = dy + c.height + gap
  }

  return {
    nodes: allNodes,
    edges: allEdges,
    width: maxRight + margin,
    height: cursorY - gap + margin, // cursorY overshot by one trailing gap after the last row
  }
}
