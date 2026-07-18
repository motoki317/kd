import { kindAliases } from './names'
import type { KNode } from './types'

// nodeMatches reports whether a node should stay lit for the given query. Matches anything an
// operator might use to locate a resource: what it's called (name), what it is (kind, plus short-name
// aliases like "pvc"/"svc"), where it lives (host, cluster/external IP), how it's tagged
// (labels), what it runs (images), and its current state (status — so "CrashLoopBackOff" spotlights
// every troubled pod). Case-insensitive substring match; callers pass the query pre-trimmed.
//
// A copied Kind/name round-trips into search: when the query contains a single "/" and both halves
// are non-empty, treat it as a structured
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
    // Kind side is matched by PREFIX, not substring: the operator typed a deliberate kind (a pasted
    // "Pod/…" or a canonical short like "po/…") and means THAT kind. Substring lit every kind merely
    // CONTAINING the text — "po/" matched Endpoints (end·po·ints), NetworkPolicy (network·po·licy),
    // PolicyEndpoint… A prefix is a strict subset (it never matches MORE), so the round-trip and the
    // short-name path keep working ("pod"/"po" still prefix Pod; "deploy" prefixes Deployment) while
    // the mid-word false hits drop out. (A "Po"-prefixed sibling like PodDisruptionBudget can still
    // match "po/" — acceptable; fully restricting it would need the server short-name map, absent on
    // first paint and in unit tests.)
    const kindOk =
      !kindQ ||
      n.kind.toLowerCase().startsWith(kindQ) ||
      kindAliases(n.kind).some((a) => a.startsWith(kindQ))
    const nameOk = !nameQ || n.name.toLowerCase().includes(nameQ)
    if (kindOk && nameOk) return true
    // The structured reading failing must not swallow the query: a single-slash string is just as
    // likely a label KEY ("app.kubernetes.io/managed-by" — the dominant label form) or an image
    // fragment ("team/app"), which the plain substring path below matches. Falling through is
    // strictly additive — a node must contain the LITERAL query (slash included), so "Pod/web-abc"
    // still cannot light every Pod the way a bare substring split would.
  }
  if (n.name.toLowerCase().includes(q)) return true
  if (n.kind.toLowerCase().includes(q)) return true
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
