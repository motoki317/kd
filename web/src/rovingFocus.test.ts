import { describe, expect, it } from 'vitest'
import { nextRovingIndex } from './rovingFocus'

describe('nextRovingIndex', () => {
  it('moves forward with Right/Down and wraps past the end', () => {
    expect(nextRovingIndex('ArrowRight', 0, 3)).toBe(1)
    expect(nextRovingIndex('ArrowDown', 1, 3)).toBe(2)
    expect(nextRovingIndex('ArrowRight', 2, 3)).toBe(0) // wrap
  })

  it('moves backward with Left/Up and wraps before the start', () => {
    expect(nextRovingIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(nextRovingIndex('ArrowUp', 1, 3)).toBe(0)
    expect(nextRovingIndex('ArrowLeft', 0, 3)).toBe(2) // wrap
  })

  it('Home/End jump to the ends', () => {
    expect(nextRovingIndex('Home', 2, 3)).toBe(0)
    expect(nextRovingIndex('End', 0, 3)).toBe(2)
  })

  it('returns null for keys it does not handle, so the caller leaves the event alone', () => {
    expect(nextRovingIndex('Enter', 0, 3)).toBeNull()
    expect(nextRovingIndex('a', 0, 3)).toBeNull()
    expect(nextRovingIndex('Tab', 0, 3)).toBeNull()
  })

  it('guards a degenerate widget (empty, or a current index out of range)', () => {
    expect(nextRovingIndex('ArrowRight', 0, 0)).toBeNull()
    expect(nextRovingIndex('ArrowRight', -1, 3)).toBeNull()
  })
})
