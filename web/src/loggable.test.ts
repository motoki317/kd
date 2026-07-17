import { describe, expect, it } from 'vitest'
import { descendantPods } from './loggable'
import type { KNode } from './types'

function node(id: string, kind: string, ownerUIDs: string[] = []): KNode {
  return { id, kind, name: id, health: 'Healthy', ownerUIDs } as KNode
}

describe('descendantPods', () => {
  it('collects Pods through a multi-hop ownership chain', () => {
    const nodes = [node('dep', 'Deployment'), node('rs', 'ReplicaSet', ['dep']), node('pod', 'Pod', ['rs'])]
    expect(descendantPods('dep', nodes).map((n) => n.id)).toEqual(['pod'])
  })

  it('returns no Pods for a resource with no Pod descendants', () => {
    const nodes = [node('cm', 'ConfigMap'), node('dep', 'Deployment'), node('rs', 'ReplicaSet', ['dep'])]
    expect(descendantPods('cm', nodes)).toEqual([])
    expect(descendantPods('dep', nodes)).toEqual([])
  })

  it('de-duplicates Pods and terminates on ownership cycles', () => {
    const nodes = [
      node('root', 'X'),
      node('a', 'X', ['root', 'b']),
      node('b', 'X', ['root', 'a']),
      node('pod', 'Pod', ['a', 'b']),
    ]
    expect(descendantPods('root', nodes).map((n) => n.id)).toEqual(['pod'])
  })
})
