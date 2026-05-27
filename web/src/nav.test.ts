import { describe, expect, it } from 'vitest'
import { navCandidates, nextSelection, orderedForNav, resolveSelectionOnSnapshot } from './nav'
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

describe('navCandidates', () => {
  const nodes = [
    node('a', 'Pod', 'web', 'Healthy'),
    node('b', 'Pod', 'api', 'Degraded'),
    node('c', 'Deployment', 'web', 'Degraded'),
  ]

  it('returns every node when no filter is active', () => {
    expect(navCandidates(nodes, '', null).map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('scopes to the health filter when set', () => {
    expect(navCandidates(nodes, '', 'Degraded').map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('scopes to the search query, taking precedence over the health filter', () => {
    expect(navCandidates(nodes, 'web', 'Degraded').map((n) => n.id)).toEqual(['a', 'c'])
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

describe('resolveSelectionOnSnapshot', () => {
  const nodes = [node('uid-1', 'Service', 'kube-dns'), node('uid-2', 'Pod', 'web')]

  it('keeps the current selection when its node is still present (cross-view continuity)', () => {
    expect(resolveSelectionOnSnapshot(nodes, 'uid-2', null)).toEqual({ id: 'uid-2', consumedPending: false })
  })

  it('clears a selection whose node is gone and adopts no deep-link', () => {
    expect(resolveSelectionOnSnapshot(nodes, 'stale', null)).toEqual({ id: null, consumedPending: false })
  })

  it('adopts a URL deep-link by Kind/name when nothing is kept', () => {
    expect(resolveSelectionOnSnapshot(nodes, null, 'Service/kube-dns')).toEqual({ id: 'uid-1', consumedPending: true })
  })

  it('leaves the deep-link pending when its node is not in this snapshot yet', () => {
    expect(resolveSelectionOnSnapshot(nodes, null, 'Pod/not-here')).toEqual({ id: null, consumedPending: false })
  })

  it('prefers a kept selection over a deep-link', () => {
    expect(resolveSelectionOnSnapshot(nodes, 'uid-2', 'Service/kube-dns')).toEqual({ id: 'uid-2', consumedPending: false })
  })
})
