import { healthSeverity } from './health'
import type { KNode } from './types'

// Stable ordering for keyboard navigation: most attention-worthy first (so stepping through the
// graph walks the problems before the healthy nodes), then kind, then name as tie-breakers.
export function orderedForNav(nodes: KNode[]): KNode[] {
  return [...nodes].sort((a, b) => {
    const s = healthSeverity[b.health] - healthSeverity[a.health]
    if (s !== 0) return s
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name)
  })
}

// nextSelection returns the node id to select when stepping by `dir` (+1 next, -1 previous) from
// the current selection. With nothing selected, forward lands on the first (most troubled) node and
// backward on the last, so the very first keypress is useful. Stepping wraps around the ends.
// Returns null only for an empty graph.
export function nextSelection(nodes: KNode[], currentId: string | null, dir: 1 | -1): string | null {
  const ordered = orderedForNav(nodes)
  if (ordered.length === 0) return null
  const idx = currentId ? ordered.findIndex((n) => n.id === currentId) : -1
  if (idx === -1) return dir === 1 ? ordered[0].id : ordered[ordered.length - 1].id
  return ordered[(idx + dir + ordered.length) % ordered.length].id
}
