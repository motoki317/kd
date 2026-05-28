import { healthSeverity } from './health'
import { CLUSTER_SCOPE, type NamespaceInfo } from './api'

// compareNamespaces orders namespaces troubled-first (worst health, then most non-ready resources),
// breaking ties alphabetically — the order operators want, with what needs attention up top. Shared
// by the sidebar's display sort and the first-load default selection so the two agree.
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
