import { describe, expect, it } from 'vitest'
import { compareNamespaces, mostTroubled, namespaceLabel, nextTroubled, troubledNamespaces } from './ns'
import { CLUSTER_SCOPE, type NamespaceInfo } from './api'

const list: NamespaceInfo[] = [
  { name: 'zeta', health: 'Healthy' },
  { name: 'alpha', health: 'Healthy' },
  { name: 'beta', health: 'Degraded', nonReady: 2 },
  { name: 'gamma', health: 'Degraded', nonReady: 5 },
  { name: 'delta', health: 'Progressing', nonReady: 1 },
]

describe('compareNamespaces', () => {
  it('orders by worst health, then non-ready count, then name', () => {
    const order = [...list].sort(compareNamespaces).map((n) => n.name)
    expect(order).toEqual(['gamma', 'beta', 'delta', 'alpha', 'zeta'])
  })
})

describe('mostTroubled', () => {
  it('returns the worst namespace', () => {
    expect(mostTroubled(list)?.name).toBe('gamma')
  })
  it('returns undefined for an empty list', () => {
    expect(mostTroubled([])).toBeUndefined()
  })
  it('skips the cluster pseudo-namespace even when it is the most degraded', () => {
    // The [cluster] entry is a synthetic scope, not a namespace to navigate to on startup;
    // auto-selection should always land on a real namespace.
    const withCluster: NamespaceInfo[] = [
      { name: CLUSTER_SCOPE, health: 'Degraded', nonReady: 99 },
      { name: 'alpha', health: 'Healthy' },
      { name: 'beta', health: 'Progressing', nonReady: 1 },
    ]
    expect(mostTroubled(withCluster)?.name).toBe('beta')
  })
})

describe('troubledNamespaces', () => {
  it('returns only Degraded/Progressing, worst-first (the badge-count set)', () => {
    // Healthy excluded; Unknown/Suspended are non-actionable and must not appear (matches the badge).
    const withNoise: NamespaceInfo[] = [
      ...list,
      { name: 'eps', health: 'Unknown', nonReady: 9 },
      { name: 'zid', health: 'Suspended' },
      { name: CLUSTER_SCOPE, health: 'Degraded', nonReady: 99 },
    ]
    expect(troubledNamespaces(withNoise).map((n) => n.name)).toEqual(['gamma', 'beta', 'delta'])
  })
})

describe('nextTroubled', () => {
  it('first step (current not troubled / unselected) lands on the worst', () => {
    expect(nextTroubled(list, null)?.name).toBe('gamma')
    expect(nextTroubled(list, 'alpha')?.name).toBe('gamma') // currently on a healthy ns
  })
  it('repeated steps advance worst→next-worst and wrap, so all troubled get visited', () => {
    expect(nextTroubled(list, 'gamma')?.name).toBe('beta')
    expect(nextTroubled(list, 'beta')?.name).toBe('delta')
    expect(nextTroubled(list, 'delta')?.name).toBe('gamma') // wraps at the end
  })
  it('returns undefined when nothing is troubled', () => {
    expect(nextTroubled([{ name: 'a', health: 'Healthy' }], null)).toBeUndefined()
    expect(nextTroubled([], null)).toBeUndefined()
  })
})

describe('namespaceLabel', () => {
  it('maps the cluster sentinel to the user-facing [cluster] label, never the raw __cluster__', () => {
    expect(namespaceLabel(CLUSTER_SCOPE)).toBe('[cluster]')
    expect(namespaceLabel(CLUSTER_SCOPE)).not.toContain('__')
  })
  it('passes a real namespace name through unchanged', () => {
    expect(namespaceLabel('team-a')).toBe('team-a')
  })
})
