import { describe, expect, it } from 'vitest'
import { nextSelection, orderedForNav } from './nav'
import type { Health, KNode } from './types'

function node(id: string, kind: string, name: string, health: Health = 'Healthy'): KNode {
  return { id, kind, name, health }
}

describe('orderedForNav', () => {
  it('puts the most troubled nodes first, then kind, then name', () => {
    const nodes = [
      node('a', 'Pod', 'zeta', 'Healthy'),
      node('b', 'Pod', 'alpha', 'Degraded'),
      node('c', 'Deployment', 'web', 'Progressing'),
      node('d', 'Pod', 'alpha', 'Healthy'),
    ]
    expect(orderedForNav(nodes).map((n) => n.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('does not mutate the input', () => {
    const nodes = [node('a', 'Pod', 'b'), node('c', 'Pod', 'a')]
    const before = nodes.map((n) => n.id)
    orderedForNav(nodes)
    expect(nodes.map((n) => n.id)).toEqual(before)
  })
})

describe('nextSelection', () => {
  const nodes = [
    node('healthy', 'Pod', 'a', 'Healthy'),
    node('degraded', 'Pod', 'b', 'Degraded'),
    node('progressing', 'Pod', 'c', 'Progressing'),
  ]
  // ordered troubled-first: degraded, progressing, healthy

  it('selects the most troubled node first when nothing is selected and stepping forward', () => {
    expect(nextSelection(nodes, null, 1)).toBe('degraded')
  })

  it('selects the last node when nothing is selected and stepping backward', () => {
    expect(nextSelection(nodes, null, -1)).toBe('healthy')
  })

  it('steps forward through the ordering', () => {
    expect(nextSelection(nodes, 'degraded', 1)).toBe('progressing')
    expect(nextSelection(nodes, 'progressing', 1)).toBe('healthy')
  })

  it('steps backward through the ordering', () => {
    expect(nextSelection(nodes, 'progressing', -1)).toBe('degraded')
  })

  it('wraps around both ends', () => {
    expect(nextSelection(nodes, 'healthy', 1)).toBe('degraded')
    expect(nextSelection(nodes, 'degraded', -1)).toBe('healthy')
  })

  it('returns null for an empty graph', () => {
    expect(nextSelection([], null, 1)).toBeNull()
  })

  it('treats an unknown current id like no selection', () => {
    expect(nextSelection(nodes, 'gone', 1)).toBe('degraded')
  })
})
