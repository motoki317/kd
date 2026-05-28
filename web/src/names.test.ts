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
  it('reserves room on the name line for the restart badge, so the name truncates shorter', () => {
    const long = 'kube-scheduler-docker-desktop'
    const noBadge = cardName(long, undefined, 0)
    const withBadge = cardName(long, undefined, 12)
    // A restart badge (↻12) shares the name line, so the name must give up width to it.
    expect(withBadge.length).toBeLessThan(noBadge.length)
  })
  it('reserves more room for a wider badge (more restart digits)', () => {
    const long = 'kube-scheduler-docker-desktop'
    expect(cardName(long, undefined, 5).length).toBeGreaterThan(cardName(long, undefined, 12345).length)
  })
})

describe('cardStatus', () => {
  it('leaves a status that fits beside its kind untouched', () => {
    expect(cardStatus('Running', 'Pod')).toBe('Running')
    expect(cardStatus('2/2', 'Deployment')).toBe('2/2')
  })
  it('end-truncates a long status so it cannot overlap the kind (keeps the meaningful head)', () => {
    // A cordoned node: "NODE" + "Ready,SchedulingDisabled" used to collide.
    const out = cardStatus('Ready,SchedulingDisabled', 'Node')
    expect(out.length).toBeLessThan('Ready,SchedulingDisabled'.length)
    expect(out.startsWith('Ready,')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })
  it('leaves less room for the status when the kind is wider', () => {
    const status = 'rollout failed in progress now'
    expect(cardStatus(status, 'StatefulSet').length).toBeLessThan(cardStatus(status, 'Pod').length)
  })
})
