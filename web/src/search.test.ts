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

  it('matches the "pvc" short-name alias so searching "PVC" finds a PersistentVolumeClaim', () => {
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

  describe('Kind/name predicate (cycle 295)', () => {
    const pod: KNode = { id: 'p1', kind: 'Pod', name: 'web-abc', health: 'Healthy' }
    const dep: KNode = { id: 'd1', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const cm: KNode = { id: 'cm1', kind: 'ConfigMap', name: 'web-config', health: 'Healthy' }

    it('"Pod/web" matches a Pod whose name contains "web" but not a Deployment "web"', () => {
      expect(nodeMatches(pod, 'Pod/web')).toBe(true)
      expect(nodeMatches(dep, 'Pod/web')).toBe(false)
      expect(nodeMatches(cm, 'Pod/web')).toBe(false)
    })

    it('kubectl short names work on the kind side too: "po/web" → Pod', () => {
      expect(nodeMatches(pod, 'po/web')).toBe(true)
      expect(nodeMatches(dep, 'deploy/web')).toBe(true)
    })

    it('"po/" matches Pods by prefix, NOT kinds that merely contain "po" mid-word', () => {
      // Regression: the kind side was a substring test, so "po/ui" lit Endpoints (end·po·ints) and
      // NetworkPolicy (network·po·licy) alongside Pods. A prefix match drops those mid-word hits.
      const ep: KNode = { id: 'e1', kind: 'Endpoints', name: 'ui', health: 'Healthy' }
      const np: KNode = { id: 'n1', kind: 'NetworkPolicy', name: 'ui', health: 'Healthy' }
      const uiPod: KNode = { id: 'up1', kind: 'Pod', name: 'ui-x', health: 'Healthy' }
      expect(nodeMatches(uiPod, 'po/ui')).toBe(true)
      expect(nodeMatches(ep, 'po/ui')).toBe(false)
      expect(nodeMatches(np, 'po/ui')).toBe(false)
      // Known residual: a genuinely "Po"-prefixed kind still matches (would need the server
      // short-name map to exclude). Far rarer than Pods, and not the egregious mid-word case.
      const pep: KNode = { id: 'pe1', kind: 'PolicyEndpoint', name: 'ui', health: 'Healthy' }
      expect(nodeMatches(pep, 'po/ui')).toBe(true)
    })

    it('"Pod/" with empty name half lights up every Pod (mid-edit case)', () => {
      // The empty name half means "don't constrain the name", so the operator partway through
      // typing "Pod/web…" sees all Pods light up until they commit to a name. The alternative
      // (hide everything) feels broken mid-keystroke.
      expect(nodeMatches(pod, 'Pod/')).toBe(true)
      expect(nodeMatches(dep, 'Pod/')).toBe(false) // Deployment is still excluded
    })

    it('"/web" with empty kind half is name-only — matches the Deployment too', () => {
      expect(nodeMatches(dep, '/web')).toBe(true)
      expect(nodeMatches(pod, '/web')).toBe(true)
      expect(nodeMatches(cm, '/web')).toBe(true) // name contains 'web'
    })

    it('more than one slash is treated as plain substring (paths in labels etc.)', () => {
      const labeled: KNode = { id: 'l1', kind: 'Pod', name: 'x', health: 'Healthy', labels: { path: 'a/b/c' } }
      expect(nodeMatches(labeled, 'a/b/c')).toBe(true)
    })

    it('a single-slash query that is not a kind still matches label keys and images', () => {
      // "app.kubernetes.io/managed-by" has exactly one slash, so the structured reading kicks in,
      // fails (no kind is named "app.kubernetes.io…"), and must FALL THROUGH to plain substring —
      // returning false here made the dominant label-key form silently unsearchable.
      const labeled: KNode = {
        id: 'l2', kind: 'Pod', name: 'x', health: 'Healthy',
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
      }
      expect(nodeMatches(labeled, 'app.kubernetes.io/managed-by')).toBe(true)
      const imaged: KNode = {
        id: 'i1', kind: 'Pod', name: 'y', health: 'Healthy',
        images: ['registry.example.com/team-a/api:v2'],
      }
      expect(nodeMatches(imaged, 'team-a/api')).toBe(true)
      // The fallback is additive only: a node without the literal string stays unmatched, so the
      // structured strictness ("Pod/web" must not light every Pod) is preserved.
      expect(nodeMatches(imaged, 'Pod/zzz')).toBe(false)
    })
  })
})
