import { describe, expect, it } from 'vitest'
import { compareNamespaces, mostTroubled } from './ns'
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
