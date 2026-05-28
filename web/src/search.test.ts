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

  it('matches by status — finding "CrashLoopBackOff" reveals every troubled pod at once', () => {
    const crashing: KNode = { id: '3', kind: 'Pod', name: 'p', health: 'Degraded', status: 'CrashLoopBackOff' }
    expect(nodeMatches(crashing, 'crashloop')).toBe(true)
  })

  it('matches by host so "node-1" finds every pod scheduled on it', () => {
    const onNode: KNode = { id: '4', kind: 'Pod', name: 'p', health: 'Healthy', host: 'worker-3' }
    expect(nodeMatches(onNode, 'worker-3')).toBe(true)
  })

  it('matches by cluster IP and external IP so an address pastes in to find its service', () => {
    const svc: KNode = { id: '5', kind: 'Service', name: 's', health: 'Healthy', clusterIP: '10.96.0.7', externalIP: '203.0.113.7' }
    expect(nodeMatches(svc, '10.96.0.7')).toBe(true)
    expect(nodeMatches(svc, '203.0.113.7')).toBe(true)
  })

  it('matches the displayed kind label so searching "PVC" finds a PersistentVolumeClaim', () => {
    const pvc: KNode = { id: '6', kind: 'PersistentVolumeClaim', name: 'data', health: 'Healthy' }
    expect(nodeMatches(pvc, 'pvc')).toBe(true)
  })

  it('matches kubectl short names that are not substrings of the full kind', () => {
    // "svc" is not a substring of "Service" and "sts" is not a substring of "StatefulSet" — but
    // they're what operators type in kubectl, so the topology should follow that muscle memory.
    const svc: KNode = { id: '7', kind: 'Service', name: 's', health: 'Healthy' }
    const sts: KNode = { id: '8', kind: 'StatefulSet', name: 'db', health: 'Healthy' }
    expect(nodeMatches(svc, 'svc')).toBe(true)
    expect(nodeMatches(sts, 'sts')).toBe(true)
  })
})
