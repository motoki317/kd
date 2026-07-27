import { describe, it, expect } from 'vitest'
import { boundingBox, selectionMaxScale, fitBox, fitBoxFloored, clampPan, FIT_PADDING, zoomScaleBounds } from './viewport'

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

  it('applies breathing before centring an off-origin box', () => {
    const box = { minX: 1000, minY: 700, maxX: 1400, maxY: 1000 }
    const t = fitBox(box, view, 3, FIT_PADDING, 0.92)

    expect(t.scale).toBeCloseTo(2.2 * 0.92, 5)
    expect(1200 * t.scale + t.tx).toBeCloseTo(500, 5)
    expect(850 * t.scale + t.ty).toBeCloseTo(400, 5)
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

  it('keeps a large graph covering the viewport up to the fit margin', () => {
    const content = { width: 4000, height: 3000 } // bigger than the viewport
    // Panned far left/up: the content's far edge stays inside the viewport by the fit margin.
    const far = clampPan(-99999, -99999, content, view)
    expect(far.tx).toBe(1000 - 60 - 4000)
    expect(far.ty).toBe(800 - 60 - 3000)
    // Panned far right/down: the content's near edge stays inside the viewport by the fit margin.
    const near = clampPan(99999, 99999, content, view)
    expect(near.tx).toBe(60)
    expect(near.ty).toBe(60)
  })

  it('uses padded sorted endpoints for fitting content, toolbar insets, and the regime crossover', () => {
    const insetView = { ...view, topInset: 64 }

    expect(clampPan(-99999, -99999, { width: 400, height: 300 }, insetView)).toEqual({ tx: 60, ty: 124 })
    expect(clampPan(99999, 99999, { width: 400, height: 300 }, insetView)).toEqual({ tx: 540, ty: 440 })

    const cases = [
      { content: { width: 879, height: 615 }, lower: { tx: 60, ty: 124 }, upper: { tx: 61, ty: 125 } },
      { content: { width: 880, height: 616 }, lower: { tx: 60, ty: 124 }, upper: { tx: 60, ty: 124 } },
      { content: { width: 881, height: 617 }, lower: { tx: 59, ty: 123 }, upper: { tx: 60, ty: 124 } },
    ]
    for (const { content, lower, upper } of cases) {
      expect(clampPan(-99999, -99999, content, insetView)).toEqual(lower)
      expect(clampPan(99999, 99999, content, insetView)).toEqual(upper)
    }

    expect(FIT_PADDING).toBe(60)
  })

  it('keeps edge selection cards visible while bounding the composed fit to the layout', () => {
    const layout = { width: 2000, height: 1600 }
    const card = { width: 220, height: 60 }
    const centres = [
      { x: card.width / 2, y: card.height / 2 },
      { x: layout.width - card.width / 2, y: card.height / 2 },
      { x: card.width / 2, y: layout.height - card.height / 2 },
      { x: layout.width - card.width / 2, y: layout.height - card.height / 2 },
    ]

    for (const focus of centres) {
      const box = {
        minX: focus.x - card.width / 2,
        minY: focus.y - card.height / 2,
        maxX: focus.x + card.width / 2,
        maxY: focus.y + card.height / 2,
      }
      const fit = fitBoxFloored(box, { ...view, topInset: 0 }, {
        maxScale: 2.5,
        minScale: 0.55,
        focus,
      })
      const bounded = clampPan(
        fit.tx,
        fit.ty,
        { width: layout.width * fit.scale, height: layout.height * fit.scale },
        view,
      )

      expect(bounded.tx).toBeLessThanOrEqual(FIT_PADDING)
      expect(bounded.ty).toBeLessThanOrEqual(FIT_PADDING)
      expect(bounded.tx + layout.width * fit.scale).toBeGreaterThanOrEqual(view.width - FIT_PADDING)
      expect(bounded.ty + layout.height * fit.scale).toBeGreaterThanOrEqual(view.height - FIT_PADDING)
      expect(box.minX * fit.scale + bounded.tx).toBeGreaterThanOrEqual(FIT_PADDING)
      expect(box.maxX * fit.scale + bounded.tx).toBeLessThanOrEqual(view.width - FIT_PADDING)
      expect(box.minY * fit.scale + bounded.ty).toBeGreaterThanOrEqual(FIT_PADDING)
      expect(box.maxY * fit.scale + bounded.ty).toBeLessThanOrEqual(view.height - FIT_PADDING)
    }
  })

  it('keeps covered content within the vertical frame below an inset', () => {
    const insetView = { ...view, topInset: 64 }
    const content = { width: 400, height: 1000 }
    expect(clampPan(0, -99999, content, insetView, 0).ty).toBe(800 - 1000)
    expect(clampPan(0, 99999, content, insetView, 0).ty).toBe(64)
  })

  it('keeps fitting content fully inside the vertical frame below an inset', () => {
    const insetView = { ...view, topInset: 64 }
    const content = { width: 400, height: 300 }
    expect(clampPan(-99999, -99999, content, insetView, 0)).toEqual({ tx: 0, ty: 64 })
    expect(clampPan(99999, 99999, content, insetView, 0)).toEqual({ tx: 600, ty: 500 })
  })

  it('meets continuously at the toolbar-adjusted vertical frame height', () => {
    const insetView = { ...view, topInset: 64 }
    expect(clampPan(0, 99999, { width: 400, height: 736 }, insetView, 0).ty).toBe(64)
    expect(clampPan(0, 99999, { width: 400, height: 735 }, insetView, 0).ty).toBe(65)
  })

  it('does not apply the toolbar inset to horizontal threshold or bounds', () => {
    const insetView = { ...view, topInset: 64 }
    const content = { width: 950, height: 300 }
    expect(clampPan(-99999, 0, content, insetView, 0).tx).toBe(0)
    expect(clampPan(99999, 0, content, insetView, 0).tx).toBe(1000 - 950)
  })

  it('defaults an omitted toolbar inset to zero', () => {
    const content = { width: 4000, height: 3000 }
    expect(clampPan(99999, 99999, content, view, 0)).toEqual(
      clampPan(99999, 99999, content, { ...view, topInset: 0 }, 0),
    )
  })

  it('keeps a graph smaller than the viewport fully inside both axes', () => {
    const content = { width: 400, height: 300 }
    expect(clampPan(-99999, -99999, content, view, 0)).toEqual({ tx: 0, ty: 0 })
    expect(clampPan(99999, 99999, content, view, 0)).toEqual({ tx: 1000 - 400, ty: 800 - 300 })
  })

  it('chooses covered and keep-inside bounds independently per axis', () => {
    const content = { width: 4000, height: 300 }
    expect(clampPan(-99999, -99999, content, view, 0)).toEqual({ tx: 1000 - 4000, ty: 0 })
    expect(clampPan(99999, 99999, content, view, 0)).toEqual({ tx: 0, ty: 800 - 300 })
  })

  it('switches to covered bounds at exact viewport equality', () => {
    const equal = clampPan(500, -500, { width: 1000, height: 800 }, view, 0)
    expect(equal).toEqual({ tx: 0, ty: 0 })

    const oneShort = clampPan(-99999, 99999, { width: 999, height: 799 }, view, 0)
    expect(oneShort).toEqual({ tx: 0, ty: 1 })
  })

  it('moves both endpoint pairs continuously through frame equality', () => {
    const insetView = { ...view, topInset: 64 }
    const cases = [
      { content: { width: 999, height: 735 }, lower: { tx: 0, ty: 64 }, upper: { tx: 1, ty: 65 } },
      { content: { width: 1000, height: 736 }, lower: { tx: 0, ty: 64 }, upper: { tx: 0, ty: 64 } },
      { content: { width: 1001, height: 737 }, lower: { tx: -1, ty: 63 }, upper: { tx: 0, ty: 64 } },
    ]

    for (const { content, lower, upper } of cases) {
      expect(clampPan(-99999, -99999, content, insetView, 0)).toEqual(lower)
      expect(clampPan(99999, 99999, content, insetView, 0)).toEqual(upper)
    }
  })

  it('passes a within-bounds pan through unchanged', () => {
    const content = { width: 4000, height: 3000 }
    expect(clampPan(-200, -150, content, view, 0)).toEqual({ tx: -200, ty: -150 })
  })
})

describe('zoomScaleBounds', () => {
  it('uses whole-layout fit for the minimum and the 3x cap for the maximum', () => {
    expect(zoomScaleBounds(
      { width: 2000, height: 1000 },
      { width: 220, height: 60 },
      { width: 1000, height: 800, topInset: 0 },
    )).toEqual({ min: 0.44, max: 3 })
  })

  it('collapses the maximum to the minimum when a tiny viewport makes them cross', () => {
    expect(zoomScaleBounds(
      { width: 10, height: 10 },
      { width: 220, height: 60 },
      { width: 150, height: 150, topInset: 0 },
    )).toEqual({ min: 1, max: 1 })
  })

  it('caps the minimum at natural size and lets one-card fit bind the maximum', () => {
    const bounds = zoomScaleBounds(
      { width: 100, height: 100 },
      { width: 220, height: 60 },
      { width: 500, height: 400, topInset: 0 },
    )
    expect(bounds.min).toBe(1)
    expect(bounds.max).toBeCloseTo(380 / 220, 8)
  })

  it('uses the view below the toolbar for both fitted bounds', () => {
    const layout = { width: 1000, height: 1000 }
    const card = { width: 220, height: 60 }

    expect(zoomScaleBounds(layout, card, { width: 1000, height: 300, topInset: 0 }))
      .toEqual({ min: 0.18, max: 3 })
    expect(zoomScaleBounds(layout, card, { width: 1000, height: 300, topInset: 60 }))
      .toEqual({ min: 0.12, max: 2 })
  })

  it.each([0, 100, 120])('keeps bounds positive through a transient %ipx-wide view', (width) => {
    const bounds = zoomScaleBounds(
      { width: 1000, height: 1000 },
      { width: 220, height: 60 },
      { width, height: 800, topInset: 0 },
    )

    expect(bounds.min).toBeCloseTo(1 / 1000, 8)
    expect(bounds.max).toBeCloseTo(1 / 220, 8)
  })
})
