// Kind grouping (the "All" view): every kind in its own grid box, boxes packed into a balanced
// lattice, plus the kind bounding rects the renderer labels and outlines.

import type { KEdge, KNode } from '../types'
import {
  byName,
  type CollapseMeta,
  type Component,
  COMPONENT_GAP,
  KIND_HEADER_HEIGHT,
  type Layout,
  LEAF_GAP_X,
  LEAF_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  type PositionedEdge,
  type PositionedNode,
  TARGET_ASPECT,
} from './core'
import { pillCell, splitForFold } from './collapse'

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
