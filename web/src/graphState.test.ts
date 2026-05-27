import { describe, expect, it } from 'vitest'
import { applyPatch, edgeKey, fromSnapshot } from './graphState'
import type { KGraph, Patch } from './types'

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
})
