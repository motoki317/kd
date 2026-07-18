import { describe, it, expect } from 'vitest'
import { boundingBox, selectionMaxScale, fitBox, fitBoxFloored, clampPan } from './viewport'

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

describe('fitBoxFloored', () => {
  const view = { width: 1000, height: 800, topInset: 0 }
  const FLOOR = 0.55

  it('fits to the width and centres a box that fits in both axes', () => {
    // A 400×300 box: widthFit = (1000-120)/400 = 2.2 (cap 3). Content 300×2.2=660 ≤ 680, fits → centred.
    const t = fitBoxFloored({ minX: 0, minY: 0, maxX: 400, maxY: 300 }, view, {
      maxScale: 3,
      minScale: FLOOR,
      focus: { x: 0, y: 0 },
    })
    expect(t.scale).toBeCloseTo(2.2, 5)
    expect(200 * t.scale + t.tx).toBeCloseTo(500, 5) // box centre → viewport centre
    expect(150 * t.scale + t.ty).toBeCloseTo(400, 5)
  })

  it('width-primary: a tall tree fills the width and overflows vertically (NOT shrunk to fit height)', () => {
    // 400 wide × 2000 tall. The height-fit would be (800-120)/2000 = 0.34 — the old min() fit would
    // have used that, an unreadable shrink. Width-primary instead uses widthFit = 2.2 capped at the
    // 1.4 maxScale, so the tree renders large and overflows vertically, top-anchored (focus top-left).
    const box = { minX: 0, minY: 0, maxX: 400, maxY: 2000 }
    const t = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus: { x: 0, y: 0 } })
    expect(t.scale).toBe(1.4) // capped, far above the 0.34 a height-fit would give
    const contentW = 400 * 1.4
    expect(t.tx).toBeCloseTo((1000 - contentW) / 2, 5) // width fits → centred horizontally
    expect(t.ty).toBeCloseTo(60, 5) // height overflows → top-anchored at padding
  })

  it('applies the breathing factor while still centring', () => {
    const t = fitBoxFloored({ minX: 0, minY: 0, maxX: 400, maxY: 300 }, view, {
      maxScale: 3,
      minScale: FLOOR,
      focus: { x: 0, y: 0 },
      breathing: 0.92,
    })
    expect(t.scale).toBeCloseTo(2.2 * 0.92, 5)
    expect(200 * t.scale + t.tx).toBeCloseTo(500, 5)
  })

  it('pins to the floor and anchors a too-large fit-all to the top-left', () => {
    // A 5000×4000 box would fit at ~0.18 (1000-120)/5000 — far below the floor. With focus at the
    // box's top-left corner, both axes overflow, so each anchors content to its near edge (padding).
    const box = { minX: 0, minY: 0, maxX: 5000, maxY: 4000 }
    const t = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus: { x: 0, y: 0 } })
    expect(t.scale).toBe(FLOOR)
    expect(t.tx).toBeCloseTo(60, 5) // content left edge at padding
    expect(t.ty).toBeCloseTo(60, 5) // content top edge at padding (topInset 0)
  })

  it('floored: centres an axis whose content fits even when the other overflows', () => {
    // 5000 wide (overflows at the floor) × 100 tall (fits). The tall axis centres; the wide axis
    // anchors/clamps to the focus.
    const box = { minX: 0, minY: 0, maxX: 5000, maxY: 100 }
    const t = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus: { x: 0, y: 0 } })
    expect(t.scale).toBe(FLOOR)
    const contentH = 100 * FLOOR
    expect(t.ty).toBeCloseTo((800 - contentH) / 2, 5) // vertical centred
    expect(t.tx).toBeCloseTo(60, 5) // horizontal anchored top-left
  })

  it('floored: centres on the focus point and keeps the content covering the frame', () => {
    // Big box, focus near the middle → the focus lands at the viewport centre (clamp does not bite,
    // since plenty of content surrounds it on every side).
    const box = { minX: 0, minY: 0, maxX: 5000, maxY: 4000 }
    const focus = { x: 2500, y: 2000 }
    const t = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus })
    expect(t.scale).toBe(FLOOR)
    expect(2500 * t.scale + t.tx).toBeCloseTo(500, 5) // focus x at viewport centre
    expect(2000 * t.scale + t.ty).toBeCloseTo(400, 5) // focus y at viewport centre
  })

  it('floored: a focus near an edge clamps so no empty gutter shows past the content', () => {
    // Focus at the box's left/top edge would centre the edge, exposing empty space to its left. The
    // clamp pulls the content's near edge to the frame padding instead.
    const box = { minX: 0, minY: 0, maxX: 5000, maxY: 4000 }
    const t = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus: { x: 0, y: 0 } })
    expect(t.tx).toBeCloseTo(60, 5)
    expect(t.ty).toBeCloseTo(60, 5)
    // The far-edge focus mirrors it: content's far edge sits at the frame's far padding.
    const far = fitBoxFloored(box, view, { maxScale: 1.4, minScale: FLOOR, focus: { x: 5000, y: 4000 } })
    expect(5000 * far.scale + far.tx).toBeCloseTo(1000 - 60, 5)
    expect(4000 * far.scale + far.ty).toBeCloseTo(800 - 60, 5)
  })

  it('respects the toolbar inset when flooring', () => {
    const inset = 120
    const box = { minX: 0, minY: 0, maxX: 5000, maxY: 100 } // tall axis fits → centred below the bar
    const t = fitBoxFloored(box, { ...view, topInset: inset }, {
      maxScale: 1.4,
      minScale: FLOOR,
      focus: { x: 0, y: 0 },
    })
    const availH = 800 - inset
    const contentH = 100 * FLOOR
    expect(t.ty).toBeCloseTo(inset + (availH - contentH) / 2, 5)
  })
})

describe('clampPan', () => {
  const view = { width: 1000, height: 800 }

  it('keeps a large graph covering the viewport', () => {
    const content = { width: 4000, height: 3000 } // bigger than the viewport
    // Panned far left/up: the content's far edge stays at the viewport's far edge.
    const far = clampPan(-99999, -99999, content, view)
    expect(far.tx).toBe(1000 - 4000)
    expect(far.ty).toBe(800 - 3000)
    // Panned far right/down: the content's near edge stays at the viewport's near edge.
    const near = clampPan(99999, 99999, content, view)
    expect(near.tx).toBe(0)
    expect(near.ty).toBe(0)
  })

  it('keeps covered content within the vertical frame below an inset', () => {
    const insetView = { ...view, topInset: 64 }
    const content = { width: 400, height: 1000 }
    expect(clampPan(0, -99999, content, insetView).ty).toBe(800 - 1000)
    expect(clampPan(0, 99999, content, insetView).ty).toBe(64)
  })

  it('switches vertical coverage at the toolbar-adjusted viewport height', () => {
    const insetView = { ...view, topInset: 64 }
    expect(clampPan(0, 99999, { width: 400, height: 736 }, insetView).ty).toBe(64)
    expect(clampPan(0, 99999, { width: 400, height: 735 }, insetView).ty).toBe(800 - 60)
  })

  it('does not apply the toolbar inset to horizontal threshold or bounds', () => {
    const insetView = { ...view, topInset: 64 }
    const content = { width: 950, height: 300 }
    expect(clampPan(-99999, 0, content, insetView).tx).toBe(60 - 950)
    expect(clampPan(99999, 0, content, insetView).tx).toBe(1000 - 60)
  })

  it('defaults an omitted toolbar inset to zero', () => {
    const content = { width: 4000, height: 3000 }
    expect(clampPan(99999, 99999, content, view)).toEqual(
      clampPan(99999, 99999, content, { ...view, topInset: 0 }),
    )
  })

  it('keeps the 60 px visible bounds for a graph smaller than the viewport', () => {
    const content = { width: 400, height: 300 }
    expect(clampPan(-99999, -99999, content, view)).toEqual({ tx: 60 - 400, ty: 60 - 300 })
    expect(clampPan(99999, 99999, content, view)).toEqual({ tx: 1000 - 60, ty: 800 - 60 })
  })

  it('chooses covered and keep-visible bounds independently per axis', () => {
    const content = { width: 4000, height: 300 }
    expect(clampPan(-99999, -99999, content, view)).toEqual({ tx: 1000 - 4000, ty: 60 - 300 })
    expect(clampPan(99999, 99999, content, view)).toEqual({ tx: 0, ty: 800 - 60 })
  })

  it('switches to covered bounds at exact viewport equality', () => {
    const equal = clampPan(500, -500, { width: 1000, height: 800 }, view)
    expect(equal).toEqual({ tx: 0, ty: 0 })

    const oneShort = clampPan(-99999, 99999, { width: 999, height: 799 }, view)
    expect(oneShort).toEqual({ tx: 60 - 999, ty: 800 - 60 })
  })

  it('passes a within-bounds pan through unchanged', () => {
    const content = { width: 4000, height: 3000 }
    expect(clampPan(-200, -150, content, view)).toEqual({ tx: -200, ty: -150 })
  })
})
