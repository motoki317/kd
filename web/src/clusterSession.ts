// Cluster data bootstrap + connection state, extracted from App.tsx as one unit because the pieces
// fail together: the contexts/namespaces/kinds fetches, the connecting/live/offline ladder, and the
// namespace auto-pick/trouble-jump that decide where kd lands. A failed fetch here must both take
// connState offline AND refresh the contexts list so the canvas can name the server's diagnosis.
// A factory: App calls it inside its component body so the resources/effects run under its root.

import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack, type Accessor, type Setter } from 'solid-js'
import { ApiError, fetchContexts, fetchKinds, streamNamespaces, type NamespaceInfo } from './api'
import { createLiveHealth } from './liveHealth'
import { setServerShortNames } from './names'
import { decideNamespacePick, namespaceLabel, nextTroubled } from './ns'

export type ConnState = 'connecting' | 'live' | 'offline'

export function createClusterSession(deps: {
  ctx: Accessor<string | null>
  setCtx: Setter<string | null>
  namespace: Accessor<string | null>
  setNamespace: Setter<string | null>
}) {
  const { ctx, setCtx, namespace, setNamespace } = deps
  // The contexts list drives the topbar switcher (FR-005) and the default context the URL falls back
  // to (FR-004). It loads once on mount — the kubeconfig is snapshot at server start so the SET
  // never changes — but the per-context STATUS/error do change (a context is "pending" until first
  // touched; its cache-build failure lands after this initial fetch), so the stream-error path
  // refetches to pick up the diagnosis the offline empty-state shows.
  const [contextsRes, { refetch: refetchContexts }] = createResource(fetchContexts)
  const contextsInfo = createMemo(() => (contextsRes.error ? null : contextsRes() ?? null))
  // The contexts list is kd's bootstrap: when IT fails, nothing downstream (ctx → namespaces →
  // subscribe) ever fires and the canvas would spin "connecting…" forever. A 401/403 is an
  // identity answer — kd's auth proxy sent no identity, or policy denies it — not an outage, so
  // it gets its own terminal state instead of the offline ("can't reach") misdiagnosis.
  const authFailed = createMemo(
    () =>
      contextsRes.error instanceof ApiError &&
      (contextsRes.error.status === 401 || contextsRes.error.status === 403),
  )

  // Resolve ?ctx= once the contexts list arrives: keep a known URL-supplied context, otherwise fall
  // back to the server-reported default (kubeconfig current-context, or the in-cluster sentinel).
  createEffect(() => {
    const info = contextsInfo()
    if (!info) return
    const known = info.contexts.some((c) => c.name === ctx())
    if (!known) setCtx(info.default)
  })

  // Per-namespace health arrives over a long-lived SSE stream (was a 15s poll): the server rolls up
  // every visible namespace's worst health and pushes the list on connect and whenever it changes. The
  // stream is keyed on ctx so a context switch closes the old one and opens a fresh stream against the
  // new cluster. The value carries the context it was received FOR so the list can be dropped the
  // instant ctx changes — see namespaceList.
  const [nsData, setNsData] = createSignal<{ forCtx: string; list: NamespaceInfo[] } | null>(null)
  // nsReceived gates the "loaded but empty" terminal state (noNamespaces) apart from "not delivered
  // yet" (loading); nsErrored drives the offline transition below. nsReconnect re-opens the stream on
  // demand (the offline pill / retry button), like the graph subscription's reconnectTick.
  const [nsReceived, setNsReceived] = createSignal(false)
  const [nsErrored, setNsErrored] = createSignal(false)
  const [nsReconnect, setNsReconnect] = createSignal(0)
  const refetchNamespaces = () => setNsReconnect((n) => n + 1)
  createEffect(() => {
    const c = ctx()
    nsReconnect() // tracked: a manual reconnect tears down the stream and opens a fresh one
    if (!c) return // wait for ctx to resolve so the stream hits the right URL, not /contexts/null/
    // Drop the list synchronously on a ctx change rather than keeping the PREVIOUS cluster's
    // namespaces on screen during the switch: (1) showing another cluster's list is wrong on its face;
    // (2) it mirrors how the graph resets to empty on a ctx switch (the sidebar list previously kept
    // churning the old list and intermittently stuck on it — the "switching contexts loads nothing"
    // bug). A synchronous reset-then-repopulate is the clean transition the graph already had.
    setNsData(null)
    setNsReceived(false)
    setNsErrored(false)
    const close = streamNamespaces(c, {
      namespaces: (list) => {
        setNsData({ forCtx: c, list })
        setNsReceived(true)
        setNsErrored(false) // a fresh push means the stream recovered from a transient drop
      },
      error: () => setNsErrored(true),
    })
    onCleanup(close)
  })
  // Guard reads through this memo: yields [] on error / before the first push, and drops the list the
  // instant ctx changes (forCtx !== ctx()).
  const namespaceList = createMemo<NamespaceInfo[]>(() => {
    if (nsErrored()) return []
    const v = nsData()
    return v && v.forCtx === ctx() ? v.list : []
  })
  // Poll generation: a monotonic counter bumped each time an ACCEPTED push lands — accepted by the
  // SAME forCtx rule namespaceList uses, so a previous-context push never advances it. The live-health
  // cache stamps each entry with the generation it arrived in; an entry overrides the stream value only
  // until the next generation supersedes it (see mergeNamespaceHealth).
  const [pollGen, setPollGen] = createSignal(0)
  createEffect(() => {
    if (nsErrored()) return
    const v = nsData()
    if (v && v.forCtx === untrack(ctx)) setPollGen((g) => g + 1)
  })
  // Resource-shaped accessors the rest of the app reads (App.tsx): error state and a loading flag that
  // mirrors the old createResource surface. namespacesLoading is true until the first push (or after a
  // reconnect resets it), and false once errored so the sidebar shows the failure, not a spinner.
  const namespacesError = () => nsErrored()
  const namespacesLoading = () => !nsReceived() && !nsErrored()
  // Per-namespace live health: real-time SSE summaries merged over the poll so the sidebar stops
  // flapping between the two as the operator navigates — see liveHealth.ts. recordSummary is fed by the
  // graph subscription's `summary` handler; mergedNamespaces is the single source the sidebar (and the
  // trouble jump below) reads.
  const { mergedNamespaces, recordSummary } = createLiveHealth({ ctx, namespaceList, pollGen })
  // Kind → API short-name map: fetched once per context so cards label kinds with the
  // cluster's own abbreviations (cm, pdb, CRD-defined shorts) instead of a hardcoded guess. Keyed
  // on ctx because CRDs — hence short names — differ per cluster. Feeds names.ts via a setter
  // rather than props so every kindShortLabel() call site picks it up without threading the map
  // through the whole topology tree; an error leaves the hardcoded fallback in place.
  const [kindShortNames] = createResource(ctx, (c) => fetchKinds(c))
  createEffect(() => setServerShortNames(kindShortNames.error ? {} : kindShortNames() ?? {}))
  // 'connecting' on initial subscribe, 'live' once a snapshot arrives, 'offline' on stream error.
  // Distinguishing connecting from offline avoids the alarming "offline" pill flashing on every
  // first load / namespace switch when nothing is wrong — the stream just hasn't yielded yet.
  const [connState, setConnState] = createSignal<ConnState>('connecting')
  const connected = () => connState() === 'live'
  // A failed namespace-list stream is a cluster-level failure (unreachable or forbidden context),
  // not just a sidebar problem: with no namespace ever picked the subscribe effect never runs, so
  // nothing else would move connState off its initial 'connecting' — the pill and the canvas would
  // promise progress forever (caught live against a dead kubeconfig context). Treat it like a stream
  // error: go offline and refresh the contexts list so the canvas diagnosis can name the server's
  // reason for THIS context. Gated on 'connecting' (bootstrap): once the graph stream is live, IT owns
  // connState, so a transient namespaces-stream blip (EventSource auto-retries) leaves the sidebar
  // briefly stale rather than flashing a false "offline".
  createEffect(() => {
    if (!nsErrored()) return
    if (untrack(connState) !== 'connecting') return
    void refetchContexts()
    setConnState('offline')
  })
  // An empty namespace list that loaded FINE is its own terminal state, distinct from offline:
  // the cluster answered, this account just can't see anything (lockdown policy). Without it the
  // canvas spun "connecting…" forever — no namespace means the subscribe effect never runs, so
  // connState never moves. Gated on a delivered (non-errored) push so the pre-stream state doesn't flash it.
  const noNamespaces = createMemo(() => nsReceived() && !nsErrored() && namespaceList().length === 0)
  // A non-auth contexts failure (kd itself down/broken) reads offline, engaging the retry pill.
  createEffect(() => {
    if (contextsRes.error && !authFailed()) setConnState('offline')
  })

  // Bumped on a programmatic jump to a namespace (first-load auto-pick, the trouble badge) so the sidebar can
  // flash the destination row — see Sidebar's flash prop. A plain click doesn't bump it.
  const [nsFlash, setNsFlash] = createSignal(0)

  // Step to the next troubled namespace — wired to the sidebar trouble badge
  // so both land identically (with the flash pulse). Cycles from the current selection (worst first,
  // then next-worst, wrapping) so repeated presses triage every troubled namespace rather than
  // re-landing on the single worst. No-op when nothing is troubled; returns whether it acted so the
  // keyboard handler only swallows the key when it actually jumped.
  const jumpToTrouble = (): boolean => {
    // Read the MERGED list (same source the trouble badge counts), not the raw poll — otherwise the
    // badge and the jump it triggers could disagree once a live summary has refreshed a row.
    const next = nextTroubled(mergedNamespaces(), namespace())
    if (next) {
      setNamespace(next.name)
      setNsFlash((t) => t + 1) // pulse the row so the jump's landing is unmissable
      return true
    }
    return false
  }

  // A ?ns= seeded for THIS context that can't be opened (RBAC-denied or deleted) gets silently
  // replaced by the fallback below — say so, or a shared link lands the operator on someone else's
  // view with zero explanation. A namespace merely absent from a newly switched context does NOT
  // trigger this (it's expected, not a failure — see decideNamespacePick). Auto-clears; dismissible.
  const [nsNotice, setNsNotice] = createSignal<string | null>(null)
  let nsNoticeTimer: ReturnType<typeof setTimeout> | undefined
  const noteNsFallback = (wanted: string) => {
    setNsNotice(`Couldn't open namespace "${namespaceLabel(wanted)}" — no access, or it no longer exists.`)
    clearTimeout(nsNoticeTimer)
    nsNoticeTimer = setTimeout(() => setNsNotice(null), 10_000)
  }

  // The context the current namespace selection was last resolved against. NOT reactive — a plain cell
  // read by the picker effect to distinguish a stale ?ns= seeded for THIS context (explain the
  // fallback) from a namespace carried over from a PREVIOUS context on a switch (don't — see
  // decideNamespacePick). Updated only after a non-empty resolution, so it holds the OLD context
  // through the switch's transient empty-list window and the picker reads the switch correctly.
  let nsResolvedCtx: string | null = null
  // Pick a namespace once the list loads: keep a valid selection (incl. a same-named one carried
  // across a context switch), else land on the most troubled namespace per decideNamespacePick — the
  // same place a first open picks, so a switch and a fresh load behave identically — with a notice
  // only for a stale/forbidden ?ns= (not a context switch). Never strands the operator on an empty graph.
  createEffect(() => {
    const list = namespaceList()
    if (list.length === 0) return
    const c = untrack(ctx)
    const wanted = namespace()
    const pick = decideNamespacePick(list, wanted, c, nsResolvedCtx)
    if (pick) {
      if (pick.notify && wanted) noteNsFallback(wanted) // null wanted = nothing was asked for; nothing to explain
      setNamespace(pick.name)
      setNsFlash((t) => t + 1)
    }
    nsResolvedCtx = c
  })

  return {
    contextsRes,
    refetchContexts,
    contextsInfo,
    authFailed,
    namespacesError,
    namespacesLoading,
    refetchNamespaces,
    mergedNamespaces,
    recordSummary,
    noNamespaces,
    connState,
    setConnState,
    connected,
    nsFlash,
    jumpToTrouble,
    nsNotice,
    setNsNotice,
  }
}
