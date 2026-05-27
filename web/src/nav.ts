import { healthSeverity } from './health'
import { nodeMatches } from './search'
import type { Health, KNode } from './types'

// navCandidates is the set keyboard stepping (j/k) walks through. When a search or health-legend
// filter is active, navigation is scoped to what's spotlighted — so "filter to Degraded, then step"
// visits only the degraded nodes — matching the topology's fade precedence (search > health filter).
// With no filter, every node is a candidate.
export function navCandidates(nodes: KNode[], search: string, healthFilter: Health | null): KNode[] {
  const q = search.trim()
  if (q) return nodes.filter((n) => nodeMatches(n, q))
  if (healthFilter) return nodes.filter((n) => n.health === healthFilter)
  return nodes
}

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
