import { describe, expect, it } from 'vitest'
import { relativeAge } from './time'

describe('relativeAge', () => {
  const now = new Date('2026-05-27T12:00:00Z')
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString()

  it('formats seconds, minutes, hours, days as a single compact unit', () => {
    expect(relativeAge(ago(5), now)).toBe('5s')
    expect(relativeAge(ago(90), now)).toBe('1m') // floors to the largest whole unit
    expect(relativeAge(ago(50 * 60), now)).toBe('50m')
    expect(relativeAge(ago(3 * 3600), now)).toBe('3h')
    expect(relativeAge(ago(2 * 86400), now)).toBe('2d')
  })

  it('clamps the present and future to 0s, and rejects bad input', () => {
    expect(relativeAge(now.toISOString(), now)).toBe('0s')
    expect(relativeAge(ago(-30), now)).toBe('0s') // 30s in the future (clock skew)
    expect(relativeAge('not-a-date', now)).toBe('')
  })
})
