// The sidebar's live per-namespace health and the favicon attention badge, extracted from App.tsx
// together because they must derive from the SAME merged source (the /namespaces poll with the open
// namespace kept live from the SSE summary) — splitting them is how favicon and trouble badge once
// disagreed. A factory: App calls it inside its component body so the effects run under its root.

import { createEffect, createMemo, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { CLUSTER_SCOPE, type NamespaceInfo, type NamespaceSummary } from './api'
import { faviconDataUrl, worstHealth } from './favicon'

export function createSidebarHealth(deps: {
  namespaceList: Accessor<NamespaceInfo[]>
  namespace: Accessor<string | null>
  liveSummary: Accessor<NamespaceSummary | null>
  connected: () => boolean
}) {
  const { namespaceList, namespace, liveSummary, connected } = deps
  // Keep the sidebar entry for the namespace being viewed live from the SSE `summary` event,
  // instead of letting it lag up to 15s behind the /namespaces poll. The server computes summary
  // from the UNFILTERED graph (same as /namespaces), so it never disagrees with the polled
  // value — fixes the old bug where opening a degraded namespace in ownership view "healed" it
  // because the filtered topology omitted the actually-degraded resource (e.g. an endpointless
  // Service that lives in network view).
  // Held in a RECONCILED store (keyed by name) rather than a plain memo: the memo rebuilt the selected
  // namespace as a fresh object on every `summary` event, so the Sidebar's <For> tore down and recreated
  // that row each tick (the namespace-list "flicker"). reconcile patches only the changed row's health
  // in place, so <For> keeps the DOM and the dot recolours surgically — the same fix the canvas cards got.
  // Compute the merged list in a MEMO, then reconcile it into the store through a single-dependency
  // effect. The merge reads four sources (the polled list + the open ns + its live summary + conn
  // state); folding them into one pure memo keeps the reconcile effect depending on a SINGLE input.
  // A context switch fires an interleaved storm of these updates (the namespace resource resolving
  // while the SSE resubscribe flips connState/summary), and an effect that read all four directly
  // intermittently latched a stale list — it ran on a connState change a beat before the resource's
  // value committed, then never re-fired for the value, leaving the sidebar stuck on the PREVIOUS
  // cluster's namespaces. Routing the four through a glitch-free memo makes the effect re-run exactly
  // when the merged value changes (verified live across cluster switches).
  const merged = createMemo<NamespaceInfo[]>(() => {
    const list = namespaceList()
    const ns = namespace()
    const live = liveSummary()
    return !connected() || !ns || !live ? list : list.map((n) => (n.name === ns ? { ...n, health: live.health, nonReady: live.nonReady } : n))
  })
  const [sidebarNs, setSidebarNs] = createStore<NamespaceInfo[]>([])
  createEffect(() => setSidebarNs(reconcile(merged(), { key: 'name' })))

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
