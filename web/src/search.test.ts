import { describe, expect, it } from 'vitest'
import { nodeMatches } from './search'
import type { KNode } from './types'

const node: KNode = {
  id: '1',
  kind: 'Deployment',
  name: 'shop-web',
  health: 'Healthy',
  labels: { app: 'shop', tier: 'frontend' },
  images: ['registry.example.com/web:v2.1'],
}

describe('nodeMatches', () => {
  it('matches by name substring', () => {
    expect(nodeMatches(node, 'shop-w')).toBe(true)
  })

  it('matches by kind, case-insensitively', () => {
    expect(nodeMatches(node, 'deployment')).toBe(true)
  })

  it('matches by label key or value', () => {
    expect(nodeMatches(node, 'tier')).toBe(true)
    expect(nodeMatches(node, 'frontend')).toBe(true)
  })

  it('matches by container image', () => {
    expect(nodeMatches(node, 'web:v2')).toBe(true)
    expect(nodeMatches(node, 'registry.example.com')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(nodeMatches(node, 'postgres')).toBe(false)
  })

  it('never matches an empty query', () => {
    expect(nodeMatches(node, '')).toBe(false)
  })

  it('tolerates a node without labels or images', () => {
    const bare: KNode = { id: '2', kind: 'ConfigMap', name: 'settings', health: 'Healthy' }
    expect(nodeMatches(bare, 'settings')).toBe(true)
    expect(nodeMatches(bare, 'nginx')).toBe(false)
  })
})
