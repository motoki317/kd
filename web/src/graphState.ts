// Pure reducer mapping the SSE snapshot/patch protocol onto a graph state. Kept free of Solid
// so it can be unit-tested and reused; the store wires it into reactivity.

import type { KEdge, KGraph, KNode, Patch } from './types'

export interface GraphState {
  nodes: Record<string, KNode>
  edges: KEdge[]
}

export const emptyState = (): GraphState => ({ nodes: {}, edges: [] })

// edgeKey identifies an edge by its endpoints and type, matching the server's edge identity.
export const edgeKey = (e: KEdge): string => [e.from, e.to, e.type].join('|')

export function fromSnapshot(g: KGraph): GraphState {
  const nodes: Record<string, KNode> = {}
  for (const n of g.nodes) nodes[n.id] = n
  return { nodes, edges: [...g.edges] }
}

export function applyPatch(state: GraphState, p: Patch): GraphState {
  const nodes = { ...state.nodes }
  for (const n of p.upsertNodes ?? []) nodes[n.id] = n
  for (const id of p.removeNodeIds ?? []) delete nodes[id]

  const removed = new Set((p.removeEdges ?? []).map(edgeKey))
  const present = new Set(state.edges.map(edgeKey))
  const edges = state.edges.filter((e) => !removed.has(edgeKey(e)))
  for (const e of p.upsertEdges ?? []) {
    if (!present.has(edgeKey(e)) && !removed.has(edgeKey(e))) edges.push(e)
  }
  return { nodes, edges }
}
