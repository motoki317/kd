// Shared toggle/solo semantics for the canvas's multi-select filters (relationship chips, kind
// chips). Both filters are a Set the operator builds by clicking chips; Shift "solos". Extracted so
// the two call sites can't drift on the one subtle edge case below.
//
// `solo` isolates ONE item (clearing the rest) — EXCEPT when the filter is already exactly that one
// item, where a second solo clears to empty. That empty result is deliberate: it doubles as a quick
// "clear every chip" gesture, and an empty filter is itself a valid, meaningful state (e.g. "draw no
// relationships"), not the default to restore to.
export function toggleInSet<T>(current: ReadonlySet<T>, item: T, solo: boolean): Set<T> {
  if (solo) {
    if (current.size === 1 && current.has(item)) return new Set<T>()
    return new Set<T>([item])
  }
  const next = new Set(current)
  next.has(item) ? next.delete(item) : next.add(item)
  return next
}
