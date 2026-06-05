import { describe, expect, it } from 'vitest'
import { scrollEdges } from './scrollEdges'

describe('scrollEdges', () => {
  it('fits: no fade on either edge', () => {
    expect(scrollEdges(0, 500, 500)).toEqual({ l: false, r: false })
    expect(scrollEdges(0, 500, 980)).toEqual({ l: false, r: false }) // client wider than content
  })

  it('overflowing at the start: fade right only (more to scroll into)', () => {
    expect(scrollEdges(0, 1497, 980)).toEqual({ l: false, r: true })
  })

  it('overflowing at the end: fade left only (start is off-screen)', () => {
    // max scroll = 1497 - 980 = 517
    expect(scrollEdges(517, 1497, 980)).toEqual({ l: true, r: false })
  })

  it('overflowing in the middle: fade both edges', () => {
    expect(scrollEdges(250, 1497, 980)).toEqual({ l: true, r: true })
  })

  it('tolerates sub-pixel offsets at the extremes (no flicker)', () => {
    expect(scrollEdges(0.5, 1497, 980)).toEqual({ l: false, r: true }) // ~start
    expect(scrollEdges(516.5, 1497, 980)).toEqual({ l: true, r: false }) // ~end
  })
})
