import { describe, it, expect } from 'vitest'
import { boundingBox, selectionMaxScale, fitBox } from './viewport'

describe('boundingBox', () => {
  it('unions cards by their centre ± half-extent', () => {
    const bb = boundingBox([
      { x: 0, y: 0, width: 100, height: 40 }, // spans x[-50,50] y[-20,20]
      { x: 200, y: 100, width: 20, height: 20 }, // spans x[190,210] y[90,110]
    ])
    expect(bb).toEqual({ minX: -50, minY: -20, maxX: 210, maxY: 110, width: 260, height: 130 })
  })

  it('frames a single card to its own extent', () => {
    const bb = boundingBox([{ x: 100, y: 50, width: 200, height: 60 }])
    expect(bb.width).toBe(200)
    expect(bb.height).toBe(60)
  })
})

describe('selectionMaxScale', () => {
  it('zooms a small card in close but stays within [1.4, 2.5]', () => {
    expect(selectionMaxScale(220, 60)).toBeCloseTo(2.5, 5) // 1000/√13200 ≈ 8.7 → capped at 2.5
    const big = selectionMaxScale(4000, 3000) // large subtree → falls to the floor
    expect(big).toBe(1.4)
    // monotonic-ish: a bigger area never zooms in more than a smaller one.
    expect(selectionMaxScale(1000, 1000)).toBeGreaterThanOrEqual(selectionMaxScale(2000, 2000))
  })
})

describe('fitBox', () => {
  const view = { width: 1000, height: 800, topInset: 0 }

  it('centres the box in the viewport at the fitting scale', () => {
    // A 400×300 box with 60px padding fits at min((1000-120)/400, (800-120)/300, max) = min(2.2, 2.27, 3) = 2.2.
    const t = fitBox({ minX: 0, minY: 0, maxX: 400, maxY: 300 }, view, 3)
    expect(t.scale).toBeCloseTo(2.2, 5)
    // Box centre (200,150) lands at the viewport centre (500,400).
    expect(200 * t.scale + t.tx).toBeCloseTo(500, 5)
    expect(150 * t.scale + t.ty).toBeCloseTo(400, 5)
  })

  it('never exceeds maxScale (a tiny box does not zoom to absurdity)', () => {
    const t = fitBox({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, view, 1.4)
    expect(t.scale).toBe(1.4)
  })

  it('insets the framing area below the toolbar (topInset shifts the centre down)', () => {
    const inset = 120
    const t = fitBox({ minX: 0, minY: 0, maxX: 400, maxY: 300 }, { ...view, topInset: inset }, 3)
    // Vertical centre is now (topInset + availH/2) = 120 + (800-120)/2 = 460, not 400.
    expect(150 * t.scale + t.ty).toBeCloseTo(460, 5)
    // Horizontal centring is unaffected by the top inset.
    expect(200 * t.scale + t.tx).toBeCloseTo(500, 5)
  })

  it('guards a degenerate zero-size box against divide-by-zero', () => {
    const t = fitBox({ minX: 50, minY: 50, maxX: 50, maxY: 50 }, view, 2)
    expect(Number.isFinite(t.scale)).toBe(true)
    expect(t.scale).toBe(2) // clamped to maxScale, not Infinity
  })
})
