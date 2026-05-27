// Pure graph layout: turns nodes+edges into positioned geometry. No DOM, so it is
// unit-testable. See docs/ADR/20260527-frontend-stack.md.
//
// A namespace is many small, disconnected ownership trees. Laying them all in one Dagre graph
// puts every tree in a single horizontal row — a wide, unreadable smear once fit to screen. So
// we lay out each connected component on its own, then bin-pack the components into a block whose
// aspect ratio matches the viewport. That turns a 1xN row into a roughly NxN grid.

import dagre from '@dagrejs/dagre'
import type { KEdge, KNode } from './types'

export const NODE_WIDTH = 190
export const NODE_HEIGHT = 56

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

// layoutGraph arranges the relationship graph top-to-bottom within each connected component, then
// packs the components into a viewport-shaped block. Edges with a missing endpoint are dropped
// defensively (the server should not emit them).
export function layoutGraph(nodes: KNode[], edges: KEdge[]): Layout {
  const present = new Set(nodes.map((n) => n.id))
  const laidEdges = edges.filter((e) => present.has(e.from) && present.has(e.to))

  const groups = connectedComponents(nodes, laidEdges)
  const components = groups.map((g) => layoutComponent(g.nodes, g.edges))

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

// layoutComponent runs Dagre top-to-bottom over one component and returns its local geometry
// (origin at 0,0) plus its bounding size. High-fanout hubs reserve a tall/wide Dagre box and place
// their leaves in a grid, so a parent with many children becomes a block, not a one-rank smear.
function layoutComponent(nodes: KNode[], edges: KEdge[]): Component {
  const { hubs, wrapped } = findHubs(nodes, edges)
  const hubById = new Map(hubs.map((h) => [h.id, h]))
  const skeleton = nodes.filter((n) => !wrapped.has(n.id))
  const skeletonEdges = edges.filter((e) => !wrapped.has(e.from) && !wrapped.has(e.to))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 52, marginx: 0, marginy: 0 })
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
function packComponents(components: Component[]): Layout {
  if (components.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const sorted = [...components].sort((a, b) => b.height - a.height)
  const totalArea = sorted.reduce((s, c) => s + (c.width + COMPONENT_GAP) * (c.height + COMPONENT_GAP), 0)
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
      shelfY += shelfHeight + COMPONENT_GAP
      cursorX = 0
      shelfHeight = 0
    }
    const dx = cursorX
    const dy = shelfY
    for (const n of c.nodes) allNodes.push({ ...n, x: n.x + dx, y: n.y + dy })
    for (const e of c.edges) allEdges.push({ ...e, points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) })
    cursorX += c.width + COMPONENT_GAP
    shelfHeight = Math.max(shelfHeight, c.height)
    totalWidth = Math.max(totalWidth, cursorX - COMPONENT_GAP)
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
