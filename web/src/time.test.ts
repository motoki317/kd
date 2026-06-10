import { describe, expect, it } from 'vitest'
import { relativeAge, relativeUntil } from './time'

describe('relativeAge', () => {
  const now = new Date('2026-05-27T12:00:00Z')
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString()

  it('formats seconds, minutes, hours, days as a single compact unit', () => {
    expect(relativeAge(ago(5), now)).toBe('5s')
    expect(relativeAge(ago(90), now)).toBe('1m') // floors to the largest whole unit
    expect(relativeAge(ago(50 * 60), now)).toBe('50m')
    expect(relativeAge(ago(3 * 3600), now)).toBe('3h')
    expect(relativeAge(ago(2 * 86400), now)).toBe('2d')
    expect(relativeAge(ago(364 * 86400), now)).toBe('364d') // still days just under a year
    expect(relativeAge(ago(365 * 86400), now)).toBe('1y')
    expect(relativeAge(ago(900 * 86400), now)).toBe('2y') // floors: 900/365 = 2.4 → "2y"
  })

  it('clamps the present and future to 0s, and rejects bad input', () => {
    expect(relativeAge(now.toISOString(), now)).toBe('0s')
    expect(relativeAge(ago(-30), now)).toBe('0s') // 30s in the future (clock skew)
    expect(relativeAge('not-a-date', now)).toBe('')
  })
})

describe('relativeUntil', () => {
  const now = new Date('2026-05-27T12:00:00Z')
  const ahead = (s: number) => new Date(now.getTime() + s * 1000).toISOString()

  it('formats a future timestamp on the same compact ladder', () => {
    expect(relativeUntil(ahead(3 * 3600), now)).toBe('3h')
    expect(relativeUntil(ahead(84 * 86400), now)).toBe('84d')
    expect(relativeUntil(ahead(400 * 86400), now)).toBe('1y')
  })

  it('clamps the present and past to 0s (the expired case is health-flagged, not negative)', () => {
    expect(relativeUntil(now.toISOString(), now)).toBe('0s')
    expect(relativeUntil(ahead(-3600), now)).toBe('0s')
    expect(relativeUntil('not-a-date', now)).toBe('')
  })
})
