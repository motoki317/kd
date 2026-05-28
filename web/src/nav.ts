import { healthSeverity } from './health'
import { nodeMatches } from './search'
import type { Health, KNode } from './types'

// resolveSelectionOnSnapshot decides what is selected when a fresh graph snapshot arrives (a
// namespace/view switch, or first load). It keeps the current selection if its node is still present
// — so switching views holds focus on the same resource — else adopts a URL-seeded "Kind/name"
// deep-link once that node is present, else selects nothing. Returns whether the deep-link was
// consumed so the caller can stop trying to restore it. The caller resolves this from the snapshot's
// own node list before mutating its store, so the result is authoritative over any reactive restore.
export function resolveSelectionOnSnapshot(
  nodes: KNode[],
  keepId: string | null,
  pendingSel: string | null,
): { id: string | null; consumedPending: boolean } {
  if (keepId && nodes.some((n) => n.id === keepId)) return { id: keepId, consumedPending: false }
  if (pendingSel) {
    const match = nodes.find((n) => `${n.kind}/${n.name}` === pendingSel)
    if (match) return { id: match.id, consumedPending: true }
  }
  return { id: null, consumedPending: false }
}

// navCandidates is the set keyboard stepping (j/k) walks through. When ANY filter is active,
// navigation is scoped to what's spotlighted — so "filter to Degraded, then step" visits only the
// degraded nodes — matching the topology's compose-all-filters fade. With no filter, every node
// is a candidate. Kinds compose with the others (cycle 215: keyboard nav was previously ignoring
// the kind filter, which let j/k drift off the spotlighted set).
export function navCandidates(
  nodes: KNode[],
  search: string,
  healthFilter: Health | null,
  kindFilter: Set<string> | null = null,
): KNode[] {
  const q = search.trim()
  const matchesAll = (n: KNode) =>
    (!q || nodeMatches(n, q)) &&
    (!healthFilter || n.health === healthFilter) &&
    (!kindFilter || kindFilter.size === 0 || kindFilter.has(n.kind))
  return nodes.filter(matchesAll)
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
