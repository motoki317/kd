// One app-wide "now" clock so relative ages tick live everywhere — the topology cards AND the detail
// drawer — off a SINGLE 30s interval rather than each view spinning its own (the drawer used to read
// `new Date()` once at render, so its "21m old" froze while the canvas kept aging). 30s is the
// resolution at which relativeAge's smallest shown unit can shift, cheaply.
import { createSignal } from 'solid-js'

const [now, setNow] = createSignal(new Date())
let timer: ReturnType<typeof setInterval> | undefined

// Start the ticker lazily on first read so a module import alone never opens an interval (keeps tests
// that don't render ages timer-free). It is intentionally never cleared — the clock lives for the whole
// app session, shared by every consumer; clearing it on one view's unmount would freeze the others.
function ensureTicking() {
  if (timer) return
  timer = setInterval(() => setNow(new Date()), 30_000)
}

// useNow returns the current shared clock value and subscribes the caller to the 30s tick, so any age
// derived from it re-renders in place. Call it inside a reactive scope (a memo/JSX), like any signal.
export function useNow(): Date {
  ensureTicking()
  return now()
}
