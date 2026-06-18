import { describe, expect, it } from 'vitest'
import { compareNamespaces, mergeNamespaceHealth, mostTroubled, namespaceLabel, nextTroubled, troubledNamespaces } from './ns'
import { CLUSTER_SCOPE, type NamespaceInfo } from './api'
import type { LiveHealth } from './ns'

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

describe('mergeNamespaceHealth', () => {
  // The poll says api-b is Progressing with 2 not-ready; the live SSE summaries override it.
  const poll: NamespaceInfo[] = [
    { name: 'api-b', health: 'Progressing', nonReady: 2 },
    { name: 'shop', health: 'Healthy' },
  ]
  const entry = (over: Partial<LiveHealth>): LiveHealth => ({ health: 'Healthy', gen: 5, ctx: 'ctxA', ...over })
  const apiB = (rows: NamespaceInfo[]) => rows.find((n) => n.name === 'api-b')!

  it('returns the poll list untouched when the live cache is empty', () => {
    expect(mergeNamespaceHealth(poll, {}, 5, 'ctxA')).toEqual(poll)
  })

  it('applies a current-context entry recorded in the current poll generation', () => {
    const merged = mergeNamespaceHealth(poll, { 'api-b': entry({ health: 'Healthy' }) }, 5, 'ctxA')
    expect(apiB(merged).health).toBe('Healthy')
    expect(apiB(merged).nonReady).toBeUndefined() // healed → the poll's stale count is dropped
    expect(merged.find((n) => n.name === 'shop')).toBe(poll[1]) // untouched rows pass through by reference
  })

  it('keeps the live value until a newer poll supersedes it — the anti-flap invariant', () => {
    const cache = { 'api-b': entry({ health: 'Degraded', nonReady: 7, gen: 5 }) }
    // gen 5 == current: navigating away does not bump the generation, so the value holds (no revert flap).
    expect(apiB(mergeNamespaceHealth(poll, cache, 5, 'ctxA')).health).toBe('Degraded')
    // gen 5 < 6: a genuine 15s poll has landed, so the namespace self-corrects to the poll value.
    expect(apiB(mergeNamespaceHealth(poll, cache, 6, 'ctxA')).health).toBe('Progressing')
  })

  it('ignores an entry recorded under a different context (same namespace name across clusters)', () => {
    const merged = mergeNamespaceHealth(poll, { 'api-b': entry({ health: 'Healthy', ctx: 'ctxB' }) }, 5, 'ctxA')
    expect(apiB(merged).health).toBe('Progressing')
  })

  it('ignores a cached entry for a namespace absent from the poll list', () => {
    expect(mergeNamespaceHealth(poll, { ghost: entry({ health: 'Degraded' }) }, 5, 'ctxA')).toEqual(poll)
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
