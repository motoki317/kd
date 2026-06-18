// The SSE graph subscription lifecycle, extracted from App.tsx so the (re)subscribe rules — what
// resets on a ctx/ns change, what survives a manual reconnect, how a snapshot resolves the
// selection — live next to the stream handlers they drive. The reconcile + defensive `?? []`
// semantics (via graphState's reducers) are load-bearing: a nil-slice snapshot once threw inside
// the SSE listener and silently killed it (see AGENTS.md "Force empty slices to []").
// A factory: App calls it inside its component body so the effect runs under its root.

import { createEffect, createSignal, onCleanup, untrack, type Accessor, type Setter } from 'solid-js'
import { reconcile, type SetStoreFunction } from 'solid-js/store'
import { streamGraph, type NamespaceSummary } from './api'
import type { ConnState } from './clusterSession'
import { applyPatch, emptyState, fromSnapshot, type GraphState } from './graphState'
import { resolveSelectionOnSnapshot } from './nav'
import type { Capacity, Health } from './types'

export function createGraphSubscription(deps: {
  ctx: Accessor<string | null>
  namespace: Accessor<string | null>
  selectedId: Accessor<string | null>
  setSelectedId: Setter<string | null>
  setSearch: Setter<string>
  setHealthFilter: Setter<Health | null>
  setKindFilter: Setter<Set<string>>
  setSelectionHistory: Setter<string[]>
  graph: GraphState
  setGraph: SetStoreFunction<GraphState>
  // Records a stream's per-namespace summary into the live-health cache, keyed by the context and
  // namespace this stream was opened FOR (captured below) so a late event can't mis-key — see liveHealth.ts.
  recordSummary: (ctx: string, ns: string, s: NamespaceSummary) => void
  setCapacity: Setter<Capacity | null>
  connState: Accessor<ConnState>
  setConnState: Setter<ConnState>
  refetchContexts: () => void
  // The "?sel=" deep-link still waiting to be restored — owned by App (its reactive restore path
  // also consumes it), read/cleared here because the snapshot resolution is authoritative over it.
  pendingSel: () => string | null
  clearPendingSel: () => void
}) {
  const {
    ctx,
    namespace,
    selectedId,
    setSelectedId,
    setSearch,
    setHealthFilter,
    setKindFilter,
    setSelectionHistory,
    graph,
    setGraph,
    recordSummary,
    setCapacity,
    connState,
    setConnState,
    refetchContexts,
    pendingSel,
    clearPendingSel,
  } = deps

  // Manual reconnect signal (cycle 291): clicking the offline conn pill bumps this counter,
  // which the SSE subscription effect tracks — incrementing tears down the stale EventSource and
  // opens a fresh one. EventSource auto-reconnects with backoff, but the operator sometimes knows
  // the server just came back and doesn't want to wait the rest of the backoff window.
  const [reconnectTick, setReconnectTick] = createSignal(0)

  // (Re)subscribe to the graph feed whenever the context or namespace changes. A context switch
  // closes the old SSE stream and opens a fresh one against the new cluster's cache. Grouping and
  // relationship-filter changes do NOT resubscribe — the server streams the full graph and the
  // client re-projects it locally, so they're pure client-side relayouts.
  // The first run keeps URL-seeded filters (?kinds=) — only an actual change resets them.
  let firstSubscribe = true
  let lastSubscribedCtx: string | null = null
  createEffect(() => {
    const c = ctx()
    const ns = namespace()
    reconnectTick() // tracked: a manual reconnect (cycle 291) re-fires the effect
    if (!c || !ns) return
    // Preserve the selection across a resubscribe when the same resource still exists (UIDs are
    // stable), so a manual reconnect keeps the selection. A namespace change naturally clears it:
    // the old UID won't be in the new namespace's graph. untrack so reading the current selection
    // doesn't make this effect re-subscribe on selection.
    // A CONTEXT change clears it immediately instead of waiting for the new snapshot to resolve
    // it away: if the new cluster never answers (dead credentials), the stale selection ghosted
    // into the drawer with a false "Deleted from the cluster" banner — the resource is fine, the
    // cluster is unreachable (D79).
    const ctxChanged = lastSubscribedCtx !== null && lastSubscribedCtx !== c
    lastSubscribedCtx = c
    if (ctxChanged) setSelectedId(null)
    const keepSel = ctxChanged ? null : untrack(selectedId)
    if (!firstSubscribe) {
      // A stale search/health/kind filter would fade the whole new graph. Cleared only on
      // real transitions — initial mount keeps URL-seeded filters.
      setSearch('')
      setHealthFilter(null)
      setKindFilter(new Set<string>())
      setSelectionHistory([]) // history points at IDs that no longer exist in the new graph
    }
    firstSubscribe = false
    setGraph(reconcile(emptyState()))
    // NB: no per-switch reset of the live summary — the cache is keyed by namespace and gated by
    // context + poll generation (liveHealth.ts), so a just-left namespace keeps its last real-time
    // value (no revert-to-stale flap) until the next poll supersedes it.
    setCapacity(null) // the previous stream's capacity feed belongs to the previous scope
    setConnState('connecting')
    const close = streamGraph(c, ns, {
      snapshot: (g) => {
        // Decide the selection from the snapshot's own nodes BEFORE mutating the store, so this set
        // is authoritative over the reactive deep-link restore below (which would otherwise race and
        // get clobbered): keep the current selection if still present, else adopt a URL deep-link.
        const sel = resolveSelectionOnSnapshot(g.nodes, keepSel, pendingSel())
        if (sel.consumedPending) clearPendingSel()
        setGraph(reconcile(fromSnapshot(g)))
        setConnState('live')
        setSelectedId(sel.id)
      },
      patch: (p) => setGraph(reconcile(applyPatch(graph, p))),
      summary: (s) => recordSummary(c, ns, s),
      capacity: (c) => setCapacity(c),
      error: () => {
        // On the TRANSITION into offline, refetch the contexts list: the failure that just broke
        // the stream also populated the context's status/error server-side (it was "pending" at
        // the initial fetch), and the empty-state diagnosis reads from it. Transition-gated so
        // EventSource's auto-retry storm doesn't hammer /contexts.
        if (connState() !== 'offline') void refetchContexts()
        setConnState('offline')
      },
    })
    onCleanup(close)
  })

  return { setReconnectTick }
}
