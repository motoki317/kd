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

// spotlightSubtree walks the UNDIRECTED connected component of `id` over `edges` (following each edge
// in either direction), returning the reachable node ids and the traversed edge keys. Drives the
// selection spotlight + fit: selecting a node lights its whole related subtree. The caller passes the
// DISPLAYED edge set (the relFilter projection), so the spotlight matches what's on screen rather than
// dragging in nodes reachable only via a relationship the operator has turned off.
export function spotlightSubtree(id: string, edges: KEdge[]): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>([id])
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of edges) {
      const k = edgeKey(e)
      if (seen.has(k)) continue
      if (e.from === cur || e.to === cur) {
        seen.add(k)
        const next = e.from === cur ? e.to : e.from
        if (!nodes.has(next)) {
          nodes.add(next)
          queue.push(next)
        }
      }
    }
  }
  return { nodes, edges: seen }
}

export function fromSnapshot(g: KGraph): GraphState {
  const nodes: Record<string, KNode> = {}
  // Tolerate a missing/null nodes or edges array: a namespace whose resources have no relationships
  // (e.g. a system namespace holding only a ConfigMap + ServiceAccount) yields zero edges, which the
  // server marshals as JSON `null` (a nil Go slice). `[...null]` throws — and the throw landed inside
  // the EventSource snapshot listener, BEFORE connState flipped to 'live', so such namespaces hung
  // forever on "connecting…". The server also now sends `[]`, but stay defensive on the client.
  for (const n of g.nodes ?? []) nodes[n.id] = n
  return { nodes, edges: [...(g.edges ?? [])] }
}

export function applyPatch(state: GraphState, p: Patch): GraphState {
  const nodes = { ...state.nodes }
  for (const n of p.upsertNodes ?? []) nodes[n.id] = n
  for (const id of p.removeNodeIds ?? []) delete nodes[id]

  // Apply removes first, then upserts onto the result — so a "remove + upsert" for the same edge
  // in one patch ends with the edge present (upsert wins), and an upsert of an already-present key
  // is a no-op rather than a duplicate.
  const removed = new Set((p.removeEdges ?? []).map(edgeKey))
  const edges = state.edges.filter((e) => !removed.has(edgeKey(e)))
  const present = new Set(edges.map(edgeKey))
  for (const e of p.upsertEdges ?? []) {
    const k = edgeKey(e)
    if (!present.has(k)) {
      edges.push(e)
      present.add(k)
    }
  }
  return { nodes, edges }
}
