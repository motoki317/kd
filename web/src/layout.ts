// Pure graph layout: turns nodes+edges into positioned geometry. No DOM, so it is
// unit-testable. See docs/ADR/20260527-frontend-stack.md.
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
import type { EdgeType, KEdge, KNode } from './types'

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 60

// byName orders resources by name with numeric awareness, so an ordinal suffix sorts numerically
// (web-2 before web-10, not lexically after it) and a StatefulSet's pods read 0,1,2,… rather than the
// lexical 0,1,10,2. Used everywhere same-kind resources are listed, grid-packed, or folded.
export const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true })

// Target width:height of the packed block, so fit-to-view fills both axes instead of a thin band.
const TARGET_ASPECT = 1.7
const COMPONENT_GAP = 46

// A hub with at least this many leaf-neighbors (a Node hosting pods, a ReplicaSet with many
// replicas) gets its leaves grid-wrapped instead of strung across one Dagre rank.
const FANOUT_MIN = 5
const LEAF_GAP_X = 18
const LEAF_GAP_Y = 16
const HUB_GAP = 36 // vertical gap between a hub card and its grid of leaves
// A hub's leaves are grouped per kind into separate blocks (Services together, Secrets together, …),
// each a vertical column so its "+N older" pill sits at the bottom, vertically aligned under the
// kind's cards. LEAF_COL_MAX caps a column's height so an expanded kind (many cards) wraps into more
// columns instead of one absurdly tall stack; collapsed blocks (≤ COLLAPSE_VISIBLE+1) never hit it.
// BLOCK_GAP separates adjacent per-kind blocks with room for each block's grouping frame.
const LEAF_COL_MAX = 8
const BLOCK_GAP = 30

// EDGE_STUB is the minimum straight run an orthogonal edge takes off a box before it may turn, so a
// link always reads as leaving the parent's RIGHT edge and entering the child's LEFT edge (LR) even
// when the two cards nearly share a column. See orthRoute.
const EDGE_STUB = 16

// LR depth-column layout (placeColumns): COLUMN_GAP is the horizontal gap between adjacent depth
// columns; COL_V_GAP is the minimum vertical gap between two stacked units (cards or grid blocks)
// within one column.
const COLUMN_GAP = 80
const COL_V_GAP = 18

export interface Point {
  x: number
  y: number
}

// A positioned box, enough geometry to anchor an orthogonal edge on one of its four sides.
interface Box {
  x: number
  y: number
  width: number
  height: number
}

// COLLAPSE_KIND marks a synthetic "+N older" pill — a PositionedNode that stands in for the older
// same-kind resources hidden behind a collapse, not a real cluster object. Topology renders these
// specially and excludes them from kind stats / search / nav.
export const COLLAPSE_KIND = '__collapse__'
// When a crowded same-kind cluster folds we keep the FIRST card and the LAST COLLAPSE_TAIL of the
// natural-sorted run and hide the MIDDLE behind the pill. Keeping a contiguous head+tail of the *same*
// order the expanded view uses means expanding only fills the gap in the middle — it never reshuffles
// the cards, so the operator's eye keeps its place. (The old fold kept the "newest N by creation time",
// so expanding swapped to name order and the whole group jumped — disorienting.) 1 + 2 keeps the lowest
// ordinal (e.g. web-0) and the two latest in view. A cluster folds only when the hidden middle has at
// least COLLAPSE_MIN_HIDDEN cards, so a lone "+1" pill never replaces a card it could have just shown.
const COLLAPSE_HEAD = 1
const COLLAPSE_TAIL = 2
export const COLLAPSE_VISIBLE = COLLAPSE_HEAD + COLLAPSE_TAIL
const COLLAPSE_MIN_HIDDEN = 2

// CollapseMeta rides on the synthetic pill so Topology can expand it (key), attribute its box to the
// real kind (groupKind), and count how many hidden nodes match the active filter (hidden).
export interface CollapseMeta {
  key: string // stable expansion key, prefixed by container type: "kind:Pod" / "host:<node>"
  groupKind: string // the real kind being collapsed, for kindGroups attribution + the pill label
  hidden: KNode[] // the nodes this fold covers — actually hidden when collapsed, shown when expanded
  // True once this cluster is expanded: the pill stays as a "show fewer" re-collapse toggle (the
  // older cards are now drawn), so a single pill drives both directions (FR: expand AND collapse).
  expanded: boolean
  // Descendant nodes folded away ALONGSIDE the hidden siblings (a folded Workflow drags its Pods
  // with it). Of a different kind than groupKind, so they're tracked separately from `hidden`: the
  // "+N more" label counts siblings only, but the kind chips fold these back too so a different
  // kind's count stays honest while collapsed. Empty for same-kind leaf folds.
  hiddenDescendants?: KNode[]
}

export interface PositionedNode extends KNode {
  // x, y are the node center (Dagre's convention), in graph coordinates.
  x: number
  y: number
  width: number
  height: number
  // Present iff this is a synthetic "+N older" pill rather than a real resource card.
  collapse?: CollapseMeta
  // Connectivity-view collapse membership: a visible card tagged with the collapse key of the
  // hub/kind cluster it belongs to, so Topology can frame the fold (siblings + pill) with one
  // grouping border. Only set for foldable hub-leaf clusters; pills carry the key via `collapse`.
  collapseGroup?: string
}

export interface PositionedEdge extends KEdge {
  points: Point[]
}

export interface Layout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  width: number
  height: number
}

interface Component {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  width: number
  height: number
}

// KIND_HEADER_HEIGHT reserves vertical space at the top of each kind box for the kind icon + label
// rendered by the Topology (a 12px icon at top, then a text row). 30px gives comfortable padding.
export const KIND_HEADER_HEIGHT = 30

// splitForFold sorts a same-kind cluster by natural name order (numeric-aware, so web-2 precedes
// web-10 and a StatefulSet reads 0,1,2,…) and partitions it for collapsing: the first COLLAPSE_HEAD
// and last COLLAPSE_TAIL cards stay visible, the middle hides behind the pill. `pillIndex` tells the
// caller where to splice the "+N more" pill into `visible` — between head and tail while collapsed,
// at the very end once expanded (the full run then reads in natural order followed by a trailing
// show-fewer toggle). Because head and tail keep their slots in both states, expanding only reveals
// the hidden middle — it never reshuffles the visible cards (FR: order preserved on expand/collapse).
// `cmp` overrides the order (the Nodes view sorts troubled pods first); the fold still keeps the
// head+tail of whatever order it produces. A cluster folds only when the middle has ≥ COLLAPSE_MIN_HIDDEN.
function splitForFold(
  nodes: KNode[],
  expanded: boolean,
  cmp: (a: KNode, b: KNode) => number = byName,
  prioritize?: (n: KNode) => boolean,
): { visible: KNode[]; hidden: KNode[]; pillIndex: number } {
  const sorted = [...nodes].sort(cmp)
  if (sorted.length < COLLAPSE_VISIBLE + COLLAPSE_MIN_HIDDEN) {
    return { visible: sorted, hidden: [], pillIndex: sorted.length }
  }
  // Triage mode: when a filter marks a SUBSET of the cluster as matches (e.g. the Degraded health
  // legend), float those matches to the visible slots instead of the name-ordinal head+tail — so a
  // folded group shows its matching cards as the representatives, not arbitrary healthy ones buried
  // behind the "+N more" pill. Matches keep their natural order and stay put when the pill expands
  // (expand only reveals the folded remainder below them), preserving the no-reshuffle invariant.
  if (prioritize) {
    const matchSet = new Set(sorted.filter(prioritize).map((n) => n.id))
    if (matchSet.size > 0 && matchSet.size < sorted.length) {
      const ordered = [...sorted.filter((n) => matchSet.has(n.id)), ...sorted.filter((n) => !matchSet.has(n.id))]
      const hidden = ordered.slice(COLLAPSE_VISIBLE)
      if (expanded) return { visible: ordered, hidden, pillIndex: ordered.length }
      return { visible: ordered.slice(0, COLLAPSE_VISIBLE), hidden, pillIndex: COLLAPSE_VISIBLE }
    }
  }
  const hidden = sorted.slice(COLLAPSE_HEAD, sorted.length - COLLAPSE_TAIL)
  if (expanded) return { visible: sorted, hidden, pillIndex: sorted.length }
  const visible = [...sorted.slice(0, COLLAPSE_HEAD), ...sorted.slice(sorted.length - COLLAPSE_TAIL)]
  return { visible, hidden, pillIndex: COLLAPSE_HEAD }
}

// foldSiblingSubtrees folds a parent's crowded same-kind children into a "+N more" pill EVEN when
// those children own subtrees — the case findHubs/leaf-blocks can't handle (it only wraps degree-1
// leaves). A column of Argo Workflows under one WorkflowTemplate is the motivating case: the
// running/failed ones own Pods (so they have degree > 1) and therefore never folded, leaving the
// column cluttered no matter how many runs piled up. Here we fold across the WHOLE same-kind group,
// status-agnostic: the head+tail of the natural-sorted run stay (with their subtrees), the hidden
// middle — and its descendant subtrees — folds away behind one pill, all restored on expand.
//
// It runs as a pre-layout graph rewrite (returns reduced nodes+edges plus synthetic pill nodes) so
// the intricate column / leaf-block placement downstream is untouched: a pill is just another child
// of the hub. Pure degree-1 leaf clusters (a Node's 50 Pods) are deliberately LEFT ALONE — they fold
// more compactly through the existing leaf-block grid — so this only engages when a same-kind sibling
// group contains a non-leaf (a child with its own children).
function foldSiblingSubtrees(
  nodes: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string>,
): { nodes: KNode[]; edges: KEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childEdgesOf = new Map<string, KEdge[]>()
  const isParent = new Set<string>() // node has at least one child (is a non-leaf)
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const list = childEdgesOf.get(e.from)
    if (list) list.push(e)
    else childEdgesOf.set(e.from, [e])
    isParent.add(e.from)
  }
  // descendantsOf collects every node reachable downward from the given roots (excluding the roots),
  // following child edges — the subtree that folds away with a hidden sibling. BFS, cycle-guarded.
  const descendantsOf = (roots: string[]): KNode[] => {
    const seen = new Set(roots)
    const out: KNode[] = []
    const queue = [...roots]
    while (queue.length) {
      for (const e of childEdgesOf.get(queue.shift()!) ?? []) {
        if (seen.has(e.to)) continue
        seen.add(e.to)
        const n = byId.get(e.to)
        if (n) out.push(n)
        queue.push(e.to)
      }
    }
    return out
  }

  const removed = new Set<string>()
  const pills: Array<KNode & { _collapse: CollapseMeta }> = []
  const pillEdges: KEdge[] = []
  for (const [parentId, childEdges] of childEdgesOf) {
    const byKind = new Map<string, { node: KNode; type: EdgeType }[]>()
    for (const e of childEdges) {
      const child = byId.get(e.to)!
      const g = byKind.get(child.kind)
      if (g) g.push({ node: child, type: e.type })
      else byKind.set(child.kind, [{ node: child, type: e.type }])
    }
    for (const [kind, group] of byKind) {
      if (kind === COLLAPSE_KIND) continue
      // Only groups the leaf-block path can't fold: at least one sibling owns a subtree. Pure-leaf
      // groups keep their compact grid fold via findHubs/collapseHubLeaves.
      if (!group.some((g) => isParent.has(g.node.id))) continue
      const key = `sib:${parentId}:${kind}`
      const isExpanded = expanded.has(key)
      const { hidden } = splitForFold(group.map((g) => g.node), isExpanded)
      if (hidden.length < COLLAPSE_MIN_HIDDEN) continue

      const descendants = descendantsOf(hidden.map((n) => n.id))
      pills.push({
        id: `${COLLAPSE_KIND}:${key}`,
        kind: COLLAPSE_KIND,
        name: `+${hidden.length} more`,
        health: 'Healthy',
        _collapse: { key, groupKind: kind, hidden, expanded: isExpanded, hiddenDescendants: descendants },
      })
      pillEdges.push({ from: parentId, to: `${COLLAPSE_KIND}:${key}`, type: group[0].type })
      if (!isExpanded) {
        for (const n of hidden) removed.add(n.id)
        for (const n of descendants) removed.add(n.id)
      }
    }
  }
  if (pills.length === 0) return { nodes, edges }

  const keptNodes = nodes.filter((n) => !removed.has(n.id))
  const keptEdges = edges.filter((e) => !removed.has(e.from) && !removed.has(e.to))
  return { nodes: [...keptNodes, ...pills], edges: [...keptEdges, ...pillEdges] }
}

// pillCell builds the synthetic KNode for a "+N older" affordance, tagged with its CollapseMeta so
// the placement loop can lift it onto the resulting PositionedNode. `host` is set for host-group
// pills so hostGroups() attributes the pill to the right container.
function pillCell(meta: CollapseMeta, host?: string): KNode & { _collapse: CollapseMeta } {
  return {
    id: `${COLLAPSE_KIND}:${meta.key}`,
    kind: COLLAPSE_KIND,
    name: `+${meta.hidden.length} more`,
    health: 'Healthy',
    ...(host ? { host } : {}),
    _collapse: meta,
  }
}

// placeSkeletonNode positions a single skeleton card at (cx, cy) and lifts a pre-fold pill's
// _collapse tag onto the PositionedNode (real cards have no _collapse, so they pass straight
// through). Used by both placers so a foldSiblingSubtrees pill carries its CollapseMeta into render.
function placeSkeletonNode(n: KNode, cx: number, cy: number): PositionedNode {
  const { _collapse, ...rest } = n as KNode & { _collapse?: CollapseMeta }
  return { ...rest, x: cx, y: cy, width: NODE_WIDTH, height: NODE_HEIGHT, ...(_collapse ? { collapse: _collapse } : {}) }
}

// place lays a list of cells row-major into a grid and lifts any pill's _collapse tag onto the
// PositionedNode. Shared by the two grouped layouts so their grid math stays identical.
function placeGridCells(cells: Array<KNode & { _collapse?: CollapseMeta }>, grid: { cols: number }): PositionedNode[] {
  return cells.map((cell, i) => {
    const row = Math.floor(i / grid.cols)
    const col = i % grid.cols
    const x = col * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2
    const y = KIND_HEADER_HEIGHT + row * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2
    const { _collapse, ...rest } = cell
    return { ...rest, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, ...(_collapse ? { collapse: _collapse } : {}) }
  })
}

// layoutGraphByKind is the "All" view variant: instead of connectivity-based components, nodes
// are grouped by Kind (every Pod in one box, every Service in another, …) and laid out in a
// per-kind grid, then shelf-packed into the viewport. Cross-kind edges (ownership backbone,
// CR references) draw as straight lines across the kind boxes so the topology backbone stays
// visible even in the broadest view. This is the v1 antidote to the previous "All" hairball.
export function layoutGraphByKind(
  nodes: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string> = new Set(),
  prioritize?: (n: KNode) => boolean,
): Layout {
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  // Group nodes by kind; splitForFold sorts each group by natural name order for a stable layout
  // (so reloads don't shuffle, and snapshot equality holds across patches that don't change the
  // kind set).
  const byKind = new Map<string, KNode[]>()
  for (const n of nodes) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, [])
    byKind.get(n.kind)!.push(n)
  }

  const components: Component[] = []
  for (const [kind, list] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Fold a crowded kind box's middle cards behind a "+N more" pill (one extra grid cell), keeping
    // the first and last cards in place so expanding only fills the gap — same order both ways.
    const key = `kind:${kind}`
    const isExpanded = expanded.has(key)
    const { visible, hidden, pillIndex } = splitForFold(list, isExpanded, byName, prioritize)
    const cells: Array<KNode & { _collapse?: CollapseMeta }> = [...visible]
    if (hidden.length) cells.splice(pillIndex, 0, pillCell({ key, groupKind: kind, hidden, expanded: isExpanded }))

    const grid = gridDims(cells.length)
    // Left-align rows (rather than centering) so the kind box's left edge is the natural column
    // gutter — the kind header reads anchored to that edge in Topology.
    const positioned = placeGridCells(cells, grid)
    components.push({
      nodes: positioned,
      edges: [], // cross-kind edges resolved after packing
      width: grid.w,
      height: KIND_HEADER_HEIGHT + grid.h,
    })
  }

  // Use a wider gap between kind boxes than between connectivity components: the kind group
  // background rects need breathing room so they don't visually merge into each other. Grid-pack
  // (not single-column) so the kind boxes flow across the width instead of one tall stack.
  const KIND_BOX_GAP = 64
  const packed = packComponentsGrid(components, KIND_BOX_GAP)

  // Resolve cross-kind edges against the packed global positions, so ownership backbone
  // (Deployment→ReplicaSet→Pod) and CR refs draw as straight lines across kind boxes.
  const present = new Map(packed.nodes.map((n) => [n.id, n]))
  const positionedEdges: PositionedEdge[] = []
  for (const e of edges) {
    const from = present.get(e.from)
    const to = present.get(e.to)
    if (!from || !to) continue
    positionedEdges.push({ ...e, points: [{ x: from.x, y: from.y }, { x: to.x, y: to.y }] })
  }
  return { ...packed, edges: positionedEdges }
}


export interface KindGroup {
  kind: string
  // True resource count of the kind: visible cards plus the nodes folded behind its "+N more" pill, so
  // the band reads the honest total regardless of folding (the renderer no longer counts props.nodes,
  // which over-counts when the same kind appears both connected and orphaned in one combined layout).
  count: number
  x: number
  y: number
  width: number
  height: number
}

// kindGroups returns the kind boxes' bounding rectangles in the layout's coordinate space,
// so the renderer can draw kind labels + group outlines without recomputing the grouping.
export function kindGroups(layout: Layout): KindGroup[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; count: number }>()
  for (const n of layout.nodes) {
    // A "+N older" pill belongs to the kind box it folds, not a phantom "__collapse__" group, so
    // the box grows to include the pill instead of the pill drifting into its own group.
    const kind = n.collapse ? n.collapse.groupKind : n.kind
    // A pill stands for its hidden siblings (count them); a real card counts as one.
    const add = n.collapse ? n.collapse.hidden.length : 1
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(kind)
    if (!cur) {
      groups.set(kind, { minX: left, minY: top, maxX: right, maxY: bottom, count: add })
    } else {
      cur.minX = Math.min(cur.minX, left)
      cur.minY = Math.min(cur.minY, top)
      cur.maxX = Math.max(cur.maxX, right)
      cur.maxY = Math.max(cur.maxY, bottom)
      cur.count += add
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, r]) => ({
      kind,
      count: r.count,
      x: r.minX,
      y: r.minY - KIND_HEADER_HEIGHT,
      width: r.maxX - r.minX,
      height: r.maxY - r.minY + KIND_HEADER_HEIGHT,
    }))
}

// connGroups returns one bounding rect per per-kind leaf block (Services, Secrets, …) under a hub, so
// the renderer can frame each kind's cards separately — the cue that says "these are this parent's
// Secrets, and the pill inside folds/unfolds the crowded part". Membership is the per-kind frame key
// on each card + pill (`collapseGroup`, set by collapseHubLeaves on folded blocks only). Because each
// kind is a contiguous column block, its bbox is tight and never sprawls across another kind. A frame
// is "expanded" if its pill is expanded. Connectivity views have no kind/host container (unlike
// All/Nodes), so this is the only grouping cue there.
export function connGroups(layout: Layout): { key: string; expanded: boolean; x: number; y: number; width: number; height: number }[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; expanded: boolean }>()
  for (const n of layout.nodes) {
    const key = n.collapseGroup
    if (!key) continue
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(key)
    if (!cur) groups.set(key, { minX: left, minY: top, maxX: right, maxY: bottom, expanded: !!n.collapse?.expanded })
    else {
      cur.minX = Math.min(cur.minX, left)
      cur.minY = Math.min(cur.minY, top)
      cur.maxX = Math.max(cur.maxX, right)
      cur.maxY = Math.max(cur.maxY, bottom)
      if (n.collapse?.expanded) cur.expanded = true
    }
  }
  // Frame padding so the border sits a few px outside the cards rather than flush against them.
  const PAD = 8
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, r]) => ({
      key,
      expanded: r.expanded,
      x: r.minX - PAD,
      y: r.minY - PAD,
      width: r.maxX - r.minX + PAD * 2,
      height: r.maxY - r.minY + PAD * 2,
    }))
}

// orphanBlock lays one kind's UNCONNECTED (parentless) nodes into a single collapsible grid block —
// the same compact fold a hub's per-kind leaves get, but with no hub to hang off. The ownership view
// keeps every resource in the namespace (filter.go allNodes), so a namespace's loose ConfigMaps,
// Secrets, EphemeralReports, … would otherwise be a wall of single cards; folded per kind they read as
// one framed "+N more" block. Every cell carries the `orphan:<kind>` collapseGroup so connGroups draws
// the dashed frame, and the pill drives expand/collapse through the same key as any other fold.
function orphanBlock(kind: string, list: KNode[], expanded: ReadonlySet<string>): Component {
  const key = `orphan:${kind}`
  const isExpanded = expanded.has(key)
  const split = splitForFold(list, isExpanded)
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
// an ArgoCD tree; 'TB' (the default, kept for callers/tests) reads top-down.
export function layoutGraph(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set()): Layout {
  // Fold crowded same-kind sibling subtrees (e.g. many Workflows under one WorkflowTemplate) before
  // anything else, so the rest of the pipeline lays out the reduced graph + its pills normally.
  ;({ nodes, edges } = foldSiblingSubtrees(nodes, edges, expanded))
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
    orphanComponents.push(orphanBlock(kind, list, expanded))
    for (const n of list) blocked.add(n.id)
  }

  const groups = connectedComponents(blocked.size ? nodes.filter((n) => !blocked.has(n.id)) : nodes, laidEdges)
  // Stable vertical order: each tree keeps its row across SSE patches. node.id is a random UID, so
  // ordering by it would shuffle trees arbitrarily; the smallest kind/name in a component is stable
  // (adding/removing a pod doesn't change it) and reads sensibly (workload roots sort near the top).
  groups.sort((a, b) => componentKey(a.nodes).localeCompare(componentKey(b.nodes)))
  const components = groups.map((g) => layoutComponent(g.nodes, g.edges, rankdir, expanded))

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
  const rel = layoutGraph(connected, edges, 'LR', expanded)
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

// gridDims chooses a near-square grid for n leaves. In 'TB' it leans wide (more columns than rows)
// so the block grows downward rather than across; in 'LR' it leans tall (more rows than columns)
// so a hub's children stack into a vertical column and the block grows rightward — the LR flow
// direction. The grouped All/Nodes views call it without a rankdir and get the wide default.
function gridDims(n: number, rankdir: 'TB' | 'LR' = 'TB'): { cols: number; rows: number; w: number; h: number } {
  const major = Math.min(n, Math.ceil(Math.sqrt(n * TARGET_ASPECT)))
  const cols = rankdir === 'LR' ? Math.ceil(n / major) : major
  const rows = rankdir === 'LR' ? major : Math.ceil(n / major)
  return {
    cols,
    rows,
    w: cols * NODE_WIDTH + (cols - 1) * LEAF_GAP_X,
    h: rows * NODE_HEIGHT + (rows - 1) * LEAF_GAP_Y,
  }
}

// blockDims lays a per-kind block's m cells column-major into a vertical-first grid: rows fill down
// to LEAF_COL_MAX before a second column starts, so a collapsed block (m ≤ COLLAPSE_VISIBLE+1) is one
// tall column with the pill at the bottom, and an expanded block wraps rather than running off-screen.
function blockDims(m: number): { cols: number; rows: number; w: number; h: number } {
  const rows = Math.min(m, LEAF_COL_MAX)
  const cols = Math.ceil(m / rows)
  return {
    cols,
    rows,
    w: cols * NODE_WIDTH + (cols - 1) * LEAF_GAP_X,
    h: rows * NODE_HEIGHT + (rows - 1) * LEAF_GAP_Y,
  }
}

// A LeafBlock is one kind's cards (+ its optional "+N older" pill) under a hub, laid as its own
// column block. frameKey is set (to the per-kind collapse key) only when the kind folds (has a pill),
// so the grouping border appears exactly when the show-more affordance does — unfolded kinds stay bare.
interface LeafBlock {
  kind: string
  frameKey?: string
  cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }>
  cols: number
  rows: number
  w: number
  h: number
}

interface Hub {
  id: string
  // Per-kind blocks. All sit at the SAME depth (one rank to the hub's right in LR / below it in TB)
  // because they are all direct children of the hub — depth must not vary by kind. They stack along
  // the cross-flow axis (down the column in LR), each a vertical run so same-kind cards group and the
  // pill lands at the bottom of its run.
  blocks: LeafBlock[]
  // Whether the leaf area sits AFTER the hub in the flow direction (below it in TB / to its right
  // in LR). True for a parent whose children are leaves (edges point hub->leaf); false when the
  // hub is the shared target the leaves point at (e.g. pods->Node), so the area sits before it.
  after: boolean
  // One entry per "+N older" pill folded out of this hub's leaves: the pill id and the edge type to
  // bundle from the hub to it (all hidden same-kind siblings shared the hub via this relationship).
  pills: { id: string; type: EdgeType }[]
}

// hubArea is the reserved size for a hub's whole leaf cluster. Blocks stack along the cross axis at a
// single depth: in LR that is downward (height = sum of block heights, width = the widest block); in
// TB it is rightward (width = sum, height = the tallest block). Keeping every block at one depth is
// what puts all same-depth children on the same level.
function hubArea(blocks: LeafBlock[], rankdir: 'TB' | 'LR'): { w: number; h: number } {
  const sum = (sel: (b: LeafBlock) => number) => blocks.reduce((s, b) => s + sel(b), 0) + Math.max(0, blocks.length - 1) * BLOCK_GAP
  const max = (sel: (b: LeafBlock) => number) => blocks.reduce((m, b) => Math.max(m, sel(b)), 0)
  return rankdir === 'LR' ? { w: max((b) => b.w), h: sum((b) => b.h) } : { w: sum((b) => b.w), h: max((b) => b.h) }
}

// collapseHubLeaves groups a hub's degree-1 leaves per kind into separate blocks (Services together,
// Secrets together, …) and folds each kind independently: the first + last cards of a kind stay and
// its hidden middle folds behind that kind's own "+N more" pill (D5). A kind's hidden leaves
// vanish from the component — their only edge was to the hub — replaced by one bundled hub→pill edge
// (D6) typed by the relationship they shared with the hub. Each multi-card block carries a per-kind
// frameKey so Topology frames the kinds separately.
function collapseHubLeaves(
  hubId: string,
  leaves: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string>,
): { blocks: LeafBlock[]; pills: { id: string; type: EdgeType }[] } {
  const byKind = new Map<string, KNode[]>()
  for (const l of leaves) {
    if (!byKind.has(l.kind)) byKind.set(l.kind, [])
    byKind.get(l.kind)!.push(l)
  }
  const blocks: LeafBlock[] = []
  const pills: { id: string; type: EdgeType }[] = []
  // Stable kind order so a hub's blocks keep their left-to-right slots across SSE patches.
  for (const [kind, list] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = `sib:${hubId}:${kind}`
    const isExpanded = expanded.has(key)
    const split = splitForFold(list, isExpanded)
    const cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }> = [...split.visible]
    if (split.hidden.length) {
      const meta: CollapseMeta = { key, groupKind: kind, hidden: split.hidden, expanded: isExpanded }
      const id = `${COLLAPSE_KIND}:${key}`
      // Splice the pill into its slot in the column — between the first and last cards while collapsed,
      // at the bottom once expanded — so the kind reads in one stable natural order whichever way.
      cells.splice(split.pillIndex, 0, { id, kind: COLLAPSE_KIND, name: `+${split.hidden.length} more`, health: 'Healthy', collapse: meta })
      // Bundle the hub's edges to the hidden siblings into one hub→pill edge — but only while
      // collapsed. Expanded, the siblings are drawn as real leaves with their own hub edges, so the
      // pill is a bare re-collapse toggle with no edge.
      if (!isExpanded) {
        const hid = new Set(split.hidden.map((h) => h.id))
        const e = edges.find((x) => (x.from === hubId && hid.has(x.to)) || (x.to === hubId && hid.has(x.from)))
        pills.push({ id, type: e ? e.type : 'ownerReference' })
      }
    }
    // Frame a block only when its kind actually folds (i.e. it has a "+ show N more" pill), so the
    // grouping border and the show-more affordance appear together — a kind small enough to show in
    // full needs no border. Tag each cell with the per-kind frame key so connGroups can box it.
    const frameKey = split.hidden.length ? key : undefined
    const tagged = frameKey ? cells.map((c) => ({ ...c, collapseGroup: frameKey })) : cells
    blocks.push({ kind, frameKey, cells: tagged, ...blockDims(tagged.length) })
  }
  return { blocks, pills }
}

// findHubs detects nodes whose many degree-1 CHILDREN should be grid-wrapped. A leaf is wrapped
// beside (LR) / under (TB) its hub. Only fan-OUT children are wrapped — a fan-IN hub's many parents
// stay in the Dagre skeleton so they align in their own depth column rather than folding into a
// confusing partial frame (see the per-hub note below).
function findHubs(nodes: KNode[], edges: KEdge[], expanded: ReadonlySet<string>): { hubs: Hub[]; wrapped: Set<string> } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outdeg = new Map<string, number>()
  for (const e of edges) outdeg.set(e.from, (outdeg.get(e.from) ?? 0) + 1)

  // A wrappable fan-out leaf is a SINK — it owns no children (out-degree 0). It may still have MORE
  // than one PARENT: an Argo Application is owned by an ApplicationSet yet also refers to an AppProject,
  // so keying off total degree (the old degree===1 test) left every such multi-parent leaf unwrapped —
  // the argocd "long ungrouped column" report. Each leaf is claimed by ONE primary hub so it is wrapped
  // exactly once: an ownerReference parent wins over a looser refers parent, ties broken by id for
  // determinism. Secondary parents keep their honest edges to whatever stays visible. Only the child
  // (fan-out) side is wrapped — a shared target's many PARENTS stay in the skeleton (see the note below).
  const ownerPrio = (e: KEdge) => (e.type === 'ownerReference' ? 0 : 1)
  const parentsOf = new Map<string, KEdge[]>()
  for (const e of edges) {
    const leaf = byId.get(e.to)
    if (!leaf || leaf.kind === COLLAPSE_KIND) continue // missing or a pre-folded pill is not a wrappable leaf
    if ((outdeg.get(e.to) ?? 0) !== 0) continue // a node with children of its own is not a leaf
    const list = parentsOf.get(e.to)
    if (list) list.push(e)
    else parentsOf.set(e.to, [e])
  }
  const childrenOf = new Map<string, KNode[]>()
  for (const [leafId, parentEdges] of parentsOf) {
    const primary = parentEdges.reduce((best, e) =>
      ownerPrio(e) < ownerPrio(best) || (ownerPrio(e) === ownerPrio(best) && e.from < best.from) ? e : best,
    )
    const list = childrenOf.get(primary.from) ?? []
    list.push(byId.get(leafId)!)
    childrenOf.set(primary.from, list)
  }

  const hubs: Hub[] = []
  const wrapped = new Set<string>()
  for (const id of childrenOf.keys()) {
    const children = childrenOf.get(id) ?? []
    // Wrap only fan-OUT children (the hub is their shared parent). Fan-IN parents are deliberately
    // NOT wrapped: folding a shared target's many degree-1 PARENTS (e.g. the dozen Pods that all
    // mount one Secret in the Volumes view) split the Pod kind into a framed mid-column subset with
    // its unrelated siblings stranded above and below — a confusing partial frame in the parent
    // column. Left in the skeleton, those parents instead align cleanly in the leftmost depth column
    // (placeColumns) with one honest edge each, which is what the operator expects.
    if (children.length < FANOUT_MIN) continue
    const leaves = [...children].sort(byName)
    // Group this hub's leaves per kind and fold each crowded kind into its own "+N older" pill
    // (D5/D6). All kind blocks sit at one depth (stacked down the column in LR), so a multi-kind CRD
    // owner's Services / Secrets / … all read as direct children on the same level.
    const collapsed = collapseHubLeaves(id, leaves, edges, expanded)
    hubs.push({
      id,
      blocks: collapsed.blocks,
      after: true, // children always sit AFTER the hub in flow (to its right in LR)
      pills: collapsed.pills,
    })
    // Every ORIGINAL leaf is owned by the hub (excluded from the Dagre skeleton); hidden ones simply
    // never get placed, and their hub edge is replaced by the bundled hub→pill edge below.
    for (const l of leaves) wrapped.add(l.id)
  }
  return { hubs, wrapped }
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
// centred on `parent`'s placed position. `name` is the natural-sort key within a group ('' for leaf
// blocks). `id` (skeleton card only) lets a child column read this card's placed centre; `parent` is
// the shallowest source feeding this unit (a hub id for its leaf blocks) so the group centres on it.
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

  // Each skeleton node's primary parent = the shallowest source of an edge into it (ties broken by id),
  // so a node's same-kind siblings under one parent share a `group` and get ordered by name below. A
  // node with no shallower neighbour (a root / fan-in source) is its own group, left in Dagre's order.
  const parentOf = new Map<string, string>()
  for (const e of edges) {
    if (wrapped.has(e.from) || wrapped.has(e.to)) continue
    const rf = rank.get(e.from) ?? 0
    const rt = rank.get(e.to) ?? 0
    if (rf >= rt) continue // e.from must be shallower to be a parent of e.to
    const cur = parentOf.get(e.to)
    if (cur === undefined || rf < (rank.get(cur) ?? 0) || (rf === (rank.get(cur) ?? 0) && e.from < cur)) {
      parentOf.set(e.to, e.from)
    }
  }

  for (const n of skeleton) {
    const r = rank.get(n.id) ?? 0
    const par = parentOf.get(n.id)
    units.push({
      rank: r, kind: n.kind, group: par !== undefined ? `${par}|${n.kind}` : `root:${n.id}`, name: n.name,
      w: NODE_WIDTH, h: NODE_HEIGHT, seedY: seedY.get(n.id) ?? 0, id: n.id, parent: par,
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
        w: block.w, h: block.h, seedY: top + block.h / 2, parent: hub.id,
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

  // Within each column we place one GROUP (same parent + same kind) at a time, vertically CENTRED on its
  // parent's already-placed centre — columns are processed left→right (ranks ascending), so by the time a
  // child column is laid out every parent in a shallower column has a real position recorded in
  // `placedCenter`. This is what keeps children "right next to" their parent: re-packing a parent column
  // moves a card off its raw Dagre seed, and a child centred on the seed (the old behaviour) drifted away
  // — es-default's pods and a WorkflowTemplate's Workflows both sank below their parent. Centring on the
  // placed parent makes the child follow. A group with no placed parent (a root / fan-in source) falls
  // back to its own seed. Units INSIDE a group are ordered by natural name (so a StatefulSet's pods read
  // web-0,1,2) and packed tight (COL_V_GAP).
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
    const blocks = [...groups.entries()].map(([key, gus]) => {
      gus.sort((a, b) => byName(a, b) || a.seedY - b.seedY)
      const h = gus.reduce((s, u) => s + u.h, 0) + Math.max(0, gus.length - 1) * COL_V_GAP
      const parent = gus[0].parent
      const desired = parent !== undefined && placedCenter.has(parent)
        ? placedCenter.get(parent)!
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
function layoutComponent(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set()): Component {
  const { hubs, wrapped } = findHubs(nodes, edges, expanded)
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

// packComponentsGrid arranges the component boxes into an aligned grid instead of one tall column,
// so the All / Nodes views (independent kind/host boxes with no cross-tree backbone to keep
// vertically aligned) use the viewport's width. The single-column packComponents stays for the
// connectivity views, where one-tree-per-row is the intended reading order.
//
// We pick the COLUMN COUNT whose resulting grid aspect (w/h) lands closest to a landscape target,
// rather than a width-threshold shelf pack: with wide boxes (a Node's pod grid) an area-derived
// width barely fits two boxes and collapses to a single column, wasting the screen. Searching the
// column count instead reliably finds the balanced 2-3 column grid. Columns size to their widest
// box and rows to their tallest, so every box aligns into a clean lattice. Order is the caller's
// (alphabetical) for stability; the count is derived from content (not the live viewport) so the
// layout is stable across resizes — the fit step scales the whole thing to the screen afterwards.
function packComponentsGrid(components: Component[], gap = COMPONENT_GAP): Layout {
  if (components.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const margin = 28
  const n = components.length
  const GRID_TARGET_ASPECT = 1.6 // overall grid a touch wider than tall, matching typical screens

  // Evaluate each candidate column count and keep the one whose grid aspect is closest to target.
  let best: { cols: number; colW: number[]; rowH: number[]; w: number; h: number } | null = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const colW = new Array(cols).fill(0)
    const rowH = new Array(rows).fill(0)
    components.forEach((c, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      colW[col] = Math.max(colW[col], c.width)
      rowH[row] = Math.max(rowH[row], c.height)
    })
    const w = colW.reduce((a, b) => a + b, 0) + (cols - 1) * gap
    const h = rowH.reduce((a, b) => a + b, 0) + (rows - 1) * gap
    const score = Math.abs(w / h - GRID_TARGET_ASPECT)
    if (!best || score < Math.abs(best.w / best.h - GRID_TARGET_ASPECT)) best = { cols, colW, rowH, w, h }
  }

  const { cols, colW, rowH } = best!
  const colX: number[] = []
  let x = margin
  for (const cw of colW) {
    colX.push(x)
    x += cw + gap
  }
  const rowY: number[] = []
  let y = margin
  for (const rh of rowH) {
    rowY.push(y)
    y += rh + gap
  }

  const allNodes: PositionedNode[] = []
  const allEdges: PositionedEdge[] = []
  components.forEach((c, i) => {
    const dx = colX[i % cols]
    const dy = rowY[Math.floor(i / cols)]
    for (const node of c.nodes) allNodes.push({ ...node, x: node.x + dx, y: node.y + dy })
    for (const e of c.edges) allEdges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
  })

  return {
    nodes: allNodes,
    edges: allEdges,
    width: best!.w + margin * 2,
    height: best!.h + margin * 2,
  }
}
