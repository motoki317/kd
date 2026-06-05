// Which edges of a horizontally-scrollable row still have content beyond them — drives the fade cues
// on an overflowing single-line row (the toolbar Kinds filter) so a hard truncation reads as "more
// this way" instead of "that's all there is". Pure so it's unit-testable without a real layout (jsdom
// reports 0 for scroll metrics, so the live fade is verified in-browser; this covers the math).
export interface ScrollEdges {
  l: boolean // content hidden to the LEFT (scrolled right of start)
  r: boolean // content hidden to the RIGHT (not yet scrolled to the end)
}

// EPS absorbs sub-pixel scroll offsets (fractional scrollLeft / DPR rounding) so a row sitting at a
// natural end doesn't flicker its fade on and off.
const EPS = 1

export function scrollEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): ScrollEdges {
  const overflow = scrollWidth - clientWidth
  if (overflow <= EPS) return { l: false, r: false } // fits — no fade either side
  return { l: scrollLeft > EPS, r: scrollLeft < overflow - EPS }
}
