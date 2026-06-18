// The per-namespace live-health cache: real-time SSE `summary` events accumulated and merged over the
// 15s /namespaces poll, so the sidebar shows each namespace's freshest known health without flapping as
// the operator navigates. Extracted from the cluster session as a factory taking plain accessors, so the
// context/generation gating is unit-testable (liveHealth.test.ts) without the /namespaces resource.
//
// Background: the SSE `summary` is per-stream and carries NO namespace name — it is implicitly the open
// namespace's. The old code kept it in a single signal cleared on every switch, so the open row showed
// real-time truth while every other row (and the open one the instant you left) showed the ≤15s-stale
// poll; navigating in/out of a namespace whose health changed in that window flapped its dot and count.

import { createMemo, type Accessor } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { NamespaceInfo, NamespaceSummary } from './api'
import { mergeNamespaceHealth, type LiveHealth } from './ns'

export function createLiveHealth(deps: {
  ctx: Accessor<string | null>
  namespaceList: Accessor<NamespaceInfo[]>
  pollGen: Accessor<number>
}) {
  const { ctx, namespaceList, pollGen } = deps
  const [liveByNs, setLiveByNs] = createStore<Record<string, LiveHealth>>({})

  // Record a stream's summary into the cache, keyed by namespace and tagged with the context it was
  // streamed FOR plus the current poll generation. Guarded against a late event from a torn-down
  // EventSource of a previous context (EventSource.close() does not retract already-queued handlers):
  // such an event must not clobber the new context's valid entry for a same-named namespace. The
  // merge also filters by context, so this guard is belt-and-suspenders — together they make a
  // same-named namespace across clusters impossible to cross-contaminate.
  const recordSummary = (eventCtx: string, ns: string, summary: NamespaceSummary) => {
    if (eventCtx !== ctx()) return
    setLiveByNs(ns, { health: summary.health, nonReady: summary.nonReady, gen: pollGen(), ctx: eventCtx })
  }

  // A single glitch-free memo folding the three sources (poll list + live cache + poll generation),
  // so a downstream reconcile effect re-runs exactly when the merged value changes — the property the
  // sidebar relies on to avoid the cluster-switch stale-latch. The current context is read here so the
  // merge can drop entries belonging to a previous one.
  const mergedNamespaces = createMemo(() => mergeNamespaceHealth(namespaceList(), liveByNs, pollGen(), ctx()))

  return { mergedNamespaces, recordSummary }
}
