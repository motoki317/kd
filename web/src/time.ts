// Compact, kubectl-style relative age for a timestamp, e.g. "5s", "3m", "2h", "4d", "2y". Used for
// event last-seen and resource age columns. Returns "0s" for the present or a future time (clock
// skew). Like the rest of the ladder, the year rung floors to a single unit ("1y" for anything 1–2
// years) — simpler than kubectl's "1y45d", but long-lived resources (bootstrap PVs/Secrets) read far
// better as "2y" than the "730d" the ladder produced before it reached years.
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y`
}

// relativeAge's mirror for FUTURE timestamps (a Certificate's expiry): "84d", "3h". Returns "0s"
// for the present or a past time — callers pair it with a health signal for the already-expired
// case rather than rendering a negative duration.
export function relativeUntil(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // Same ladder, opposite direction: reuse relativeAge with the endpoints swapped.
  return relativeAge(now.toISOString(), new Date(then))
}
