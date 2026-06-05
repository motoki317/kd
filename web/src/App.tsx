import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { CLUSTER_SCOPE, fetchContexts, fetchKinds, fetchNamespaces, streamGraph, type NamespaceSummary } from './api'
import { hasDescendantPod } from './loggable'
import { selectionLabel, setServerShortNames } from './names'
import { applyPatch, emptyState, fromSnapshot, type GraphState } from './graphState'
import { faviconDataUrl, worstHealth } from './favicon'
import { navCandidates, nextSelection, resolveSelectionOnSnapshot } from './nav'
import { mostTroubled, namespaceLabel, nextTroubled } from './ns'
import type { Capacity, GroupBy, Health, KNode, RelCategory } from './types'
import { REL_CATEGORIES } from './relationships'
import { nonOwnershipEdgeLabels } from './edgeRender'
import { readPref, readRawPref, writePref } from './prefs'
import { toggleInSet } from './filterToggle'
import Sidebar from './components/Sidebar'
import Topology, { GROUP_OPTIONS } from './components/Topology'
import type { CapResource } from './capacityLayout'
import DetailDrawer from './components/DetailDrawer'
import ContextSwitcher from './components/ContextSwitcher'
import { applyTheme, loadThemePref, nextThemePref, saveThemePref, type ThemePref } from './theme'

// Group-by is the layout strategy — how resources are arranged on the canvas. It replaced the old
// fixed view tabs: grouping is now orthogonal to *which relationships are drawn* (the composable
// relationship filter, see relationships.ts). The segmented control that sets it lives in the
// Topology toolbar (GROUP_OPTIONS is shared from there); App keeps the signal, the URL/localStorage
// persistence, the number-key shortcuts (1..3), and the help overlay listing.
const GROUP_IDS = GROUP_OPTIONS.map((g) => g.id)
const REL_IDS = new Set(REL_CATEGORIES.map((c) => c.id))
const DEFAULT_RELS = (): Set<RelCategory> => new Set<RelCategory>(['ownership'])

// Parse a comma-separated relationship list (URL or localStorage). Returns null when the source is
// absent (so the next source / the default applies); an explicit empty string round-trips to the
// empty set, letting "all relationships off" persist rather than snapping back to the default.
function parseRels(raw: string | null): Set<RelCategory> | null {
  if (raw === null) return null
  return new Set(raw.split(',').filter((x): x is RelCategory => REL_IDS.has(x as RelCategory)))
}

export default function App() {
  // The contexts list drives the topbar switcher (FR-005) and the default context the URL falls back
  // to (FR-004). It loads once on mount; the kubeconfig is snapshot at server start so a poll would
  // never change the set.
  const [contextsRes] = createResource(fetchContexts)
  const contextsInfo = createMemo(() => (contextsRes.error ? null : contextsRes() ?? null))
  // Seed namespace/ctx/grouping/relationships from the URL so a link or reload restores the same
  // place. Grouping + relationship filter also fall back to localStorage (then their defaults), so
  // a plain reload of an un-shared URL still remembers how the operator last arranged the canvas.
  const params = new URLSearchParams(location.search)
  const [ctx, setCtx] = createSignal<string | null>(params.get('ctx'))
  const [namespace, setNamespace] = createSignal<string | null>(params.get('ns'))
  const urlGroup = params.get('group') as GroupBy
  const [groupBy, setGroupBy] = createSignal<GroupBy>(
    GROUP_IDS.includes(urlGroup) ? urlGroup : readPref('kd:groupBy', 'relationship', GROUP_IDS),
  )
  createEffect(() => writePref('kd:groupBy', groupBy()))
  const [relFilter, setRelFilter] = createSignal<Set<RelCategory>>(
    parseRels(params.get('rels')) ?? parseRels(readRawPref('kd:rels')) ?? DEFAULT_RELS(),
  )
  createEffect(() => writePref('kd:rels', [...relFilter()].sort().join(',')))
  // Capacity-view resource (cpu|memory) — owned here, not in Topology, so it round-trips through the
  // URL like group/rels (the share button must capture "I'm looking at MEMORY pressure", or a shared
  // capacity-view link silently reverts the recipient to CPU). Falls back to localStorage then 'cpu'.
  const urlCapRes = params.get('capRes')
  const [capResource, setCapResource] = createSignal<CapResource>(
    urlCapRes === 'cpu' || urlCapRes === 'memory' ? urlCapRes : readPref('kd:capRes', 'cpu', ['cpu', 'memory']),
  )
  createEffect(() => writePref('kd:capRes', capResource()))
  // Relationship + kind chips share one toggle/solo semantics — see toggleInSet.
  const toggleRel = (c: RelCategory, solo = false) => setRelFilter(toggleInSet(relFilter(), c, solo))
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  // Navigation history (cycle 300): operators walk owner chips and event-source pills to chase a
  // controller→pod→pod-event trail. Without history, going back means remembering what they had
  // selected — error-prone after a few hops. A stack of prior selection IDs powers a "back"
  // button and an Alt+Left shortcut. Cleared on namespace/view/ctx change so we don't restore an
  // ID that no longer exists in the graph.
  const [selectionHistory, setSelectionHistory] = createSignal<string[]>([])
  // selectAndRemember: the path callers should use whenever a click should be reversible. Plain
  // setSelectedId stays for cases that shouldn't push (deselection, URL restoration, j/k stepping).
  const selectAndRemember = (next: string) => {
    const prev = selectedId()
    if (prev && prev !== next) setSelectionHistory((h) => [...h, prev])
    setSelectedId(next)
  }
  const goBackSelection = () => {
    const h = selectionHistory()
    if (h.length === 0) return false
    const prev = h[h.length - 1]
    setSelectionHistory(h.slice(0, -1))
    setSelectedId(prev)
    return true
  }

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
  const [namespaces, { refetch: refetchNamespaces }] = createResource(ctx, (c) => fetchNamespaces(c))
  // namespaces() rethrows if the fetch errored (Solid resources throw on read in an error state), which
  // would crash the whole app instead of letting the sidebar show its "couldn't load" state — so always
  // read the list through this guard, which yields [] on error/while loading.
  const namespaceList = createMemo(() => (namespaces.error ? [] : namespaces() ?? []))
  // Kind → API short-name map (cycle 302): fetched once per context so cards label kinds with the
  // cluster's own abbreviations (cm, pdb, CRD-defined shorts) instead of a hardcoded guess. Keyed
  // on ctx because CRDs — hence short names — differ per cluster. Feeds names.ts via a setter
  // rather than props so every kindShortLabel() call site picks it up without threading the map
  // through the whole topology tree; an error leaves the hardcoded fallback in place.
  const [kindShortNames] = createResource(ctx, (c) => fetchKinds(c))
  createEffect(() => setServerShortNames(kindShortNames.error ? {} : kindShortNames() ?? {}))
  // A URL-seeded "Kind/name" selection to restore once its node appears in the graph (UIDs aren't
  // stable across reloads, so we key the link on the stable identity).
  let pendingSel = params.get('sel')
  // 'connecting' on initial subscribe, 'live' once a snapshot arrives, 'offline' on stream error.
  // Distinguishing connecting from offline avoids the alarming "offline" pill flashing on every
  // first load / namespace switch when nothing is wrong — the stream just hasn't yielded yet.
  const [connState, setConnState] = createSignal<'connecting' | 'live' | 'offline'>('connecting')
  const connected = () => connState() === 'live'
  // Clicking a legend health spotlights those nodes (fades the rest); click again to clear.
  const [healthFilter, setHealthFilter] = createSignal<Health | null>(null)
  // Kind filter (cycle 203): a multi-select set of kinds to spotlight, composing with search +
  // healthFilter. Lives in App so it resets on namespace/view change alongside the others. Seed
  // from `?kinds=` so a shared URL restores the filtered view (cycle 217).
  const urlKinds = params.get('kinds')
  const [kindFilter, setKindFilter] = createSignal<Set<string>>(
    new Set(urlKinds ? urlKinds.split(',').filter(Boolean) : []),
  )
  // Operators reach for solo when they want "show me ONLY Pods" without first clearing the prior
  // multi-select. Shared toggle/solo semantics — see toggleInSet.
  const toggleKind = (k: string, solo = false) => setKindFilter(toggleInSet(kindFilter(), k, solo))
  // Topology search lives here (not in Topology) so it resets on namespace/view change.
  const [search, setSearch] = createSignal('')
  const [showHelp, setShowHelp] = createSignal(false)
  // Collapsible sidebar (cycle 299): operators with wide ownership graphs sometimes want every
  // pixel for the canvas. Cmd/Ctrl+B toggles; state persists in localStorage so a reload doesn't
  // surprise them with the sidebar re-appearing. Default expanded.
  const [sidebarHidden, setSidebarHidden] = createSignal(readRawPref('kd:sidebarHidden') === '1')
  createEffect(() => writePref('kd:sidebarHidden', sidebarHidden() ? '1' : '0'))
  // Theme preference (cycle 301): light / dark / system, cycled from a topbar toggle. The effect
  // persists the choice and re-stamps <html data-theme>; index.tsx already applied it pre-render.
  // When the choice is 'system', track OS scheme changes live so the canvas follows a mid-session
  // OS flip — the explicit pins ignore the OS, so we tear the listener down when not on 'system'.
  const [themePref, setThemePref] = createSignal<ThemePref>(loadThemePref())
  createEffect(() => {
    const pref = themePref()
    saveThemePref(pref)
    applyTheme(pref)
    if (pref !== 'system' || typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    onCleanup(() => mq.removeEventListener('change', onChange))
  })
  // Last value yanked via the 'y' shortcut (cycle 288). Surfaced as a brief toast so the operator
  // can see what hit their clipboard — otherwise a silent copy is indistinguishable from a missed
  // keystroke. The toast auto-clears after 1.5s.
  const [copiedRef, setCopiedRef] = createSignal<string | null>(null)
  createEffect(() => {
    if (!copiedRef()) return
    const t = setTimeout(() => setCopiedRef(null), 1500)
    onCleanup(() => clearTimeout(t))
  })

  const [graph, setGraph] = createStore<GraphState>(emptyState())
  // Live namespace summary from the SSE feed, computed server-side over the UNFILTERED graph so
  // it doesn't disagree with /namespaces. When unset (no live stream yet) we fall back to the
  // polled list — keeping the sidebar from briefly flipping a degraded ns to healthy on click
  // just because the current view (e.g. ownership) doesn't include the unhealthy resource.
  const [liveSummary, setLiveSummary] = createSignal<NamespaceSummary | null>(null)
  // The cluster-wide capacity feed (all Nodes + Pods across every namespace, with live usage) the
  // Nodes group-by draws. Independent of the namespace-scoped graph: a node hosts pods from every
  // namespace, so the view always shows the whole cluster and dims pods outside the selected
  // namespace. Null until the first `capacity` event; cleared on resubscribe.
  const [capacity, setCapacity] = createSignal<Capacity | null>(null)
  // Bumped on a programmatic jump to a namespace (first-load auto-pick, Alt+T) so the sidebar can
  // flash the destination row — see Sidebar's flash prop. A plain click doesn't bump it.
  const [nsFlash, setNsFlash] = createSignal(0)

  // Step to the next troubled namespace — shared by the Alt+T shortcut and the sidebar trouble badge
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

  // Pick a namespace once the list loads: keep a valid URL-seeded one, else open the most troubled
  // one (the sidebar's top item), so kd lands on "what's wrong" rather than the alphabetical first —
  // and a stale/forbidden ?ns= doesn't strand the user on an empty graph.
  createEffect(() => {
    const list = namespaceList()
    if (list.length === 0) return
    if (!list.some((n) => n.name === namespace())) {
      setNamespace(mostTroubled(list)!.name)
      setNsFlash((t) => t + 1)
    }
  })

  // Mirror ctx/namespace/view/selection back into the URL (replace, not push, so Back isn't spammed).
  // ctx is included only when the switcher is enabled (kubeconfig mode); in-cluster keeps URLs clean.
  // Kind filter (cycle 217) is included so a filtered view ("pods only") is shareable via URL.
  // Search and healthFilter are kept ephemeral — those are mid-investigation state, not view config.
  createEffect(() => {
    const p = new URLSearchParams()
    if (ctx() && contextsInfo()?.enabled) p.set('ctx', ctx()!)
    if (namespace()) p.set('ns', namespace()!)
    // Grouping + relationships are view config worth sharing; omit when at the defaults to keep
    // URLs clean. The relationship list round-trips even when empty (an explicit `?rels=`) so a
    // shared "all relationships off" link restores faithfully.
    if (groupBy() !== 'relationship') p.set('group', groupBy())
    const rels = [...relFilter()].sort().join(',')
    if (rels !== 'ownership') p.set('rels', rels)
    // capRes only changes the Nodes view, but mirror group/rels: write it whenever non-default so a
    // shared capacity-view link restores the resource. Omitted at the 'cpu' default to keep URLs clean.
    if (capResource() !== 'cpu') p.set('capRes', capResource())
    const id = selectedId()
    const n = id ? graph.nodes[id] : null
    if (n) p.set('sel', `${n.kind}/${n.name}`)
    if (kindFilter().size > 0) p.set('kinds', [...kindFilter()].sort().join(','))
    history.replaceState(null, '', `${location.pathname}?${p}`)
  })

  // Reflect ctx + ns + view in the tab title so operators with multiple cluster tabs can tell
  // them apart from the OS chrome (and re-find one in a tab-switcher). Format: "ns · ctx · kd"
  // when both are known, falling back gracefully — the trailing "kd" anchors recognition.
  createEffect(() => {
    const parts: string[] = []
    if (namespace()) parts.push(namespaceLabel(namespace()!))
    if (ctx() && contextsInfo()?.enabled) parts.push(ctx()!)
    parts.push('kd')
    document.title = parts.join(' · ')
  })

  // Restore a URL-seeded selection once its node arrives (then stop tracking).
  createEffect(() => {
    if (!pendingSel) return
    const match = Object.values(graph.nodes).find((n) => `${n.kind}/${n.name}` === pendingSel)
    if (match) {
      setSelectedId(match.id)
      pendingSel = null
    }
  })

  // Keep the sidebar's per-namespace health roughly current without a dedicated stream.
  const interval = setInterval(() => refetchNamespaces(), 15000)
  onCleanup(() => clearInterval(interval))

  // Global keys: "/" jumps to the namespace filter, Cmd/Ctrl+K to the resource search, Escape
  // backs out (blur a field, else close the drawer) — the muscle-memory shortcuts operators
  // expect, with no on-screen chrome.
  let filterEl: HTMLInputElement | undefined
  let searchEl: HTMLInputElement | undefined
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const num = Number(e.key)
      // Cmd/Ctrl+K focuses the topology search (GitHub-style "find any resource"). Works even
      // when typing in another field — the operator's intent is "switch to search".
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        searchEl?.focus()
        searchEl?.select()
        return
      }
      // Cmd/Ctrl+B toggles the namespace sidebar (cycle 299). VS Code uses the same shortcut for
      // its sidebar, so the muscle memory carries over for most operators.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        setSidebarHidden((v) => !v)
        return
      }
      // Alt+Left walks the navigation history back (cycle 300). Browser-back semantics inside the
      // drawer — chase an owner chip or event-source pill, then step back without re-clicking.
      // Alt+Left is the universal "back" gesture on Windows/Linux and isn't claimed by browser
      // history on the SPA route.
      if (e.altKey && e.key === 'ArrowLeft') {
        if (goBackSelection()) e.preventDefault()
        return
      }
      // Alt+T steps to the next troubled namespace — "take me to the problem", and again for the next
      // one (cycles worst-first, wrapping). No-op when the whole cluster is Healthy (nothing to jump
      // to) so the key never yanks you to an arbitrary ns. First landing matches the first-load
      // default selection (cycle 320); repeats walk the rest of the troubled set.
      if (e.altKey && (e.key === 't' || e.key === 'T') && !typing) {
        if (jumpToTrouble()) e.preventDefault()
        return
      }
      if (e.key === '?' && !typing) {
        setShowHelp((s) => !s)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        filterEl?.focus()
      } else if (!typing && num >= 1 && num <= GROUP_OPTIONS.length) {
        setGroupBy(GROUP_OPTIONS[num - 1].id) // 1-3: Relationship / Nodes / Kind grouping
      } else if (!typing && (e.key === 'j' || e.key === 'ArrowDown')) {
        // Walk selection through the graph, troubled-first, so stepping surfaces problems before
        // healthy nodes. Scoped to the active search/health filter so stepping visits only what's
        // spotlighted. The selection drives the drawer and the topology's pan-to-selection.
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter(), kindFilter())
        setSelectedId((cur) => nextSelection(cand, cur, 1) ?? cur)
      } else if (!typing && (e.key === 'k' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter(), kindFilter())
        setSelectedId((cur) => nextSelection(cand, cur, -1) ?? cur)
      } else if (!typing && e.key === 'y' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 'y' yanks the current selection's "Kind/name" to the clipboard — same string Shift+click
        // on the drawer copy button produces (cycle 287), but without opening the drawer first.
        // Mirrors the vim yank verb, so muscle memory carries over. Brief toast via help overlay-
        // adjacent state would be overkill; the standard browser clipboard pulse is the feedback.
        const sel = graph.nodes[selectedId() ?? '']
        if (sel) {
          const ref = `${sel.kind}/${sel.name}`
          // Optional-chain the WHOLE promise chain, not just `clipboard` — in a non-secure context
          // (plain http://<lan-ip>, a real kd access path) `navigator.clipboard` is undefined, so the
          // bare `?.writeText(ref).then(…)` threw an uncaught TypeError on `.then` of undefined.
          // Confirm only on a real success (matches CopyButton's silent-no-op-when-unavailable).
          navigator.clipboard?.writeText(ref)?.then(() => setCopiedRef(ref))?.catch(() => {})
        }
      } else if (e.key === 'Escape') {
        // Progressive back-out: help overlay, blur a field, close the drawer, then clear filters.
        if (showHelp()) setShowHelp(false)
        else if (typing) (el as HTMLElement).blur()
        else if (selectedId()) setSelectedId(null)
        else if (search() || healthFilter() || kindFilter().size > 0) {
          setSearch('')
          setHealthFilter(null)
          setKindFilter(new Set<string>())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

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
  createEffect(() => {
    const c = ctx()
    const ns = namespace()
    reconnectTick() // tracked: a manual reconnect (cycle 291) re-fires the effect
    if (!c || !ns) return
    // Preserve the selection across a resubscribe when the same resource still exists (UIDs are
    // stable), so a manual reconnect keeps the selection. A namespace change naturally clears it:
    // the old UID won't be in the new namespace's graph. untrack so reading the current selection
    // doesn't make this effect re-subscribe on selection.
    const keepSel = untrack(selectedId)
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
    setLiveSummary(null) // previous stream's summary belongs to the previous namespace — clear it
    setCapacity(null) // same: the previous stream's capacity feed belongs to the previous scope
    setConnState('connecting')
    const close = streamGraph(c, ns, {
      snapshot: (g) => {
        // Decide the selection from the snapshot's own nodes BEFORE mutating the store, so this set
        // is authoritative over the reactive deep-link restore below (which would otherwise race and
        // get clobbered): keep the current selection if still present, else adopt a URL deep-link.
        const sel = resolveSelectionOnSnapshot(g.nodes, keepSel, pendingSel)
        if (sel.consumedPending) pendingSel = null
        setGraph(reconcile(fromSnapshot(g)))
        setConnState('live')
        setSelectedId(sel.id)
      },
      patch: (p) => setGraph(reconcile(applyPatch(graph, p))),
      summary: (s) => setLiveSummary(s),
      capacity: (c) => setCapacity(c),
      error: () => setConnState('offline'),
    })
    onCleanup(close)
  })

  const nodes = createMemo(() => Object.values(graph.nodes))
  const edges = createMemo(() => graph.edges)
  // The Nodes view can select a pod that lives only in the cluster-wide capacity feed (another
  // namespace's pod, or any pod while in cluster scope — the namespace graph holds neither). Fall
  // back to the capacity feed so the drawer still opens with the pod's details (its YAML/logs are
  // fetched by namespace/name, which works cross-namespace).
  const capById = createMemo(() => new Map((capacity()?.nodes ?? []).map((n) => [n.id, n])))
  const selectedNode = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    return graph.nodes[id] ?? capById().get(id) ?? null
  })
  // Announce the current selection for assistive tech. j/k stepping deliberately keeps focus on the
  // body (so repeated presses work — see the keydown handler), and the drawer is a complementary
  // landmark, not a live region, so without this a screen-reader operator hears nothing as the
  // selection — and the detail behind it — changes. Mirrors the card tooltip: kind+name, then the
  // status and failure reason, so stepping through a degraded wall speaks each "why" aloud.
  const selectionAnnouncement = createMemo(() => selectionLabel(selectedNode()))
  // Owners present in the current graph, so the drawer can offer "walk up the tree" navigation.
  const ownerNodes = createMemo<KNode[]>(() => {
    const n = selectedNode()
    return (n?.ownerUIDs ?? []).map((id) => graph.nodes[id]).filter((o): o is KNode => !!o)
  })

  // Keep the sidebar entry for the namespace being viewed live from the SSE `summary` event,
  // instead of letting it lag up to 15s behind the /namespaces poll. The server computes summary
  // from the UNFILTERED graph (same as /namespaces), so it never disagrees with the polled
  // value — fixes the old bug where opening a degraded namespace in ownership view "healed" it
  // because the filtered topology omitted the actually-degraded resource (e.g. an endpointless
  // Service that lives in network view).
  const sidebarNamespaces = createMemo(() => {
    const list = namespaceList()
    const ns = namespace()
    const live = liveSummary()
    if (!connected() || !ns || !live) return list
    return list.map((n) => (n.name === ns ? { ...n, health: live.health, nonReady: live.nonReady } : n))
  })

  // Health distribution across the view, kept here for the favicon attention badge. The toolbar's
  // health-filter pills + stripe (moved out of the topbar into the Topology toolbar) derive their
  // own counts from the same node set.
  const counts = createMemo(() => {
    const c: Record<string, number> = {}
    for (const n of nodes()) c[n.health] = (c[n.health] ?? 0) + 1
    return c
  })

  // Favicon attention badge (cycle 286): paint the worst non-Healthy state present in the current
  // view as a colored dot on the brand mark, so multi-tab operators spot trouble without clicking
  // into each tab. Healthy/empty restores the plain mark. Updated via the existing <link rel="icon">
  // element rather than injecting a new one, so the DOM stays clean across HMR reloads in dev.
  createEffect(() => {
    const worst = worstHealth(counts())
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = worst ? faviconDataUrl(worst) : '/favicon.svg'
  })

  return (
    <div class="app">
      <header class="topbar">
        {/* Clickable home: resets grouping + relationships + filters + selection without touching
            the namespace (cycle 290). Operators land on the default "group by relationship,
            ownership only, no spotlight" stance — without hunting for the right controls. */}
        <button
          class="brand"
          type="button"
          title="Reset view (group by relationship, ownership only, no filters)"
          aria-label="Reset to default view"
          onClick={() => {
            setGroupBy('relationship')
            setRelFilter(DEFAULT_RELS())
            setSearch('')
            setHealthFilter(null)
            setKindFilter(new Set<string>())
            setSelectedId(null)
          }}
        >
          {/* Brand mark (cycle 131): a tiny stacked-tier glyph that echoes the ownership tree the
              dashboard draws (a controller over its children). Pure decoration — the "kd" text
              still carries the name — but anchors the topbar so the brand reads as a logo rather
              than a bare lowercase word. */}
          <svg class="brand-mark" viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
            <rect x="5" y="2" width="6" height="2.4" rx="1" />
            <rect x="3" y="6.6" width="10" height="2.4" rx="1" />
            <rect x="1" y="11.2" width="14" height="2.4" rx="1" />
          </svg>
          <span class="brand-text">kd</span>
        </button>
        <ContextSwitcher info={contextsInfo()} current={ctx()} onSelect={setCtx} />
        <Show when={namespace()}>
          {/* Breadcrumb keeps context (which ns + view) visible regardless of where the eye is —
              sidebar highlight only helps when the operator is looking at the sidebar. When the
              cluster pseudo-namespace is active, a server-box icon precedes the text to reinforce
              "this is cluster scope, not a namespace" without requiring the user to read the
              brackets. */}
          <span class="crumb">
            <span class="crumb-sep">›</span>
            <Show when={namespace() === CLUSTER_SCOPE}>
              <svg class="crumb-cluster-icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <rect x="1" y="2.5" width="10" height="7" rx="1" />
                <line x1="1" y1="6" x2="11" y2="6" />
                <circle cx="2.8" cy="4.2" r="0.5" fill="currentColor" />
                <circle cx="2.8" cy="8" r="0.5" fill="currentColor" />
              </svg>
            </Show>
            <span class="crumb-ns" classList={{ 'crumb-ns-cluster': namespace() === CLUSTER_SCOPE }}>
              {namespaceLabel(namespace()!)}
            </span>
          </span>
        </Show>
        <div class="topbar-spacer" />
        {/* The group-by segmented control + relationship/health/kind filters all live together in
            the Topology toolbar now (one control surface on the canvas), so the topbar stays just
            brand · context · breadcrumb · status · theme. */}
        {/* When offline (cycle 291), the conn pill becomes clickable as a manual reconnect:
            EventSource auto-reconnects, but on a long backoff — operators who know the server is
            back shouldn't have to wait it out. role/title shift to reflect the affordance. */}
        <Show
          when={connState() === 'offline'}
          fallback={
            <span
              class="conn"
              classList={{ live: connState() === 'live', connecting: connState() === 'connecting' }}
              role="status"
              aria-live="polite"
              title={
                connState() === 'live'
                  ? 'Live updates via SSE — graph reflects cluster state in real time'
                  : 'Opening the SSE stream to the cluster'
              }
            >
              {connState() === 'live' ? 'live' : 'connecting…'}
            </span>
          }
        >
          <button
            class="conn conn-retry"
            type="button"
            aria-label="Reconnect to the cluster"
            title="No connection to the server. Click to reconnect now."
            onClick={() => setReconnectTick((n) => n + 1)}
          >
            offline · retry
          </button>
        </Show>
        {/* Theme toggle (cycle 301): one button cycles system → light → dark. The glyph names the
            CURRENT mode (auto/sun/moon) and the title spells out what a click switches to, so the
            three-way control stays legible without a dropdown stealing topbar width. */}
        <button
          class="theme-btn"
          type="button"
          onClick={() => setThemePref((p) => nextThemePref(p))}
          title={`Theme: ${themePref()} — click for ${nextThemePref(themePref())}`}
          aria-label={`Theme: ${themePref()}. Click to switch to ${nextThemePref(themePref())}.`}
        >
          <Switch>
            <Match when={themePref() === 'light'}>
              {/* sun */}
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="4.2" />
                <g stroke-linecap="round">
                  <line x1="12" y1="2.5" x2="12" y2="5" />
                  <line x1="12" y1="19" x2="12" y2="21.5" />
                  <line x1="2.5" y1="12" x2="5" y2="12" />
                  <line x1="19" y1="12" x2="21.5" y2="12" />
                  <line x1="5.4" y1="5.4" x2="7.1" y2="7.1" />
                  <line x1="16.9" y1="16.9" x2="18.6" y2="18.6" />
                  <line x1="5.4" y1="18.6" x2="7.1" y2="16.9" />
                  <line x1="16.9" y1="7.1" x2="18.6" y2="5.4" />
                </g>
              </svg>
            </Match>
            <Match when={themePref() === 'dark'}>
              {/* moon */}
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
              </svg>
            </Match>
            <Match when={themePref() === 'system'}>
              {/* auto: half-filled disc reading "follows the OS" */}
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
              </svg>
            </Match>
          </Switch>
        </button>
        <button class="help-btn" onClick={() => setShowHelp((s) => !s)} title="Keyboard shortcuts (?)" aria-label="Show keyboard shortcuts">
          ?
        </button>
      </header>

      <div class="body" classList={{ 'sidebar-collapsed': sidebarHidden() }}>
        <Sidebar
          namespaces={sidebarNamespaces()}
          selected={namespace()}
          onSelect={setNamespace}
          loading={namespaces.loading}
          failed={!!namespaces.error}
          filterRef={(el) => (filterEl = el)}
          onRetry={() => refetchNamespaces()}
          flash={nsFlash()}
          onJumpToTrouble={jumpToTrouble}
        />
        <main class="main">
          <Topology
            nodes={nodes()}
            edges={edges()}
            selectedId={selectedId()}
            healthFilter={healthFilter()}
            kindFilter={kindFilter()}
            onKindFilter={toggleKind}
            onHealthFilter={(h) => setHealthFilter(h)}
            onClearFilters={() => {
              // Same effect as Escape with no selection: reset every filter at once.
              setSearch('')
              setHealthFilter(null)
              setKindFilter(new Set<string>())
            }}
            connected={connected()}
            offline={connState() === 'offline'}
            groupBy={groupBy()}
            onGroupBy={setGroupBy}
            capResource={capResource()}
            onCapResource={setCapResource}
            relFilter={relFilter()}
            onRelFilter={toggleRel}
            scope={`${ctx() ?? ''}/${namespace() ?? ''}`}
            namespace={namespace() ?? ''}
            capacity={capacity()}
            search={search()}
            onSearch={setSearch}
            searchRef={(el) => (searchEl = el)}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
          />
          <DetailDrawer
            ctx={ctx() ?? ''}
            node={selectedNode()}
            owners={ownerNodes()}
            // Owner-chip clicks should push history (cycle 300) so Alt+Left walks back to the
            // descendant the operator came from. The cycle-300 helper pushes the prior selection
            // only when changing to a different node — so re-selecting the same node is a no-op.
            onNavigate={selectAndRemember}
            onNavigateRef={(ref) => {
              const [kind, ...rest] = ref.split('/')
              const name = rest.join('/')
              const match = Object.values(graph.nodes).find((n) => n.kind === kind && n.name === name)
              if (match) selectAndRemember(match.id)
              return !!match
            }}
            canBack={selectionHistory().length > 0}
            onBack={goBackSelection}
            onClose={() => setSelectedId(null)}
            hasPods={(id) => hasDescendantPod(id, nodes())}
          />
        </main>
      </div>

      {/* Always present (not behind a Show) so the live region exists before its text changes —
          a region inserted at the same time as its content doesn't reliably announce. Visually
          hidden; speaks the selection to assistive tech as j/k steps through the graph. */}
      <div class="sr-only" role="status" aria-live="polite">
        {selectionAnnouncement()}
      </div>

      <Show when={copiedRef()}>
        {/* Bottom-center confirmation that the 'y' yank fired. Pure overlay, no input — clicks
            pass through. Auto-fades via the createEffect timer above. */}
        <div class="copy-toast" role="status" aria-live="polite">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <path d="M 1.5 5.5 L 4 8 L 8.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          Copied <code>{copiedRef()}</code>
        </div>
      </Show>

      <Show when={showHelp()}>
        <div class="help-backdrop" onClick={() => setShowHelp(false)}>
          <div class="help-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            {/* Grouped so the overlay reads as a reference card (Navigation / Grouping /
                Relationships / Actions), not a flat undifferentiated list. The grouping modes are
                enumerated with their number keys so "2 groups by node" is discoverable.
                The sections flow into 2 columns on a wide-enough screen (help-sections) so the full
                card fits the viewport without the operator having to discover an internal scroll —
                the bottom sections (Relationships/Actions/Edges) were being cut off below the fold. */}
            <div class="help-sections">
            <section class="help-section">
              <h4>Navigation</h4>
              <ul>
                <li>
                  <kbd>/</kbd> Filter namespaces · <kbd>↑</kbd> <kbd>↓</kbd> step through them (<kbd>Enter</kbd> opens the top match)
                </li>
                <li>
                  <kbd>Alt</kbd>+<kbd>T</kbd> Step to the next troubled namespace (worst first; repeat to cycle through them)
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>K</kbd> / <kbd>Ctrl</kbd><kbd>K</kbd> Search resources in view (<kbd>Enter</kbd> next match · <kbd>Shift</kbd>+<kbd>Enter</kbd> previous)
                  <div class="help-hint">
                    Searches name, kind, status, host, IP, image, and labels. Type
                    {' '}<code>Kind/name</code>{' '} (e.g. <code>po/web-abc</code>) for a structured lookup.
                  </div>
                </li>
                <li>
                  <kbd>j</kbd> <kbd>k</kbd> · <kbd>↓</kbd> <kbd>↑</kbd> Step through resources (troubled first)
                </li>
                <li>
                  <kbd>y</kbd> Copy the selected resource's <code>Kind/name</code> (yank, paste into <code>kubectl</code>)
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>B</kbd> / <kbd>Ctrl</kbd><kbd>B</kbd> Toggle the namespace sidebar
                </li>
                <li>
                  Click owner chip Walk up the ownership tree
                </li>
                <li>
                  <kbd>Alt</kbd>+<kbd>←</kbd> Step back through the drawer's navigation history
                </li>
                <li>
                  <kbd>[</kbd> <kbd>]</kbd> Cycle the drawer's tabs (Logs ↔ Events ↔ Manifest)
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>F</kbd> / <kbd>Ctrl</kbd><kbd>F</kbd> Filter the log lines · <kbd>Shift</kbd>+<kbd>E</kbd> Jump to the next error line
                </li>
                <li>
                  <strong>[cluster]</strong> Pinned sidebar entry — cluster-scoped resources (Nodes, PVs, CRDs, cluster CRs)
                </li>
              </ul>
            </section>
            <section class="help-section">
              <h4>Grouping</h4>
              <ul>
                {/* Surface the grouping hint alongside the number so the overlay teaches what each
                    layout does — same text the tab tooltip uses, visible without hovering. */}
                <For each={GROUP_OPTIONS}>
                  {(g, i) => (
                    <li>
                      <kbd>{i() + 1}</kbd> Group by {g.label} <span class="help-hint">{g.hint}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <section class="help-section">
              <h4>Relationships</h4>
              <ul>
                <li class="help-hint">
                  Toggle which relationships are drawn — they compose, so several can be on at once.
                  Click a relationship chip in the toolbar (<kbd>Shift</kbd>+click solos).
                </li>
                <For each={REL_CATEGORIES}>
                  {(c) => (
                    <li>
                      {c.label} <span class="help-hint">{c.hint}</span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <section class="help-section">
              <h4>Actions</h4>
              <ul>
                <li>
                  <kbd>Esc</kbd> Help → field blur → drawer → clear all filters
                </li>
                <li>
                  <kbd>?</kbd> Toggle this help
                </li>
                <li>Click a legend health Spotlight only those resources</li>
                <li>Click a kind chip Toggle that kind in the filter (multi-select) · <kbd>Shift</kbd>+click solos</li>
                <li><kbd>f</kbd> · double-click canvas Fit the topology to view</li>
                <li><kbd>=</kbd> <kbd>-</kbd> Zoom in / out · <kbd>0</kbd> Reset zoom to 100%</li>
              </ul>
            </section>
            <section class="help-section">
              <h4>Edges</h4>
              {/* Compact legend matching the topology rendering — everything is grey; the only cue is
                  shape, not colour (colour clutters a dense canvas). Solid = ownership backbone;
                  dashed = any non-ownership relationship (refers/selects/mounts/… all read alike —
                  hover an edge to see its kind). Helps a new operator decode the canvas at a glance. */}
              <ul class="help-edges">
                <li>
                  <svg viewBox="0 0 36 10" width="36" height="10" aria-hidden="true">
                    <line x1="0" y1="5" x2="28" y2="5" stroke="var(--edge-color)" stroke-width="2" />
                    <path d="M 28 1.5 L 34 5 L 28 8.5 z" fill="var(--edge-color)" />
                  </svg>
                  Owns (ownerReference) — the controller→child backbone
                </li>
                <li>
                  <svg viewBox="0 0 36 10" width="36" height="10" aria-hidden="true">
                    <line x1="0" y1="5" x2="28" y2="5" stroke="var(--edge-color)" stroke-width="1.4" stroke-dasharray="5 4" />
                    <path d="M 28 1.5 L 34 5 L 28 8.5 z" fill="var(--edge-color)" />
                  </svg>
                  Non-ownership — {nonOwnershipEdgeLabels().join(' / ')}
                </li>
              </ul>
            </section>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
