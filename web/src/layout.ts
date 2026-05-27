// Pure graph layout: turns nodes+edges into positioned geometry via Dagre. No DOM, so it is
// unit-testable. See docs/ADR/20260527-frontend-stack.md.

import dagre from '@dagrejs/dagre'
import type { KEdge, KNode } from './types'

export const NODE_WIDTH = 190
export const NODE_HEIGHT = 56

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

// layoutGraph arranges the ownership/relationship graph top-to-bottom. Edges whose endpoints
// are both present are laid out; dangling edges are dropped defensively (the server should not
// emit them).
export function layoutGraph(nodes: KNode[], edges: KEdge[]): Layout {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 56, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  const present = new Set(nodes.map((n) => n.id))
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  const laidEdges = edges.filter((e) => present.has(e.from) && present.has(e.to))
  for (const e of laidEdges) {
    g.setEdge(e.from, e.to)
  }

  dagre.layout(g)

  const positioned: PositionedNode[] = nodes.map((n) => {
    const p = g.node(n.id)
    return { ...n, x: p.x, y: p.y, width: NODE_WIDTH, height: NODE_HEIGHT }
  })
  const positionedEdges: PositionedEdge[] = laidEdges.map((e) => ({
    ...e,
    points: g.edge(e.from, e.to).points,
  }))
  const { width = 0, height = 0 } = g.graph()
  return { nodes: positioned, edges: positionedEdges, width, height }
}
