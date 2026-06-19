// One app-wide "now" clock so relative ages tick live everywhere — the topology cards AND the detail
// drawer — off a SINGLE interval rather than each view spinning its own (the drawer used to read
// `new Date()` once at render, so its "21m old" froze while the canvas kept aging).
//
// Ticks every SECOND so a young resource's age ("10s" → "11s") advances visibly, not in 30s jumps.
// This stays cheap by construction: relativeAge's output is value-stable for anything ≥ 1 minute old
// (it shows "3m"/"2h"/"4d"), so for the overwhelming majority of cards the per-second recompute returns
// the SAME string and Solid's text diffing makes ZERO DOM mutation — only the few sub-minute resources
// actually repaint. And only age-deriving computations subscribe to the tick (the layout/edges/icons
// never read now()), so a second's work is a few hundred microsecond-cheap string formats, not a
// canvas re-render.
import { createSignal } from 'solid-js'

const [now, setNow] = createSignal(new Date())
let timer: ReturnType<typeof setInterval> | undefined

// Start the ticker lazily on first read so a module import alone never opens an interval (keeps tests
// that don't render ages timer-free). It is intentionally never cleared — the clock lives for the whole
// app session, shared by every consumer; clearing it on one view's unmount would freeze the others.
function ensureTicking() {
  if (timer) return
  timer = setInterval(() => setNow(new Date()), 1_000)
}

// useNow returns the current shared clock value and subscribes the caller to the 30s tick, so any age
// derived from it re-renders in place. Call it inside a reactive scope (a memo/JSX), like any signal.
export function useNow(): Date {
  ensureTicking()
  return now()
}
