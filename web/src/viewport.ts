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
