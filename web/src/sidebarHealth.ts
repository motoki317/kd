// The sidebar's live per-namespace health and the favicon attention badge, extracted from App.tsx
// together because they must derive from the SAME merged source — splitting them is how favicon and
// trouble badge once disagreed. The merge itself (poll + real-time SSE summaries) lives upstream in
// liveHealth.ts; this factory just reconciles its output into a row-stable store and paints the favicon.
// A factory: App calls it inside its component body so the effects run under its root.

import { createEffect, createMemo, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { CLUSTER_SCOPE, type NamespaceInfo } from './api'
import { faviconDataUrl, worstHealth } from './favicon'

export function createSidebarHealth(deps: {
  // The poll merged with the per-namespace live-summary cache (liveHealth.ts) — a single glitch-free
  // memo, so the reconcile effect below depends on ONE input. Earlier this factory did the merge from
  // four raw sources and an effect reading them directly intermittently latched a stale list across a
  // cluster switch (it ran on a connState change a beat before the resource value committed, then never
  // re-fired). Folding the merge into the upstream memo is what keeps the effect glitch-free.
  mergedNamespaces: Accessor<NamespaceInfo[]>
}) {
  const { mergedNamespaces } = deps
  // Hold the merged list in a RECONCILED store (keyed by name), not a plain memo: a memo rebuilt the
  // refreshed namespace as a fresh object on every update, so the Sidebar's <For> tore down and
  // recreated that row each tick (the namespace-list "flicker"). reconcile patches only the changed
  // row's health in place, so <For> keeps the DOM and the dot recolours surgically.
  const [sidebarNs, setSidebarNs] = createStore<NamespaceInfo[]>([])
  createEffect(() => setSidebarNs(reconcile(mergedNamespaces(), { key: 'name' })))

  // Per-namespace health across the WHOLE cluster, for the favicon attention badge. Counts over
  // sidebarNs — the /namespaces poll with the open namespace kept live from the SSE summary — the SAME
  // source the sidebar trouble badge reads, so favicon and badge never disagree. Excludes the
  // cluster-scope sentinel to match the badge (troubledNamespaces). NOT the open namespace's node set:
  // a tab-per-cluster operator parked on a healthy namespace must still see the favicon flag trouble in
  // ANOTHER namespace — the feature's whole premise (favicon.ts docstring), which the old view-scoped
  // count silently broke (clean favicon while three other namespaces were Degraded).
  const counts = createMemo(() => {
    const c: Record<string, number> = {}
    for (const n of sidebarNs) if (n.name !== CLUSTER_SCOPE) c[n.health] = (c[n.health] ?? 0) + 1
    return c
  })

  // Favicon attention badge (cycle 286): paint the worst non-Healthy state present in the cluster as a
  // colored dot on the brand mark, so multi-tab operators spot trouble without clicking into each tab.
  // Healthy/empty restores the plain mark. Updated via the existing <link rel="icon"> element rather
  // than injecting a new one, so the DOM stays clean across HMR reloads in dev.
  createEffect(() => {
    const worst = worstHealth(counts())
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = worst ? faviconDataUrl(worst) : '/favicon.svg'
  })

  return { sidebarNs }
}
