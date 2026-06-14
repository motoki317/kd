// Pure viewport math for the topology canvas: how a set of laid-out cards maps to a pan/zoom that
// frames them. Extracted from Topology.tsx so the fit geometry is unit-testable in isolation — the
// component only adds the DOM reads (the live SVG rect + toolbar height) and the rAF-driven
// animation around these. (That separation matters because the animation itself can't be verified in
// a headless browser — see the dogfooding skill's rAF pitfall — so the math is pinned by unit tests.)

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface FitTransform {
  scale: number
  tx: number
  ty: number
}

// boundingBox spreads every card to its x±w/2, y±h/2 corners and takes the min/max — the union box
// the fit needs to frame. (Cards are positioned by their CENTRE, hence the ±half-extent.)
export function boundingBox(nodes: Box[]): Bounds {
  const xs = nodes.flatMap((n) => [n.x - n.width / 2, n.x + n.width / 2])
  const ys = nodes.flatMap((n) => [n.y - n.height / 2, n.y + n.height / 2])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}

// selectionMaxScale lets a small selection zoom in close while a big subtree stays moderate. A fixed
// cap under-zoomed a lone card (a 220×60 card could legitimately go to ~4× but a 1.6 cap left it lost
// in whitespace). The 1000/√area curve yields ~2.5 for a single card and tapers to the 1.4 floor as
// the framed area grows (big subtrees are viewport-limited below the cap anyway, so the floor never
// shrinks them).
export function selectionMaxScale(w: number, h: number): number {
  return Math.max(1.4, Math.min(2.5, 1000 / Math.sqrt(Math.max(1, w * h))))
}

// fitBox returns the scale + translate that frames `box` into a viewport, centred, with `padding` on
// each side and `maxScale` capping the zoom. The control bar overlays the top strip of the canvas, so
// the framing area is the viewport MINUS topInset at the top: the usable height shrinks and the
// vertical centre shifts down by topInset, otherwise the topmost cards land behind the bar.
export function fitBox(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  view: { width: number; height: number; topInset: number },
  maxScale: number,
  padding = 60,
): FitTransform {
  const availH = Math.max(1, view.height - view.topInset)
  const w = Math.max(1, box.maxX - box.minX)
  const h = Math.max(1, box.maxY - box.minY)
  const scale = Math.min((view.width - padding * 2) / w, Math.max(1, availH - padding * 2) / h, maxScale)
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  return { scale, tx: view.width / 2 - cx * scale, ty: view.topInset + availH / 2 - cy * scale }
}

// fitBoxFloored frames `box` driven by the canvas WIDTH, clamped to [minScale, maxScale]. Unlike
// fitBox (which takes the smaller of the width- and height-fit, so a tall tree shrinks to fit its
// height and the text turns to noise), this fits the WIDTH and lets a tall tree overflow vertically —
// the operator scrolls down for the tail. Desktop canvases are wider than tall and most topology trees
// are far taller than wide, so width-driven framing yields a much larger, readable scale on the common
// case. The floor still guards genuinely huge/wide graphs (below it labels fade); the cap stops a small
// tree zooming to absurdity.
//
// Positioning is per-axis: an axis whose content fits at the chosen scale is CENTRED; an axis that
// overflows pans so `focus` (a point in LAYOUT coords — the selected card's centre, or the box's
// top-left corner for a plain fit-all) sits at the viewport centre, clamped so the content keeps
// covering the frame (no empty gutter past the first/last card). So fit-all top-anchors a tall tree
// (start at the first resources, scroll down) while a selection keeps the selected card on-screen.
export function fitBoxFloored(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  view: { width: number; height: number; topInset: number },
  opts: {
    maxScale: number
    minScale: number
    focus: { x: number; y: number }
    breathing?: number
    padding?: number
  },
): FitTransform {
  const padding = opts.padding ?? 60
  const breathing = opts.breathing ?? 1
  const availH = Math.max(1, view.height - view.topInset)
  const w = Math.max(1, box.maxX - box.minX)
  // Width-primary scale: fit the width (× breathing for a little margin), cap at maxScale, floor at
  // minScale. Height deliberately does NOT enter the scale — a tall tree overflows instead of shrinking.
  const scale = Math.max(Math.min((view.width - padding * 2) / w, opts.maxScale) * breathing, opts.minScale)
  const place = (start: number, size: number, lo: number, hi: number, f: number) => {
    const content = (hi - lo) * scale
    if (content <= size - padding * 2) return start + (size - content) / 2 - lo * scale // fits axis → centre
    const centred = start + size / 2 - f * scale
    const lower = start + size - padding - hi * scale // content far edge at frame far edge
    const upper = start + padding - lo * scale // content near edge at frame near edge
    return Math.min(Math.max(centred, lower), upper)
  }
  return {
    scale,
    tx: place(0, view.width, box.minX, box.maxX, opts.focus.x),
    ty: place(view.topInset, availH, box.minY, box.maxY, opts.focus.y),
  }
}

// clampPan keeps at least `margin` px of the laid-out graph on-screen, so a pan can't fling the whole
// graph off the canvas. `content` is the graph size ALREADY multiplied by the current scale; `view`
// is the viewport. A graph smaller than the viewport is unaffected (the lower bound `margin - content`
// is then more negative than any reasonable pan, and the upper bound `view - margin` is past it).
export function clampPan(
  tx: number,
  ty: number,
  content: { width: number; height: number },
  view: { width: number; height: number },
  margin = 60,
): { tx: number; ty: number } {
  return {
    tx: Math.min(Math.max(tx, margin - content.width), view.width - margin),
    ty: Math.min(Math.max(ty, margin - content.height), view.height - margin),
  }
}
