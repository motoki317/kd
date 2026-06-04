import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPref, readRawPref, writePref } from './prefs'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('prefs', () => {
  it('readPref returns the stored value only when it is allowed, else the fallback', () => {
    localStorage.setItem('kd:x', 'b')
    expect(readPref('kd:x', 'a', ['a', 'b', 'c'])).toBe('b')
    // A stale/corrupt value not in the allow-list can never poison the signal.
    localStorage.setItem('kd:x', 'legacy')
    expect(readPref('kd:x', 'a', ['a', 'b', 'c'])).toBe('a')
    // Missing key → fallback.
    expect(readPref('kd:missing', 'a', ['a', 'b'])).toBe('a')
  })

  it('readRawPref returns the raw string or null without validating', () => {
    localStorage.setItem('kd:raw', 'anything,goes')
    expect(readRawPref('kd:raw')).toBe('anything,goes')
    expect(readRawPref('kd:none')).toBeNull()
  })

  it('writePref persists a value that readRawPref reads back', () => {
    writePref('kd:w', 'v')
    expect(readRawPref('kd:w')).toBe('v')
  })

  it('survives storage that throws (private mode / disabled) without propagating', () => {
    // Safari private mode exposes localStorage but throws on access — must not crash the caller.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied')
    })
    expect(() => writePref('kd:w', 'v')).not.toThrow()
    expect(readRawPref('kd:w')).toBeNull()
    expect(readPref('kd:w', 'fallback', ['fallback', 'v'])).toBe('fallback')
  })
})
