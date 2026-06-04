// Shared keyboard model for roving-tabindex widgets — WAI-ARIA tabs and radiogroups both move
// selection/focus with the same arrow/Home/End logic. Centralising the index math keeps the drawer
// tablist and the toolbar's segmented controls consistent and lets the (easy to get wrong: wrap
// direction, off-by-one) computation be unit-tested once instead of re-derived per widget.

// nextRovingIndex returns the index to move to for a navigation key, or null when the key isn't one
// we handle (so the caller leaves the event alone). Arrows wrap; Home/End jump to the ends. Both
// orientations are accepted (←/↑ back, →/↓ forward) so one helper serves horizontal and vertical
// widgets.
export function nextRovingIndex(key: string, current: number, length: number): number | null {
  if (length <= 0 || current < 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % length
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + length) % length
    case 'Home':
      return 0
    case 'End':
      return length - 1
    default:
      return null
  }
}
