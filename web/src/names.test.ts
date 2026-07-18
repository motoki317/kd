import { afterEach, describe, expect, it } from 'vitest'
import { cardKindLabel, cardName, cardStatus, cardTitle, kindShortLabel, middleTruncate, pluralizeKind, prefixParentNames, relativeName, selectionLabel, setServerShortNames, shortNodeName } from './names'
import type { KNode } from './types'

describe('relativeName', () => {
  it('strips the owner prefix following the generated-name convention', () => {
    expect(relativeName('api-7d9f-2xkp', 'api-7d9f')).toBe('2xkp')
    expect(relativeName('api-7d9f', 'api')).toBe('7d9f')
  })
  it('leaves the name when the owner is not a prefix (e.g. a Node hosting a pod)', () => {
    expect(relativeName('api-7d9f-2xkp', 'docker-desktop')).toBe('api-7d9f-2xkp')
    expect(relativeName('web', undefined)).toBe('web')
  })
  it('does not strip when it would leave an empty string', () => {
    expect(relativeName('api', 'api')).toBe('api')
  })
})

describe('shortNodeName', () => {
  it('drops the DNS domain from cloud node names, keeping the distinguishing hostname', () => {
    expect(shortNodeName('ip-10-8-77-146.us-west-2.compute.internal')).toBe('ip-10-8-77-146')
    expect(shortNodeName('fargate-ip-10-8-69-217.us-west-2.compute.internal')).toBe('fargate-ip-10-8-69-217')
    expect(shortNodeName('worker-1.cluster.local')).toBe('worker-1')
  })
  it('leaves dotless names unchanged (docker-desktop, GKE pool nodes)', () => {
    expect(shortNodeName('docker-desktop')).toBe('docker-desktop')
    expect(shortNodeName('gke-prod-default-pool-abc12345-xy3z')).toBe('gke-prod-default-pool-abc12345-xy3z')
  })
  it('does not strip a leading-dot edge case into an empty string', () => {
    expect(shortNodeName('.hidden')).toBe('.hidden') // indexOf('.')===0, not >0 → unchanged
  })
})

describe('kindShortLabel', () => {
  afterEach(() => setServerShortNames({}))

  it('falls back to the hardcoded table / upper-cased kind before the server map loads', () => {
    expect(kindShortLabel('Secret')).toBe('SECRT')
    expect(kindShortLabel('Pod')).toBe('POD')
  })

  it("prefers the cluster's API short name, upper-cased", () => {
    // The user's examples: kubectl abbreviates these, the old hardcoded guesses didn't.
    setServerShortNames({ ConfigMap: 'cm', PodDisruptionBudget: 'pdb', Deployment: 'deploy' })
    expect(kindShortLabel('ConfigMap')).toBe('CM')
    expect(kindShortLabel('PodDisruptionBudget')).toBe('PDB')
    expect(kindShortLabel('Deployment')).toBe('DEPLOY')
  })

  it('keeps the fallback for kinds the API gives no short name (e.g. a CRD-less Secret)', () => {
    setServerShortNames({ ConfigMap: 'cm' })
    expect(kindShortLabel('Secret')).toBe('SECRT')
    expect(kindShortLabel('Workflow')).toBe('WORKFLOW')
  })
})

describe('cardKindLabel', () => {
  afterEach(() => setServerShortNames({}))

  it('passes short labels through untouched', () => {
    expect(cardKindLabel('Pod')).toBe('POD')
    expect(cardKindLabel('Service')).toBe('SERVICE') // 'SERVICE' is exactly 7 chars → fits, untouched
  })

  it('keeps the 6-char API/fallback shorts intact', () => {
    setServerShortNames({ NetworkPolicy: 'netpol', Deployment: 'deploy' })
    expect(cardKindLabel('NetworkPolicy')).toBe('NETPOL')
    expect(cardKindLabel('Deployment')).toBe('DEPLOY')
  })

  it('ellipsis-truncates an unabbreviated long kind so it fits the icon column', () => {
    // A CRD with no API short name upper-cases to its full kind; cap at 7 chars incl. the ellipsis.
    expect(cardKindLabel('ClusterIssuer')).toBe('CLUSTE…')
    expect(cardKindLabel('Workflow')).toBe('WORKFL…')
  })
})

describe('middleTruncate', () => {
  it('keeps short names intact', () => {
    expect(middleTruncate('web', 22)).toBe('web')
  })
  it('keeps head and tail, dropping the middle', () => {
    const out = middleTruncate('sample-app-with-a-very-long-name-5c4', 22)
    expect(out.length).toBe(22)
    expect(out.startsWith('sample')).toBe(true)
    expect(out.endsWith('5c4')).toBe(true)
    expect(out).toContain('…')
  })
})

describe('cardName', () => {
  it('strips the owner prefix and marks the elision with a leading "…-"', () => {
    expect(cardName('api-7d9f-2xkp', 'api-7d9f')).toBe('…-2xkp')
  })
  it('leaves a non-relative name unmarked', () => {
    expect(cardName('api-7d9f-2xkp', 'docker-desktop')).toBe('api-7d9f-2xkp')
    expect(cardName('web', undefined)).toBe('web')
  })
  it('middle-truncates the relative tail but keeps the elision mark within budget', () => {
    const out = cardName('owner', 'owner') // no strip (would be empty) → unmarked
    expect(out).toBe('owner')
    const long = cardName(`api-7d9f-${'x'.repeat(40)}`, 'api-7d9f')
    expect(out.length).toBeLessThanOrEqual(22)
    expect(long.startsWith('…-')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(22)
  })
  it('middle-truncates an over-long name to the card budget', () => {
    // The name has its own row with no competing badge, so it uses full CARD_NAME_MAX.
    const long = 'kube-scheduler-docker-desktop'
    const out = cardName(long, undefined)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('…')
    expect(out.startsWith('kube')).toBe(true)
    expect(out.endsWith('desktop')).toBe(true)
  })
})

describe('prefixParentNames', () => {
  const n = (id: string, name: string) => ({ id, name, kind: 'Pod', health: 'Healthy' as const })
  const e = (from: string, to: string, type = 'ownerReference') => ({ from, to, type: type as never })

  it('maps a child to a parent whose name is a "-"-bounded prefix', () => {
    const m = prefixParentNames([n('rs', 'api-7d9f'), n('po', 'api-7d9f-2xkp')], [e('rs', 'po')])
    expect(m.get('po')).toBe('api-7d9f')
  })
  it('keeps the LONGEST prefix-parent (closest ancestor wins)', () => {
    // Deployment "api" and ReplicaSet "api-7d9f" both prefix the Pod; the ReplicaSet is closer.
    const nodes = [n('dep', 'api'), n('rs', 'api-7d9f'), n('po', 'api-7d9f-2xkp')]
    const m = prefixParentNames(nodes, [e('dep', 'po'), e('rs', 'po')])
    expect(m.get('po')).toBe('api-7d9f')
  })
  it('ignores an edge whose source name is not an ancestor prefix (a Service selecting a Pod)', () => {
    // "frontend" does not prefix "api-7d9f-2xkp", so no relative stripping.
    const m = prefixParentNames([n('svc', 'frontend'), n('po', 'api-7d9f-2xkp')], [e('svc', 'po', 'selects')])
    expect(m.has('po')).toBe(false)
  })
  it('requires the hyphen boundary (a bare string prefix without "-" is not a parent)', () => {
    // "api" prefixes "apiserver" textually but not at a '-' boundary → not a tree parent.
    const m = prefixParentNames([n('a', 'api'), n('b', 'apiserver')], [e('a', 'b')])
    expect(m.has('b')).toBe(false)
  })
  it('walks any edge type, not just ownerReference (a refers edge shortens a CRD child)', () => {
    const m = prefixParentNames([n('tmpl', 'build'), n('wf', 'build-abc123')], [e('tmpl', 'wf', 'refers')])
    expect(m.get('wf')).toBe('build')
  })
  it('skips edges whose endpoints are not in the node set', () => {
    const m = prefixParentNames([n('po', 'api-7d9f-2xkp')], [e('missing', 'po')])
    expect(m.size).toBe(0)
  })
})

describe('cardStatus', () => {
  it('leaves a fitting status untouched', () => {
    expect(cardStatus('Running')).toBe('Running')
    expect(cardStatus('2/2')).toBe('2/2')
  })
  it('end-truncates a long status to the row width (keeps the meaningful head)', () => {
    // The bad cases that used to overflow: "Init:CrashLoopBackOff", "Ready,SchedulingDisabled",
    // "Pending:ContainerCreating". End-truncation keeps the leading reason for triage.
    const out = cardStatus('Init:CrashLoopBackOff exceeded threshold (15)')
    expect(out.length).toBeLessThan('Init:CrashLoopBackOff exceeded threshold (15)'.length)
    expect(out.startsWith('Init:Crash')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('cardTitle', () => {
  // A fixed clock so relativeAge is deterministic: the node was created 2 hours before `now`.
  const now = new Date('2026-01-01T12:00:00Z')
  const twoHoursAgo = '2026-01-01T10:00:00Z'

  it('puts kind+full name first, then status, then the age/host/restarts meta line', () => {
    const n = { kind: 'Pod', name: 'web-0', status: 'Running', createdAt: twoHoursAgo, host: 'node-1', restarts: 3 } as KNode
    expect(cardTitle(n, now)).toBe('Pod web-0\nRunning\n2h old · on node-1 · ↻ 3 restarts')
  })

  it('surfaces the failure reason between status and meta, so a hover triages without the drawer', () => {
    const n = { kind: 'Workflow', name: 'migrate-csqzg', status: 'Failed', message: 'migrate-dry-run: main: Error (exit code 1)', createdAt: twoHoursAgo } as KNode
    expect(cardTitle(n, now)).toBe('Workflow migrate-csqzg\nFailed\nmigrate-dry-run: main: Error (exit code 1)\n2h old')
  })

  it('omits the message line for a healthy node (server leaves it empty)', () => {
    const n = { kind: 'Pod', name: 'web-0', status: 'Running', createdAt: twoHoursAgo } as KNode
    expect(cardTitle(n, now)).toBe('Pod web-0\nRunning\n2h old')
  })

  it('omits absent facts — no status line, no meta when the node carries none', () => {
    const n = { kind: 'Service', name: 'api' } as KNode
    expect(cardTitle(n, now)).toBe('Service api')
  })

  it('drops the restarts clause when restarts is 0 or missing', () => {
    const n = { kind: 'Pod', name: 'web-0', createdAt: twoHoursAgo, restarts: 0 } as KNode
    expect(cardTitle(n, now)).toBe('Pod web-0\n2h old')
  })
})

describe('selectionLabel', () => {
  it('speaks kind+name, status, and failure reason for a degraded selection', () => {
    const n = { kind: 'Workflow', name: 'migrate-csqzg', status: 'Failed', message: 'migrate-dry-run: main: Error (exit code 1)' } as KNode
    expect(selectionLabel(n)).toBe('Selected Workflow migrate-csqzg, Failed, migrate-dry-run: main: Error (exit code 1)')
  })
  it('stays terse for a healthy selection (no message clause)', () => {
    expect(selectionLabel({ kind: 'Service', name: 'api', status: 'ClusterIP' } as KNode)).toBe('Selected Service api, ClusterIP')
    expect(selectionLabel({ kind: 'Pod', name: 'web-0' } as KNode)).toBe('Selected Pod web-0')
  })
  it('is empty when nothing is selected, so the live region stays silent', () => {
    expect(selectionLabel(null)).toBe('')
    expect(selectionLabel(undefined)).toBe('')
  })
})

describe('pluralizeKind', () => {
  it('appends s for the common case', () => {
    expect(pluralizeKind('Workflow', 3)).toBe('Workflows')
    expect(pluralizeKind('Pod', 2)).toBe('Pods')
  })
  it('leaves an already-plural Kind ending in s unchanged (no "Endpointss")', () => {
    expect(pluralizeKind('Endpoints', 8)).toBe('Endpoints')
  })
  it('turns consonant+y into ies (NetworkPolicy → NetworkPolicies)', () => {
    expect(pluralizeKind('NetworkPolicy', 4)).toBe('NetworkPolicies')
  })
  it('returns the singular Kind unchanged when n === 1', () => {
    expect(pluralizeKind('Workflow', 1)).toBe('Workflow')
    expect(pluralizeKind('Endpoints', 1)).toBe('Endpoints')
  })
})
