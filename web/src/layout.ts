// Pure graph layout: turns nodes+edges into positioned geometry. No DOM, so it is
// unit-testable. See docs/ADR/20260527-frontend-stack.md.
//
// A namespace is many small, disconnected ownership trees. Laying them all in one Dagre graph
// puts every tree in a single horizontal row — a wide, unreadable smear once fit to screen. So
// we lay out each connected component on its own, then bin-pack the components into a block whose
// aspect ratio matches the viewport. That turns a 1xN row into a roughly NxN grid.

import dagre from '@dagrejs/dagre'
import type { KEdge, KNode } from './types'

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

export interface Point {
  x: number
  y: number
}

export interface PositionedNode extends KNode {
  // x, y are the node center (Dagre's convention), in graph coordinates.
  x: number
  y: number
  width: number
  height: number
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

// layoutGraphByKind is the "All" view variant: instead of connectivity-based components, nodes
// are grouped by Kind (every Pod in one box, every Service in another, …) and laid out in a
// per-kind grid, then shelf-packed into the viewport. Cross-kind edges (ownership backbone,
// CR references) draw as straight lines across the kind boxes so the topology backbone stays
// visible even in the broadest view. This is the v1 antidote to the previous "All" hairball.
export function layoutGraphByKind(nodes: KNode[], edges: KEdge[]): Layout {
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
  for (const [, list] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const grid = gridDims(list.length)
    const positioned: PositionedNode[] = []
    list.forEach((leaf, i) => {
      const row = Math.floor(i / grid.cols)
      const col = i % grid.cols
      // Left-align rows (rather than centering) so the kind box's left edge is the natural
      // column gutter — the kind header reads anchored to that edge in Topology.
      const x = col * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2
      const y = KIND_HEADER_HEIGHT + row * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2
      positioned.push({ ...leaf, x, y, width: NODE_WIDTH, height: NODE_HEIGHT })
    })
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
export function layoutGraphByHost(nodes: KNode[], _edges: KEdge[]): Layout {
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
    const cells = nodeCard ? [nodeCard, ...pods] : pods
    if (cells.length === 0) continue
    const grid = gridDims(cells.length)
    const positioned: PositionedNode[] = []
    cells.forEach((n, i) => {
      const row = Math.floor(i / grid.cols)
      const col = i % grid.cols
      const x = col * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2
      const y = KIND_HEADER_HEIGHT + row * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2
      positioned.push({ ...n, x, y, width: NODE_WIDTH, height: NODE_HEIGHT })
    })
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
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(n.kind)
    if (!cur) {
      groups.set(n.kind, { minX: left, minY: top, maxX: right, maxY: bottom })
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

// layoutGraph arranges the relationship graph top-to-bottom within each connected component, then
// packs the components into a viewport-shaped block. Edges with a missing endpoint are dropped
// defensively (the server should not emit them). `rankdir` switches the per-component direction
// — 'TB' (default) reads top-down like the ownership tree; 'LR' reads left-to-right and is used
// by the Volumes view so "Pod mounts ConfigMap" reads as an arrow pointing right.
export function layoutGraph(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB'): Layout {
  const present = new Set(nodes.map((n) => n.id))
  const laidEdges = edges.filter((e) => present.has(e.from) && present.has(e.to))

  const groups = connectedComponents(nodes, laidEdges)
  const components = groups.map((g) => layoutComponent(g.nodes, g.edges, rankdir))

  return packComponents(components)
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

// gridDims chooses a near-square column count for n leaves, leaning slightly wide.
function gridDims(n: number): { cols: number; rows: number; w: number; h: number } {
  const cols = Math.min(n, Math.ceil(Math.sqrt(n * TARGET_ASPECT)))
  const rows = Math.ceil(n / cols)
  return {
    cols,
    rows,
    w: cols * NODE_WIDTH + (cols - 1) * LEAF_GAP_X,
    h: rows * NODE_HEIGHT + (rows - 1) * LEAF_GAP_Y,
  }
}

interface Hub {
  id: string
  leaves: KNode[]
  side: 'above' | 'below' // which side of the hub card the grid sits on
  grid: { cols: number; rows: number; w: number; h: number }
}

// findHubs detects nodes whose many degree-1 neighbors should be grid-wrapped. A leaf is wrapped
// under the neighbor it connects to; the grid sits on the leaf side of the edge (a Node's pods
// read below it; a ReplicaSet's pods read below it too, since edges point parent->child).
function findHubs(nodes: KNode[], edges: KEdge[]): { hubs: Hub[]; wrapped: Set<string> } {
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
    hubs.push({ id, leaves, side: hubIsTarget > leaves.length / 2 ? 'above' : 'below', grid: gridDims(leaves.length) })
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
function layoutComponent(nodes: KNode[], edges: KEdge[], rankdir: 'TB' | 'LR' = 'TB'): Component {
  const { hubs, wrapped } = rankdir === 'TB' ? findHubs(nodes, edges) : { hubs: [], wrapped: new Set<string>() }
  const hubById = new Map(hubs.map((h) => [h.id, h]))
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
      g.setNode(n.id, { width: Math.max(NODE_WIDTH, hub.grid.w), height: NODE_HEIGHT + HUB_GAP + hub.grid.h })
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
    const boxH = NODE_HEIGHT + HUB_GAP + hub.grid.h
    const top = p.y - boxH / 2
    const cardY = hub.side === 'below' ? top + NODE_HEIGHT / 2 : p.y + boxH / 2 - NODE_HEIGHT / 2
    const gridTop = hub.side === 'below' ? top + NODE_HEIGHT + HUB_GAP : top
    positioned.push({ ...n, x: p.x, y: cardY, width: NODE_WIDTH, height: NODE_HEIGHT })
    cardCenter.set(n.id, { x: p.x, y: cardY })
    placeLeaves(hub, p.x, gridTop, positioned)
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

// placeLeaves lays a hub's leaf-neighbors in a centered grid starting at gridTop, appending them
// to out.
function placeLeaves(hub: Hub, centerX: number, gridTop: number, out: PositionedNode[]): void {
  const { cols } = hub.grid
  const rowWidth = (c: number) => c * NODE_WIDTH + (c - 1) * LEAF_GAP_X
  hub.leaves.forEach((leaf, i) => {
    const row = Math.floor(i / cols)
    const col = i % cols
    const inRow = Math.min(cols, hub.leaves.length - row * cols)
    const left = centerX - rowWidth(inRow) / 2
    const x = left + col * (NODE_WIDTH + LEAF_GAP_X) + NODE_WIDTH / 2
    const y = gridTop + row * (NODE_HEIGHT + LEAF_GAP_Y) + NODE_HEIGHT / 2
    out.push({ ...leaf, x, y, width: NODE_WIDTH, height: NODE_HEIGHT })
  })
}

// packComponents lays component boxes left-to-right into shelves, wrapping at a target row width
// chosen so the whole block is about TARGET_ASPECT wide-to-tall. Tallest-first keeps shelves tidy.
// gap overrides COMPONENT_GAP when the caller needs more spacing (e.g. kind-grouped All view).
function packComponents(components: Component[], gap = COMPONENT_GAP): Layout {
  if (components.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const sorted = [...components].sort((a, b) => b.height - a.height)
  const totalArea = sorted.reduce((s, c) => s + (c.width + gap) * (c.height + gap), 0)
  const maxWidth = Math.max(...sorted.map((c) => c.width))
  const targetWidth = Math.max(maxWidth, Math.sqrt(totalArea * TARGET_ASPECT))

  const allNodes: PositionedNode[] = []
  const allEdges: PositionedEdge[] = []
  let cursorX = 0
  let shelfY = 0
  let shelfHeight = 0
  let totalWidth = 0

  for (const c of sorted) {
    if (cursorX > 0 && cursorX + c.width > targetWidth) {
      shelfY += shelfHeight + gap
      cursorX = 0
      shelfHeight = 0
    }
    const dx = cursorX
    const dy = shelfY
    for (const n of c.nodes) allNodes.push({ ...n, x: n.x + dx, y: n.y + dy })
    for (const e of c.edges) allEdges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
    cursorX += c.width + gap
    shelfHeight = Math.max(shelfHeight, c.height)
    totalWidth = Math.max(totalWidth, cursorX - gap)
  }

  const margin = 28
  const shifted = allNodes.map((n) => ({ ...n, x: n.x + margin, y: n.y + margin }))
  const shiftedEdges = allEdges.map((e) => ({ ...e, points: e.points.map((p) => ({ x: p.x + margin, y: p.y + margin })) }))
  return {
    nodes: shifted,
    edges: shiftedEdges,
    width: totalWidth + margin * 2,
    height: shelfY + shelfHeight + margin * 2,
  }
}
