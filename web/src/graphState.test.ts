import { describe, expect, it } from 'vitest'
import { applyPatch, edgeKey, fromSnapshot, spotlightNeighbors, spotlightSubtree } from './graphState'
import type { KEdge, KGraph, Patch } from './types'

const snapshot: KGraph = {
  nodes: [
    { id: 'a', kind: 'Deployment', name: 'a', health: 'Healthy' },
    { id: 'b', kind: 'Pod', name: 'b', health: 'Healthy' },
  ],
  edges: [{ from: 'a', to: 'b', type: 'ownerReference' }],
}

describe('graphState', () => {
  it('indexes nodes by id from a snapshot', () => {
    const s = fromSnapshot(snapshot)
    expect(Object.keys(s.nodes).sort()).toEqual(['a', 'b'])
    expect(s.edges).toHaveLength(1)
  })

  it('tolerates a snapshot with null/missing edges (no-relationship namespace)', () => {
    // A namespace whose resources have no edges marshals server-side as `"edges":null`; fromSnapshot
    // must not throw on it (the `[...null]` crash hung such namespaces forever on "connecting…").
    const s = fromSnapshot({ nodes: [{ id: 'a', kind: 'ConfigMap', name: 'a', health: 'Healthy' }], edges: null as unknown as [] })
    expect(Object.keys(s.nodes)).toEqual(['a'])
    expect(s.edges).toEqual([])
  })

  it('upserts and removes nodes from a patch', () => {
    const s = applyPatch(fromSnapshot(snapshot), {
      upsertNodes: [{ id: 'b', kind: 'Pod', name: 'b', health: 'Degraded' }],
      removeNodeIds: ['a'],
    } satisfies Patch)
    expect(s.nodes['a']).toBeUndefined()
    expect(s.nodes['b'].health).toBe('Degraded')
  })

  it('adds and removes edges without duplicating', () => {
    let s = fromSnapshot(snapshot)
    s = applyPatch(s, {
      upsertEdges: [
        { from: 'a', to: 'b', type: 'ownerReference' }, // already present -> no dup
        { from: 'a', to: 'c', type: 'ownerReference' }, // new
      ],
      removeEdges: [],
    })
    expect(s.edges).toHaveLength(2)

    s = applyPatch(s, { removeEdges: [{ from: 'a', to: 'b', type: 'ownerReference' }] })
    expect(s.edges.map(edgeKey)).toEqual(['a|c|ownerReference'])
  })

  it('does not mutate the previous state', () => {
    const s0 = fromSnapshot(snapshot)
    const s1 = applyPatch(s0, { removeNodeIds: ['a'] })
    expect(s0.nodes['a']).toBeDefined()
    expect(s1.nodes['a']).toBeUndefined()
  })

  // The server happens not to emit remove+upsert for the same edge today (its Diff only emits a
  // delta), but if it ever does — e.g. as a re-affirmation — the upsert should win and the edge
  // stays. The old code's "skip upsert if already in the prior state" lost it instead.
  it('keeps an edge when the same patch both removes and upserts it (upsert wins)', () => {
    const e = { from: 'a', to: 'b', type: 'ownerReference' } as const
    const s = applyPatch(fromSnapshot(snapshot), { removeEdges: [e], upsertEdges: [e] })
    expect(s.edges.map(edgeKey)).toEqual(['a|b|ownerReference'])
  })
})

describe('spotlightSubtree', () => {
  const e = (from: string, to: string, type = 'ownerReference'): KEdge => ({ from, to, type } as KEdge)

  it('walks the undirected component, following edges in either direction', () => {
    // dep → rs → pod (downward), and svc → pod (upward into the same pod). Selecting the pod must
    // light the whole chain in BOTH directions, not just descendants.
    const edges = [e('dep', 'rs'), e('rs', 'pod'), e('svc', 'pod', 'selects')]
    const r = spotlightSubtree('pod', edges)
    expect([...r.nodes].sort()).toEqual(['dep', 'pod', 'rs', 'svc'])
    expect(r.edges.size).toBe(3) // every edge in the component is traversed
  })

  it('stops at the boundary of the connected component', () => {
    // Two disjoint components: selecting in one must not light the other.
    const edges = [e('a', 'b'), e('c', 'd')]
    const r = spotlightSubtree('a', edges)
    expect([...r.nodes].sort()).toEqual(['a', 'b'])
    expect(r.edges.size).toBe(1)
  })

  it('returns just the node itself when it has no edges', () => {
    const r = spotlightSubtree('lonely', [e('a', 'b')])
    expect([...r.nodes]).toEqual(['lonely'])
    expect(r.edges.size).toBe(0)
  })

  it('terminates on a cycle (each edge traversed once)', () => {
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a')]
    const r = spotlightSubtree('a', edges)
    expect([...r.nodes].sort()).toEqual(['a', 'b', 'c'])
    expect(r.edges.size).toBe(3)
  })
})

describe('spotlightNeighbors', () => {
  const e = (from: string, to: string, type = 'ownerReference'): KEdge => ({ from, to, type } as KEdge)

  it('lights only the one-hop neighbours, not the transitive component', () => {
    // dep → rs → pod. Selecting the pod lights the pod and its DIRECT neighbour rs, but NOT dep
    // (two hops up) — the difference from spotlightSubtree, which would walk the whole chain.
    const edges = [e('dep', 'rs'), e('rs', 'pod')]
    const r = spotlightNeighbors('pod', edges)
    expect([...r.nodes].sort()).toEqual(['pod', 'rs'])
    expect(r.edges.size).toBe(1) // only rs→pod
  })

  it('follows edges in either direction (incoming and outgoing)', () => {
    // pod is owned by rs (incoming) and selected by svc (outgoing) — both direct, both lit.
    const edges = [e('rs', 'pod'), e('svc', 'pod', 'selects'), e('rs', 'other')]
    const r = spotlightNeighbors('pod', edges)
    expect([...r.nodes].sort()).toEqual(['pod', 'rs', 'svc'])
    expect(r.edges.size).toBe(2) // rs→pod and svc→pod; rs→other is not adjacent to pod
  })

  it('returns just the node itself when it has no edges', () => {
    const r = spotlightNeighbors('lonely', [e('a', 'b')])
    expect([...r.nodes]).toEqual(['lonely'])
    expect(r.edges.size).toBe(0)
  })
})
