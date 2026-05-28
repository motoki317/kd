import { describe, expect, it } from 'vitest'
import { cardName, cardStatus, kindLabel, middleTruncate, relativeName } from './names'

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
  it('strips the owner prefix and leaves a fitting name intact', () => {
    expect(cardName('api-7d9f-2xkp', 'api-7d9f')).toBe('2xkp')
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
