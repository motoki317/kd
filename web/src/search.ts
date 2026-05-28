import { kindAliases, kindLabel } from './names'
import type { KNode } from './types'

// nodeMatches reports whether a node should stay lit for the given query. Matches anything an
// operator might use to locate a resource: what it's called (name), what it is (kind, plus the
// shown short label like "PVC"), where it lives (host, cluster/external IP), how it's tagged
// (labels), what it runs (images), and its current state (status — so "CrashLoopBackOff" spotlights
// every troubled pod). Case-insensitive substring match; callers pass the query pre-trimmed.
export function nodeMatches(n: KNode, query: string): boolean {
  const q = query.toLowerCase()
  if (!q) return false
  if (n.name.toLowerCase().includes(q)) return true
  if (n.kind.toLowerCase().includes(q)) return true
  if (kindLabel(n.kind).toLowerCase().includes(q)) return true
  if (kindAliases(n.kind).some((a) => a.includes(q))) return true
  if (n.status?.toLowerCase().includes(q)) return true
  if (n.host?.toLowerCase().includes(q)) return true
  if (n.clusterIP?.toLowerCase().includes(q)) return true
  if (n.externalIP?.toLowerCase().includes(q)) return true
  if (n.images?.some((img) => img.toLowerCase().includes(q))) return true
  if (n.labels) {
    for (const [k, v] of Object.entries(n.labels)) {
      if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true
    }
  }
  return false
}
