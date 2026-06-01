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

export interface Point {
  x: number
  y: number
}

// COLLAPSE_KIND marks a synthetic "+N older" pill — a PositionedNode that stands in for the older
// same-kind resources hidden behind a collapse, not a real cluster object. Topology renders these
// specially and excludes them from kind stats / search / nav.
export const COLLAPSE_KIND = '__collapse__'
// A same-kind cluster larger than COLLAPSE_VISIBLE shows its newest COLLAPSE_VISIBLE by creation
// time and hides the older remainder — but only when that hides at least COLLAPSE_MIN_HIDDEN, so a
// lone "+1 older" pill never replaces a card it could have just shown. Kept small (the user's
// "most users aren't interested in most of them") so a crowded cluster folds aggressively to its
// few newest.
export const COLLAPSE_VISIBLE = 3
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

// splitByAge partitions a same-kind cluster into the cards to show and the older ones the fold
// covers. A cluster is foldable only when it would hide at least COLLAPSE_MIN_HIDDEN (FR-007), so a
// lone "+1 older" pill never replaces a card it could have shown. `hidden` is the by-age fold set
// (newest COLLAPSE_VISIBLE stay; a missing createdAt sorts oldest). When `expanded`, every card is
// visible but `hidden` still reports the set the pill folds, so the pill persists as a "show fewer"
// re-collapse toggle. The visible list keeps the caller's incoming order (name / health-severity)
// so grid placement and snapshot stability are unchanged — only the *fold set* is chosen by age.
function splitByAge(nodes: KNode[], expanded: boolean): { visible: KNode[]; hidden: KNode[] } {
  if (nodes.length < COLLAPSE_VISIBLE + COLLAPSE_MIN_HIDDEN) {
    return { visible: nodes, hidden: [] }
  }
  const age = (n: KNode) => (n.createdAt ? Date.parse(n.createdAt) : 0)
  const newestFirst = [...nodes].sort((a, b) => age(b) - age(a) || a.name.localeCompare(b.name))
  const hiddenIds = new Set(newestFirst.slice(COLLAPSE_VISIBLE).map((n) => n.id))
  const hidden = nodes.filter((n) => hiddenIds.has(n.id))
  if (expanded) return { visible: nodes, hidden }
  return { visible: nodes.filter((n) => !hiddenIds.has(n.id)), hidden }
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
export function layoutGraphByKind(nodes: KNode[], edges: KEdge[], expanded: ReadonlySet<string> = new Set()): Layout {
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  // Group nodes by kind, names sorted alphabetically inside each group for stable layout
  // (so reloads don't shuffle, and snapshot equality holds across patches that don't change
  // the kind set).
  const byKind = new Map<string, KNode[]>()
  for (const n of nodes) {
    if (!byKind.has(n.kind)) byKind.set(n.kind, [])
    byKind.get(n.kind)!.push(n)
  }
  for (const list of byKind.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  const components: Component[] = []
  for (const [kind, list] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Fold the older cards in a crowded kind box behind a "+N older" pill (one extra grid cell);
    // when expanded, the pill stays as a "show fewer" toggle after the now-visible cards.
    const key = `kind:${kind}`
    const isExpanded = expanded.has(key)
    const { visible, hidden } = splitByAge(list, isExpanded)
    const cells: Array<KNode & { _collapse?: CollapseMeta }> = [...visible]
    if (hidden.length) cells.push(pillCell({ key, groupKind: kind, hidden, expanded: isExpanded }))

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
  // background rects need breathing room so they don't visually merge into each other.
  const KIND_BOX_GAP = 64
  const packed = packComponents(components, KIND_BOX_GAP)

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

// layoutGraphByHost is the Nodes-view layout: pods are grouped under the Node they run on (their
// `host`), and each host becomes a labeled container with the Node card pinned at the top-left
// and its pods grid-wrapped beneath. scheduledOn edges aren't drawn — containment carries the
// "this pod runs here" relationship more clearly than a fan of identical edges to the Node card
// at the top would. Pods whose host doesn't appear among the Node cards (cluster-scope read may
// have surfaced pods without their Node) bucket into a synthetic "Unscheduled / Unknown" group.
export function layoutGraphByHost(nodes: KNode[], _edges: KEdge[], expanded: ReadonlySet<string> = new Set()): Layout {
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  // Index Node cards by name so a pod's host string resolves directly to its Node card.
  const nodeByName = new Map<string, KNode>()
  for (const n of nodes) if (n.kind === 'Node') nodeByName.set(n.name, n)

  // Bucket pods by host. Pods with no host (Pending) or with a host that didn't surface as a
  // Node card bucket into the orphan group below — at least the pod still renders somewhere.
  const podsByHost = new Map<string, KNode[]>()
  const ORPHAN = '__orphan__'
  for (const n of nodes) {
    if (n.kind !== 'Pod') continue
    const key = n.host && nodeByName.has(n.host) ? n.host : ORPHAN
    if (!podsByHost.has(key)) podsByHost.set(key, [])
    podsByHost.get(key)!.push(n)
  }
  // Cards inside each host group sort by health-severity (troubled first) then name, so an
  // operator scanning a node sees its problem pods at the top of the host's grid.
  for (const list of podsByHost.values()) {
    list.sort((a, b) => {
      const sev = (n: KNode) => (n.health === 'Healthy' ? 0 : 1)
      return sev(b) - sev(a) || a.name.localeCompare(b.name)
    })
  }

  // Build one component per Node card present in the graph (alphabetical by host name for
  // stable layout); append the orphan group last if any pods landed there.
  const hostNames = [...nodeByName.keys()].sort((a, b) => a.localeCompare(b))
  if (podsByHost.has(ORPHAN)) hostNames.push(ORPHAN)

  const components: Component[] = []
  for (const host of hostNames) {
    const pods = podsByHost.get(host) ?? []
    // The Node card itself takes the top-left slot of the container. Even when a Node has zero
    // pods (drained, freshly added), the host group still shows so the operator sees "this Node
    // is here". The orphan group has no Node card; it uses the header for "Unscheduled".
    const nodeCard = nodeByName.get(host) ?? null
    // Fold a crowded host's older pods behind a "+N older" pill — never the Node card, which is the
    // host anchor, not a same-kind cluster member. The pill carries `host` so hostGroups attributes it.
    const key = `host:${host}`
    const isExpanded = expanded.has(key)
    const { visible, hidden } = splitByAge(pods, isExpanded)
    const cells: Array<KNode & { _collapse?: CollapseMeta }> = nodeCard ? [nodeCard, ...visible] : [...visible]
    if (hidden.length) cells.push(pillCell({ key, groupKind: 'Pod', hidden, expanded: isExpanded }, host))
    if (cells.length === 0) continue
    const grid = gridDims(cells.length)
    const positioned = placeGridCells(cells, grid)
    components.push({
      nodes: positioned,
      edges: [], // containment carries the relationship; no edges drawn inside a host group
      width: grid.w,
      height: KIND_HEADER_HEIGHT + grid.h,
    })
  }
  // Slightly wider gap between host containers than between connectivity components — the host
  // group bg rects need breathing room. Same constant as layoutGraphByKind for visual rhythm.
  const HOST_BOX_GAP = 64
  const packed = packComponents(components, HOST_BOX_GAP)
  // No edges drawn in this view; scheduledOn is implied by containment.
  return { ...packed, edges: [] }
}

// hostGroups returns the host-container bounding rects in layout coordinates, so the Topology
// renderer can draw a host-group background rect + a "host: <name>" header without recomputing
// the grouping. The header label is the host name (or "Unscheduled" for the orphan bucket).
export function hostGroups(layout: Layout): { host: string; label: string; x: number; y: number; width: number; height: number }[] {
  // Discover host membership: a Pod is "in" its host group; a Node card is "in" its own group.
  // Pods whose host has no matching Node card fall into the orphan bucket — we label that group
  // "Unscheduled" so it reads as a deliberate bucket, not a layout glitch.
  const nodeNames = new Set(layout.nodes.filter((n) => n.kind === 'Node').map((n) => n.name))
  const hostOf = (n: PositionedNode): string => {
    if (n.kind === 'Node') return n.name
    if (n.host && nodeNames.has(n.host)) return n.host
    return '__orphan__'
  }
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
  for (const n of layout.nodes) {
    const h = hostOf(n)
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(h)
    if (!cur) groups.set(h, { minX: left, minY: top, maxX: right, maxY: bottom })
    else {
      cur.minX = Math.min(cur.minX, left)
      cur.minY = Math.min(cur.minY, top)
      cur.maxX = Math.max(cur.maxX, right)
      cur.maxY = Math.max(cur.maxY, bottom)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, r]) => ({
      host,
      label: host === '__orphan__' ? 'Unscheduled' : host,
      x: r.minX,
      y: r.minY - KIND_HEADER_HEIGHT,
      width: r.maxX - r.minX,
      height: r.maxY - r.minY + KIND_HEADER_HEIGHT,
    }))
}

// kindGroups returns the kind boxes' bounding rectangles in the layout's coordinate space,
// so the renderer can draw kind labels + group outlines without recomputing the grouping.
export function kindGroups(layout: Layout): { kind: string; x: number; y: number; width: number; height: number }[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>()
  for (const n of layout.nodes) {
    // A "+N older" pill belongs to the kind box it folds, not a phantom "__collapse__" group, so
    // the box grows to include the pill instead of the pill drifting into its own group.
    const kind = n.collapse ? n.collapse.groupKind : n.kind
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(kind)
    if (!cur) {
      groups.set(kind, { minX: left, minY: top, maxX: right, maxY: bottom })
    } else {
      cur.minX = Math.min(cur.minX, left)
      cur.minY = Math.min(cur.minY, top)
      cur.maxX = Math.max(cur.maxX, right)
      cur.maxY = Math.max(cur.maxY, bottom)
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, r]) => ({
      kind,
      x: r.minX,
      y: r.minY - KIND_HEADER_HEIGHT,
      width: r.maxX - r.minX,
      height: r.maxY - r.minY + KIND_HEADER_HEIGHT,
    }))
}

// connGroups returns one bounding rect per per-kind leaf block (Services, Secrets, …) under a hub, so
// the renderer can frame each kind's cards separately — the cue that says "these are this parent's
// Secrets, and the pill inside folds/unfolds the crowded part". Membership is the per-kind frame key
// on each card + pill (`collapseGroup`, set by collapseHubLeaves on multi-card blocks). Because each
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

// layoutGraph lays out each connected component on its own, then stacks the components in a single
// vertical column (see packComponents). Edges with a missing endpoint are dropped defensively (the
// server should not emit them). `rankdir` switches the per-component direction — 'LR' (what every
// relationship view passes) reads left-to-right so a parent's children fan out to its right, like
// an ArgoCD tree; 'TB' (the default, kept for callers/tests) reads top-down.
export function layoutGraph(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set()): Layout {
  const present = new Set(nodes.map((n) => n.id))
  const laidEdges = edges.filter((e) => present.has(e.from) && present.has(e.to))

  const groups = connectedComponents(nodes, laidEdges)
  // Stable vertical order: each tree keeps its row across SSE patches. node.id is a random UID, so
  // ordering by it would shuffle trees arbitrarily; the smallest kind/name in a component is stable
  // (adding/removing a pod doesn't change it) and reads sensibly (workload roots sort near the top).
  groups.sort((a, b) => componentKey(a.nodes).localeCompare(componentKey(b.nodes)))
  const components = groups.map((g) => layoutComponent(g.nodes, g.edges, rankdir, expanded))

  return packComponents(components)
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
// column block. frameKey is set (to the per-kind collapse key) only when the block is worth framing
// (≥2 cells), so Topology draws a tight per-kind grouping border; single-card kinds stay unframed.
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
// Secrets together, …) and folds each kind independently: the newest COLLAPSE_VISIBLE of a kind stay
// and the older remainder hides behind that kind's own "+N older" pill (D5). A kind's hidden leaves
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
    const split = splitByAge(list, isExpanded)
    const cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }> = [...split.visible].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    if (split.hidden.length) {
      const meta: CollapseMeta = { key, groupKind: kind, hidden: split.hidden, expanded: isExpanded }
      const id = `${COLLAPSE_KIND}:${key}`
      cells.push({ id, kind: COLLAPSE_KIND, name: `+${split.hidden.length} more`, health: 'Healthy', collapse: meta })
      // Bundle the hub's edges to the hidden siblings into one hub→pill edge — but only while
      // collapsed. Expanded, the siblings are drawn as real leaves with their own hub edges, so the
      // pill is a bare re-collapse toggle with no edge.
      if (!isExpanded) {
        const hid = new Set(split.hidden.map((h) => h.id))
        const e = edges.find((x) => (x.from === hubId && hid.has(x.to)) || (x.to === hubId && hid.has(x.from)))
        pills.push({ id, type: e ? e.type : 'ownerReference' })
      }
    }
    // Frame a block only when grouping is meaningful (≥2 cells); a lone card needs no border. Tag
    // each cell with the per-kind frame key so connGroups can box exactly this kind's contiguous column.
    const frameKey = cells.length >= 2 ? key : undefined
    const tagged = frameKey ? cells.map((c) => ({ ...c, collapseGroup: frameKey })) : cells
    blocks.push({ kind, frameKey, cells: tagged, ...blockDims(tagged.length) })
  }
  return { blocks, pills }
}

// findHubs detects nodes whose many degree-1 neighbors should be grid-wrapped. A leaf is wrapped
// under (TB) / beside (LR) the neighbor it connects to; the grid sits on the leaf side of the edge
// (a Node's pods read below/right of it; a ReplicaSet's pods do too, since edges point parent->child).
function findHubs(nodes: KNode[], edges: KEdge[], expanded: ReadonlySet<string>): { hubs: Hub[]; wrapped: Set<string> } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1)
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1)
  }
  // For each potential hub, collect its leaf neighbors and whether the hub is the edge target.
  const leavesOf = new Map<string, { leaves: KNode[]; hubIsTarget: number }>()
  for (const e of edges) {
    const leafId = degree.get(e.from) === 1 ? e.from : degree.get(e.to) === 1 ? e.to : null
    if (!leafId) continue
    const hubId = leafId === e.from ? e.to : e.from
    const leaf = byId.get(leafId)
    if (!leaf) continue
    const entry = leavesOf.get(hubId) ?? { leaves: [], hubIsTarget: 0 }
    entry.leaves.push(leaf)
    if (hubId === e.to) entry.hubIsTarget++
    leavesOf.set(hubId, entry)
  }

  const hubs: Hub[] = []
  const wrapped = new Set<string>()
  for (const [id, { leaves, hubIsTarget }] of leavesOf) {
    if (leaves.length < FANOUT_MIN) continue
    leaves.sort((a, b) => a.name.localeCompare(b.name))
    // Group this hub's leaves per kind and fold each crowded kind into its own "+N older" pill
    // (D5/D6). All kind blocks sit at one depth (stacked down the column in LR), so a multi-kind CRD
    // owner's Services / Secrets / … all read as direct children on the same level.
    const collapsed = collapseHubLeaves(id, leaves, edges, expanded)
    hubs.push({
      id,
      blocks: collapsed.blocks,
      after: hubIsTarget <= leaves.length / 2,
      pills: collapsed.pills,
    })
    // Every ORIGINAL leaf is owned by the hub (excluded from the Dagre skeleton); hidden ones simply
    // never get placed, and their hub edge is replaced by the bundled hub→pill edge below.
    for (const l of leaves) wrapped.add(l.id)
  }
  return { hubs, wrapped }
}

// layoutComponent runs Dagre over one component and returns its local geometry (origin at 0,0)
// plus its bounding size. rankdir picks the orientation: 'TB' (the default, ownership tree)
// stacks parents above children; 'LR' lays them left-to-right and is used by Volumes view so
// "Pod mounts ConfigMap" reads as an arrow that flows the same way as the eye. High-fanout hubs
// (a Node hosting many pods, a ReplicaSet with many replicas) reserve a tall/wide Dagre box and
// place their leaves in a grid — but only in 'TB' mode where the existing side='above'/'below'
// math fits; 'LR' lets Dagre do its natural rank layout instead so the orientation stays clean.
function layoutComponent(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB', expanded: ReadonlySet<string> = new Set()): Component {
  const { hubs, wrapped } = findHubs(nodes, edges, expanded)
  const hubById = new Map(hubs.map((h) => [h.id, h]))
  const areaById = new Map(hubs.map((h) => [h.id, hubArea(h.blocks, rankdir)]))
  const skeleton = nodes.filter((n) => !wrapped.has(n.id))
  const skeletonEdges = edges.filter((e) => !wrapped.has(e.from) && !wrapped.has(e.to))

  const g = new dagre.graphlib.Graph()
  // ranksep is the gap between ranks; in 'LR' Dagre uses it horizontally, so a slightly larger
  // value gives the LR layout a noticeably column-like rhythm rather than a cramped grid.
  g.setGraph({ rankdir, nodesep: 24, ranksep: rankdir === 'LR' ? 80 : 52, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of skeleton) {
    const hub = hubById.get(n.id)
    if (hub) {
      // Reserve a box big enough for the hub card PLUS its leaf grid, oriented along the flow:
      // taller in TB (grid stacks below), wider in LR (grid sits to the side).
      const area = areaById.get(n.id)!
      if (rankdir === 'LR') {
        g.setNode(n.id, { width: NODE_WIDTH + HUB_GAP + area.w, height: Math.max(NODE_HEIGHT, area.h) })
      } else {
        g.setNode(n.id, { width: Math.max(NODE_WIDTH, area.w), height: NODE_HEIGHT + HUB_GAP + area.h })
      }
    } else {
      g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }
  }
  for (const e of skeletonEdges) g.setEdge(e.from, e.to)
  dagre.layout(g)

  const positioned: PositionedNode[] = []
  const cardCenter = new Map<string, Point>() // hub id -> its card center, for edge endpoints
  for (const n of skeleton) {
    const p = g.node(n.id)
    const hub = hubById.get(n.id)
    if (!hub) {
      positioned.push({ ...n, x: p.x, y: p.y, width: NODE_WIDTH, height: NODE_HEIGHT })
      continue
    }
    const area = areaById.get(n.id)!
    if (rankdir === 'LR') {
      // Hub card pinned to one edge of its reserved box; its per-kind blocks fill the rest at a
      // single x (all direct children at the same depth), stacked down and centered on the card.
      // after=true → card on the left, blocks to its right (children flow →).
      const boxW = NODE_WIDTH + HUB_GAP + area.w
      const leftEdge = p.x - boxW / 2
      const cardX = hub.after ? leftEdge + NODE_WIDTH / 2 : p.x + boxW / 2 - NODE_WIDTH / 2
      const gridLeft = hub.after ? leftEdge + NODE_WIDTH + HUB_GAP : leftEdge
      positioned.push({ ...n, x: cardX, y: p.y, width: NODE_WIDTH, height: NODE_HEIGHT })
      cardCenter.set(n.id, { x: cardX, y: p.y })
      placeBlocksLR(hub, gridLeft, p.y, area.h, positioned)
      continue
    }
    const boxH = NODE_HEIGHT + HUB_GAP + area.h
    const top = p.y - boxH / 2
    const cardY = hub.after ? top + NODE_HEIGHT / 2 : p.y + boxH / 2 - NODE_HEIGHT / 2
    const gridTop = hub.after ? top + NODE_HEIGHT + HUB_GAP : top
    positioned.push({ ...n, x: p.x, y: cardY, width: NODE_WIDTH, height: NODE_HEIGHT })
    cardCenter.set(n.id, { x: p.x, y: cardY })
    placeBlocksTB(hub, p.x, gridTop, area.w, positioned)
  }

  const positionedEdges: PositionedEdge[] = []
  for (const e of edges) {
    if (wrapped.has(e.from) || wrapped.has(e.to)) {
      // Hub<->leaf: straight line from the hub card to the leaf card.
      const hubId = hubById.has(e.from) ? e.from : e.to
      const leafId = hubId === e.from ? e.to : e.from
      const hub = positioned.find((n) => n.id === hubId)
      const leaf = positioned.find((n) => n.id === leafId)
      if (hub && leaf) positionedEdges.push({ ...e, points: [{ x: hub.x, y: hub.y }, { x: leaf.x, y: leaf.y }] })
      continue
    }
    const ge = g.edge(e.from, e.to)
    if (ge) positionedEdges.push({ ...e, points: ge.points })
  }

  // Bundled hub→pill edges (D6): one straight line from each hub card to its "+N older" pill, in
  // place of the many edges to the leaves the pill folds away. Keyed by the relationship the hidden
  // siblings shared with the hub, so a pod fold reads "owns →" and a mount fold reads "mounts →".
  for (const hub of hubs) {
    const center = cardCenter.get(hub.id)
    if (!center) continue
    for (const pill of hub.pills) {
      const pp = positioned.find((n) => n.id === pill.id)
      if (pp) positionedEdges.push({ from: hub.id, to: pill.id, type: pill.type, points: [{ x: center.x, y: center.y }, { x: pp.x, y: pp.y }] })
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

// placeBlocksLR stacks a hub's per-kind blocks DOWN a single column at gridLeft (one x, so every kind
// sits at the same depth — all direct children on the same level), the whole stack centered on the
// hub's centerY. Each kind reads as a vertical run separated by BLOCK_GAP, with its pill at the bottom.
function placeBlocksLR(hub: Hub, gridLeft: number, centerY: number, areaH: number, out: PositionedNode[]): void {
  let y = centerY - areaH / 2
  for (const b of hub.blocks) {
    placeBlockCells(b, gridLeft, y, out)
    y += b.h + BLOCK_GAP
  }
}

// placeBlocksTB is the TB analog: blocks lay left-to-right below the hub at a single y (all children
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
