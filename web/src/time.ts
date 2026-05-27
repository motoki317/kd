// Compact, kubectl-style relative age for a timestamp, e.g. "5s", "3m", "2h", "4d". Used for event
// last-seen and resource age columns. Returns "0s" for the present or a future time (clock skew).
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((now.getTime() - then) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
