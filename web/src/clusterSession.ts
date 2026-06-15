// Cluster data bootstrap + connection state, extracted from App.tsx as one unit because the pieces
// fail together: the contexts/namespaces/kinds fetches, the connecting/live/offline ladder, and the
// namespace auto-pick/trouble-jump that decide where kd lands. A failed fetch here must both take
// connState offline AND refresh the contexts list so the canvas can name the server's diagnosis.
// A factory: App calls it inside its component body so the resources/effects run under its root.

import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack, type Accessor, type Setter } from 'solid-js'
import { ApiError, fetchContexts, fetchKinds, fetchNamespaces, type NamespaceInfo } from './api'
import { setServerShortNames } from './names'
import { mostTroubled, namespaceLabel, nextTroubled } from './ns'

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

  // Namespace list is keyed on ctx so a context switch refetches against the new cluster. Wait for
  // ctx to resolve so the first fetch hits the right URL (avoids a doomed call to /contexts/null/).
  // The value carries the context it was fetched FOR so the list can be dropped the instant ctx
  // changes — see namespaceList.
  const [namespaces, { refetch: refetchNamespaces }] = createResource(ctx, async (c) => ({ forCtx: c, list: await fetchNamespaces(c) }))
  // namespaces() rethrows if the fetch errored (Solid resources throw on read in an error state), which
  // would crash the whole app instead of letting the sidebar show its "couldn't load" state — so always
  // read the list through this guard, which yields [] on error/while loading.
  //
  // Drop the list the moment ctx changes (forCtx !== ctx()), rather than letting the resource's
  // stale-while-revalidate keep the PREVIOUS cluster's namespaces on screen during the refetch.
  // Two reasons: (1) showing another cluster's namespaces after a switch is wrong on its face; (2) it
  // mirrors how the graph resets to empty on a ctx switch, which the sidebar list did NOT — the
  // sidebar kept churning the old list through the new cluster's resolves (cold-cache partial → full)
  // amid the SSE-resubscribe update storm, and Solid's fine-grained subscriptions intermittently
  // desynced so the list stuck on the old cluster forever (the "switching contexts loads nothing" bug).
  // A synchronous []-then-repopulate on ctx change is the clean transition the graph already had.
  const namespaceList = createMemo<NamespaceInfo[]>(() => {
    if (namespaces.error) return []
    const v = namespaces()
    return v && v.forCtx === ctx() ? v.list : []
  })
  // Kind → API short-name map (cycle 302): fetched once per context so cards label kinds with the
  // cluster's own abbreviations (cm, pdb, CRD-defined shorts) instead of a hardcoded guess. Keyed
  // on ctx because CRDs — hence short names — differ per cluster. Feeds names.ts via a setter
  // rather than props so every kindShortLabel() call site picks it up without threading the map
  // through the whole topology tree; an error leaves the hardcoded fallback in place.
  const [kindShortNames] = createResource(ctx, (c) => fetchKinds(c))
  createEffect(() => setServerShortNames(kindShortNames.error ? {} : kindShortNames() ?? {}))
  // 'connecting' on initial subscribe, 'live' once a snapshot arrives, 'offline' on stream error.
  // Distinguishing connecting from offline avoids the alarming "offline" pill flashing on every
  // first load / namespace switch when nothing is wrong — the stream just hasn't yielded yet.
  const [connState, setConnState] = createSignal<'connecting' | 'live' | 'offline'>('connecting')
  const connected = () => connState() === 'live'
  // A failed namespace-list fetch is a cluster-level failure (unreachable or forbidden context),
  // not just a sidebar problem: with no namespace ever picked the subscribe effect never runs, so
  // nothing else would move connState off its initial 'connecting' — the pill and the canvas would
  // promise progress forever (caught live against a dead kubeconfig context). Treat it like a
  // stream error: go offline, and refresh the contexts list (transition-gated, like the stream's
  // error path) so the canvas diagnosis can name the server's reason for THIS context.
  createEffect(() => {
    if (!namespaces.error) return
    if (untrack(connState) !== 'offline') void refetchContexts()
    setConnState('offline')
  })
  // An empty namespace list that loaded FINE is its own terminal state, distinct from offline:
  // the cluster answered, this account just can't see anything (lockdown policy). Without it the
  // canvas spun "connecting…" forever — no namespace means the subscribe effect never runs, so
  // connState never moves. Gated on 'ready' so the unresolved pre-fetch state doesn't flash it.
  const noNamespaces = createMemo(() => namespaces.state === 'ready' && namespaceList().length === 0)
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
    const next = nextTroubled(namespaceList(), namespace())
    if (next) {
      setNamespace(next.name)
      setNsFlash((t) => t + 1) // pulse the row so the jump's landing is unmissable
      return true
    }
    return false
  }

  // A URL-seeded namespace that can't be opened (RBAC-denied, deleted, or absent from a newly
  // switched context) gets silently replaced by the fallback below — say so, or a shared link
  // lands the operator on someone else's view with zero explanation. Auto-clears; dismissible.
  const [nsNotice, setNsNotice] = createSignal<string | null>(null)
  let nsNoticeTimer: ReturnType<typeof setTimeout> | undefined
  const noteNsFallback = (wanted: string) => {
    setNsNotice(`Couldn't open namespace "${namespaceLabel(wanted)}" — no access, or it no longer exists.`)
    clearTimeout(nsNoticeTimer)
    nsNoticeTimer = setTimeout(() => setNsNotice(null), 10_000)
  }

  // Pick a namespace once the list loads: keep a valid URL-seeded one, else open the most troubled
  // one (the sidebar's top item), so kd lands on "what's wrong" rather than the alphabetical first —
  // and a stale/forbidden ?ns= doesn't strand the user on an empty graph.
  createEffect(() => {
    const list = namespaceList()
    if (list.length === 0) return
    if (!list.some((n) => n.name === namespace())) {
      const wanted = namespace()
      if (wanted) noteNsFallback(wanted) // null = no target was asked for; nothing to explain
      setNamespace(mostTroubled(list)!.name)
      setNsFlash((t) => t + 1)
    }
  })

  // Keep the sidebar's per-namespace health roughly current without a dedicated stream.
  const interval = setInterval(() => refetchNamespaces(), 15000)
  onCleanup(() => clearInterval(interval))

  return {
    contextsRes,
    refetchContexts,
    contextsInfo,
    authFailed,
    namespaces,
    refetchNamespaces,
    namespaceList,
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
