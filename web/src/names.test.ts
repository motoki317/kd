import { afterEach, describe, expect, it } from 'vitest'
import { cardKindLabel, cardName, cardStatus, kindLabel, kindShortLabel, middleTruncate, relativeName, setServerShortNames } from './names'

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

describe('kindLabel', () => {
  it('abbreviates verbose kinds that would overflow the node header', () => {
    expect(kindLabel('PersistentVolumeClaim')).toBe('PVC')
  })
  it('leaves kinds that already fit unchanged', () => {
    expect(kindLabel('Deployment')).toBe('Deployment')
    expect(kindLabel('Pod')).toBe('Pod')
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
    // After cycle 126 the name has its own row, no badge competing — full CARD_NAME_MAX is used.
    const long = 'kube-scheduler-docker-desktop'
    const out = cardName(long, undefined)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('…')
    expect(out.startsWith('kube')).toBe(true)
    expect(out.endsWith('desktop')).toBe(true)
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
