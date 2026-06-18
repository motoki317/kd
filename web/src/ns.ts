import { healthSeverity } from './health'
import { CLUSTER_SCOPE, type NamespaceInfo } from './api'
import type { Health } from './types'

// namespaceLabel maps a namespace name to what the operator should SEE — the cluster pseudo-namespace's
// internal sentinel (`__cluster__`, a URL/wire detail) is never user-facing and renders as `[cluster]`
// everywhere it's shown (breadcrumb, document title, …). Centralized so the sentinel can't leak raw into
// one surface while another prettifies it (the breadcrumb did exactly that before this existed).
export function namespaceLabel(ns: string): string {
  return ns === CLUSTER_SCOPE ? '[cluster]' : ns
}

// compareNamespaces orders namespaces troubled-first (worst health, then most non-ready resources),
// breaking ties alphabetically. The sidebar LIST is plain alphabetical now (a stable row order the
// operator can aim at), so this is used only to pick the first-load default selection — landing the
// operator on the most attention-worthy namespace via mostTroubled() without reordering the list.
export function compareNamespaces(a: NamespaceInfo, b: NamespaceInfo): number {
  return (
    healthSeverity[b.health] - healthSeverity[a.health] ||
    (b.nonReady ?? 0) - (a.nonReady ?? 0) ||
    a.name.localeCompare(b.name)
  )
}

// mostTroubled returns the namespace an operator most likely wants to land on (the top of the
// troubled-first order), or undefined for an empty list. The cluster pseudo-namespace is
// excluded — it's a separate jump target the operator selects deliberately, and landing
// there by default would be jarring on a fresh load with a healthy cluster scope.
export function mostTroubled(list: NamespaceInfo[]): NamespaceInfo | undefined {
  const eligible = list.filter((n) => n.name !== CLUSTER_SCOPE)
  return eligible.length ? [...eligible].sort(compareNamespaces)[0] : undefined
}

// troubledNamespaces is the troubled-first ordered set of namespaces that actually need attention —
// Degraded or Progressing, the SAME threshold the sidebar's trouble badge counts (Unknown/Suspended
// are non-actionable noise, excluded there and here so the badge count and the jump set never
// disagree). The cluster pseudo-namespace is excluded like everywhere else.
export function troubledNamespaces(list: NamespaceInfo[]): NamespaceInfo[] {
  return list
    .filter((n) => n.name !== CLUSTER_SCOPE && healthSeverity[n.health] >= healthSeverity.Progressing)
    .sort(compareNamespaces)
}

// LiveHealth is one namespace's last real-time SSE summary, tagged with the context it was streamed
// from and the poll generation it arrived in (see mergeNamespaceHealth for how both tags gate it).
export interface LiveHealth {
  health: Health
  nonReady?: number
  gen: number
  ctx: string
}

// mergeNamespaceHealth overlays the real-time SSE summary cache onto the 15s /namespaces poll so each
// sidebar row shows its freshest KNOWN health without flapping as the operator navigates. The two
// inputs are the SAME server computation at different times: the poll (≤15s stale, every namespace)
// and the live cache (real-time, only namespaces whose stream the operator has opened). A cached entry
// wins only when (a) it belongs to the current context — so one cluster's health never bleeds into a
// same-named namespace of another — and (b) no newer poll has superseded it, i.e. its generation is
// still the current one. Generations are monotonic, so `gen >= pollGen` reads as "not yet superseded":
// navigating away does NOT bump the generation (the entry holds → no revert-to-stale flap), while the
// next genuine poll advances it (the namespace self-corrects within the poll interval, never showing a
// value older than the poll would). Pure so the rule is unit-tested independently of the reactive cache.
export function mergeNamespaceHealth(
  list: NamespaceInfo[],
  liveByNs: Record<string, LiveHealth>,
  pollGen: number,
  currentCtx: string | null,
): NamespaceInfo[] {
  return list.map((n) => {
    const live = liveByNs[n.name]
    return live && live.ctx === currentCtx && live.gen >= pollGen
      ? { ...n, health: live.health, nonReady: live.nonReady }
      : n
  })
}

// nextTroubled steps through the troubled set from the current selection: the first jump (current
// isn't troubled, or isn't selected) lands on the worst, and each repeat advances to the next-worst,
// wrapping at the end. This makes the trouble badge a triage CYCLE — reach all N troubled
// namespaces with repeated presses — instead of re-landing on the single worst every time (which left
// the other N−1 to be hunted by eye in the A→Z list). Returns undefined when nothing is troubled.
export function nextTroubled(list: NamespaceInfo[], currentName: string | null): NamespaceInfo | undefined {
  const troubled = troubledNamespaces(list)
  if (troubled.length === 0) return undefined
  const idx = troubled.findIndex((n) => n.name === currentName)
  return troubled[(idx + 1) % troubled.length] // idx < 0 → worst; else the next, wrapping
}
