import { kindAliases, kindLabel } from './names'
import type { KNode } from './types'

// nodeMatches reports whether a node should stay lit for the given query. Matches anything an
// operator might use to locate a resource: what it's called (name), what it is (kind, plus the
// shown short label like "PVC"), where it lives (host, cluster/external IP), how it's tagged
// (labels), what it runs (images), and its current state (status — so "CrashLoopBackOff" spotlights
// every troubled pod). Case-insensitive substring match; callers pass the query pre-trimmed.
//
// Round-trip with the Kind/name copy gestures (cycle 287 Shift+click, cycle 288 'y'): when the
// query contains a single "/" and both halves are non-empty, treat it as a structured
// "Kind/name" predicate — left = kind substring, right = name substring (both case-insensitive).
// So pasting "Pod/web-abc" jumps straight to that resource without lighting up every other Pod or
// every other "web-*" resource. Plain substring still wins when the query has no slash or one of
// the halves is empty.
export function nodeMatches(n: KNode, query: string): boolean {
  const q = query.toLowerCase()
  if (!q) return false
  const slash = q.indexOf('/')
  // Exactly one slash → structured "Kind/name" predicate. Both halves are treated as substring
  // filters scoped to their respective field; an empty half is interpreted as "don't constrain
  // this side" so typing "Pod/" mid-edit still lights up Pods (rather than going blank). A second
  // slash means the query isn't structured (label values can contain '/').
  if (slash >= 0 && q.indexOf('/', slash + 1) === -1) {
    const kindQ = q.slice(0, slash)
    const nameQ = q.slice(slash + 1)
    if (!kindQ && !nameQ) return false // bare "/" — nothing to match on
    const kindOk =
      !kindQ ||
      n.kind.toLowerCase().includes(kindQ) ||
      kindLabel(n.kind).toLowerCase().includes(kindQ) ||
      kindAliases(n.kind).some((a) => a.includes(kindQ))
    const nameOk = !nameQ || n.name.toLowerCase().includes(nameQ)
    if (kindOk && nameOk) return true
    return false
  }
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
