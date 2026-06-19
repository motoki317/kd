import { createEffect, createMemo, createSignal, lazy, Match, onCleanup, onMount, Show, Suspense, Switch } from 'solid-js'
import { createStore } from 'solid-js/store'
import { CLUSTER_SCOPE } from './api'
import { hasDescendantPod } from './loggable'
import { emptyState, type GraphState } from './graphState'
import { matchSel } from './nav'
import { namespaceLabel } from './ns'
import type { Capacity, Health } from './types'
import { readRawPref, writePref } from './prefs'
import Sidebar from './components/Sidebar'
import Topology from './components/Topology'
// The drawer subtree (manifest viewer, log streamer, usage gauges, kind facts) is interaction-gated:
// it only matters once a node is selected. Splitting it into its own chunk keeps it off the
// render-blocking initial bundle, so first paint ships less JS; it prefetches in the background and
// is ready by the time the operator clicks a card.
const DetailDrawer = lazy(() => import('./components/DetailDrawer'))
import ContextSwitcher from './components/ContextSwitcher'
import { applyTheme, loadThemePref, nextThemePref, saveThemePref, type ThemePref } from './theme'
import { isNarrowScreen, NARROW_SCREEN_QUERY } from './screen'
import { createAppKeyboard } from './appKeyboard'
import { createClusterSession } from './clusterSession'
import { createGraphSubscription } from './graphSubscription'
import { createSelectionDetails } from './selection'
import { createSidebarHealth } from './sidebarHealth'
import { createUrlState, createUrlSync, DEFAULT_RELS } from './urlState'

export default function App() {
  // Where the operator is (ctx/ns) + how the canvas is arranged (group/rels/capRes/orphans/kinds),
  // seeded from the URL with localStorage fallbacks — see urlState.ts.
  const {
    ctx,
    setCtx,
    namespace,
    setNamespace,
    groupBy,
    setGroupBy,
    relFilter,
    setRelFilter,
    toggleRel,
    capResource,
    setCapResource,
    showOrphaned,
    setShowOrphaned,
    kindFilter,
    setKindFilter,
    toggleKind,
    initialSel,
  } = createUrlState()

  // Contexts/namespaces/kinds bootstrap + the connecting/live/offline ladder — see clusterSession.ts.
  const {
    contextsRes,
    refetchContexts,
    contextsInfo,
    authFailed,
    namespaces,
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
  } = createClusterSession({ ctx, setCtx, namespace, setNamespace })

  const [selectedId, setSelectedId] = createSignal<string | null>(null)

  // Navigation history (cycle 300): operators walk owner chips and event-source pills to chase a
  // controller→pod→pod-event trail. Without history, going back means remembering what they had
  // selected — error-prone after a few hops. A stack of prior selection IDs powers a "back"
  // button in the drawer. Cleared on namespace/view/ctx change so we don't restore an
  // ID that no longer exists in the graph.
  const [selectionHistory, setSelectionHistory] = createSignal<string[]>([])
  // selectAndRemember: the path callers should use whenever a click should be reversible. Plain
  // setSelectedId stays for cases that shouldn't push (deselection, URL restoration, arrow-key stepping).
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

  // Clicking a legend health spotlights those nodes (fades the rest); click again to clear.
  const [healthFilter, setHealthFilter] = createSignal<Health | null>(null)
  // Topology search lives here (not in Topology) so it resets on namespace/view change.
  const [search, setSearch] = createSignal('')
  const [showHelp, setShowHelp] = createSignal(false)
  // Collapsible sidebar (cycle 299): operators with wide ownership graphs sometimes want every
  // pixel for the canvas. Toggled from the topbar; state persists in localStorage so a
  // reload doesn't surprise them with the sidebar re-appearing. Default expanded — except on a
  // phone-width screen with no stored pref, where the 220px sidebar would leave a sliver of
  // canvas: there it starts hidden and overlays the topology when opened (see the
  // NARROW_SCREEN_QUERY media blocks in index.css; constants in screen.ts).
  const [sidebarHidden, setSidebarHidden] = createSignal(
    (readRawPref('kd:sidebarHidden') ?? (isNarrowScreen() ? '1' : '0')) === '1',
  )
  createEffect(() => writePref('kd:sidebarHidden', sidebarHidden() ? '1' : '0'))
  // Tunable sidebar width: operators with long namespace names want a wider column; those who want
  // canvas drag it narrow. Persisted (a layout habit, like sidebar-hidden), clamped so a stray drag
  // can't strand the panel off-screen or starve the canvas. Drives the --sidebar-w token on .body
  // (which .sidebar reads), so the existing width rule needs no change.
  const SIDEBAR_MIN = 180
  const SIDEBAR_MAX = 480
  const clampSidebar = (w: number) => Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)))
  const [sidebarWidth, setSidebarWidth] = createSignal(clampSidebar(Number(readRawPref('kd:sidebarWidth')) || 230))
  createEffect(() => writePref('kd:sidebarWidth', String(sidebarWidth())))
  // Drag the divider between the sidebar and canvas. Pointer events (not mouse) so it works under
  // touch/pen; window-level listeners so a fast drag that outruns the 6px handle keeps tracking. The
  // body class suppresses text selection + sets the col-resize cursor for the whole drag.
  const startSidebarResize = (e: PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth()
    const onMove = (ev: PointerEvent) => setSidebarWidth(clampSidebar(startW + (ev.clientX - startX)))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-col')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.classList.add('resizing-col')
  }
  // Tunable drawer (resource-detail panel) width — the mirror of the sidebar resizer on the right
  // edge. Operators reading logs/manifests want a wider panel; those who want canvas drag it narrow.
  // Persisted like the sidebar width; clamped, and capped further by the drawer's max-width:70vw in
  // CSS. Drives the --drawer-w token on .body (which .drawer already reads).
  const DRAWER_MIN = 360
  const DRAWER_MAX = 760
  const DRAWER_DEFAULT = 520
  const clampDrawer = (w: number) => Math.max(DRAWER_MIN, Math.min(DRAWER_MAX, Math.round(w)))
  const [drawerWidth, setDrawerWidth] = createSignal(clampDrawer(Number(readRawPref('kd:drawerWidth')) || DRAWER_DEFAULT))
  createEffect(() => writePref('kd:drawerWidth', String(drawerWidth())))
  // The drawer sits at the right, so it grows LEFTWARD: dragging its left-edge handle left widens it
  // (opposite sign from the sidebar). Same window-level listeners + body class as the sidebar drag.
  const startDrawerResize = (e: PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = drawerWidth()
    const onMove = (ev: PointerEvent) => setDrawerWidth(clampDrawer(startW - (ev.clientX - startX)))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing-col')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.classList.add('resizing-col')
  }
  // REACTIVE phone-width signal for overlay gating (isNarrowScreen is a one-shot read): while the
  // sidebar OVERLAYS the canvas, the covered surface must leave the Tab order (inert below) — a
  // keyboard user tabbing the overlay otherwise lands on invisible toolbar chips under it.
  const [narrowScreen, setNarrowScreen] = createSignal(isNarrowScreen())
  if (typeof matchMedia === 'function') {
    const mq = matchMedia(NARROW_SCREEN_QUERY)
    const onMq = () => setNarrowScreen(mq.matches)
    mq.addEventListener('change', onMq)
    onCleanup(() => mq.removeEventListener('change', onMq))
  }
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
  const [graph, setGraph] = createStore<GraphState>(emptyState())
  // The cluster-wide capacity feed (all Nodes + Pods across every namespace, with live usage) the
  // Nodes group-by draws. Independent of the namespace-scoped graph: a node hosts pods from every
  // namespace, so the view always shows the whole cluster and dims pods outside the selected
  // namespace. Null until the first `capacity` event; cleared on resubscribe.
  const [capacity, setCapacity] = createSignal<Capacity | null>(null)

  const nodes = createMemo(() => Object.values(graph.nodes))
  const edges = createMemo(() => graph.edges)
  // Selection-derived state for the drawer (capacity-feed fallback, live usage, the "deleted"
  // terminal state) — see selection.ts.
  const {
    capById,
    selectedUsage,
    selectedWorkloadUsage,
    selectedHostCapacity,
    selectionAnnouncement,
    drawerNode,
    selectionDeleted,
  } = createSelectionDetails({ selectedId, graph, capacity, nodes })

  // Keep the lazy drawer subtree off the render-blocking initial load: don't mount it (and thus
  // don't fetch its chunk) until either a node is selected or the browser goes idle after first
  // paint. The flag latches true and never flips back, so once mounted the drawer STAYS mounted —
  // its slide-out animation depends on the node lingering through unmount, which a bare
  // `Show when={selected}` would cut short. Idle-prefetch means it's ready before the first click.
  const [drawerMounted, setDrawerMounted] = createSignal(false)
  onMount(() => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
    if (ric) ric(() => setDrawerMounted(true))
    else setTimeout(() => setDrawerMounted(true), 200)
  })

  // A URL-seeded "Kind/name" selection to restore once its node appears in the graph (UIDs aren't
  // stable across reloads, so we key the link on the stable identity).
  let pendingSel = initialSel

  // Mirror the view state back into the URL (replace, not push) — see urlState.ts.
  createUrlSync({ ctx, contextsInfo, namespace, groupBy, relFilter, capResource, showOrphaned, kindFilter, selectedId, graph, capById })

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

  // Restore a URL-seeded selection once its node arrives (then stop tracking). Search the namespace
  // graph first, then the cluster-wide capacity feed — a Nodes-view deep-link can name a pod that lives
  // only in capById (the cluster-scope Nodes case), which the graph snapshot never holds.
  createEffect(() => {
    if (!pendingSel) return
    const match =
      Object.values(graph.nodes).find((n) => matchSel(n, pendingSel!)) ??
      [...capById().values()].find((n) => matchSel(n, pendingSel!))
    if (match) {
      setSelectedId(match.id)
      pendingSel = null
    }
  })

  // The SSE graph feed: (re)subscribes on ctx/ns change and applies snapshot/patch/summary/capacity
  // events — see graphSubscription.ts.
  const { setReconnectTick } = createGraphSubscription({
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
    pendingSel: () => pendingSel,
    clearPendingSel: () => {
      pendingSel = null
    },
  })

  // Sidebar rows reconciled from the merged poll+live health + the favicon attention badge — see sidebarHealth.ts.
  const { sidebarNs } = createSidebarHealth({ mergedNamespaces })

  // Global keyboard shortcuts (returns the ref-setter for the search box "/" focuses) — see
  // appKeyboard.ts. Deliberately four bindings; everything else is click-driven.
  const { searchRef } = createAppKeyboard({
    nodes,
    search,
    setSearch,
    healthFilter,
    setHealthFilter,
    kindFilter,
    setKindFilter,
    selectedId,
    setSelectedId,
    showHelp,
    setShowHelp,
  })

  return (
    <div class="app">
      <header class="topbar">
        {/* Clickable home: resets grouping + relationships + filters + selection without touching
            the namespace (cycle 290). Operators land on the default "group by relationship,
            ownership only, no spotlight" stance — without hunting for the right controls. */}
        {/* Sidebar toggle: the only way to reclaim (or restore) the namespace column. Far left,
            directly above the panel it controls (proximity); shares the topbar-utility chrome. */}
        <button
          class="sidebar-btn"
          type="button"
          aria-expanded={!sidebarHidden()}
          aria-controls="ns-sidebar"
          title={sidebarHidden() ? 'Show the namespace sidebar' : 'Hide the namespace sidebar'}
          aria-label={sidebarHidden() ? 'Show the namespace sidebar' : 'Hide the namespace sidebar'}
          onClick={() => setSidebarHidden((v) => !v)}
        >
          {/* panel-left glyph: frame + divider marking the column being toggled */}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="2" />
            <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
          </svg>
        </button>
        <button
          class="brand"
          type="button"
          title="Reset to the default view"
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
            back shouldn't have to wait it out. role/title shift to reflect the affordance.
            Hidden entirely in the no-access / not-signed-in states: with no namespace there is no
            stream for the pill to describe, and "connecting…" would promise progress that can
            never come. */}
        <Show when={!noNamespaces() && !authFailed()}>
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
                  ? 'Live — the view updates as the cluster changes'
                  : 'Connecting to the cluster'
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
            title="Offline — click to reconnect"
            onClick={() => {
              // With no namespace (the list itself failed) the subscribe effect has nothing to
              // re-run against — retry the failed bootstrap fetches too, so one button serves
              // every failure class.
              if (contextsRes.error) void refetchContexts()
              if (namespaces.error) void refetchNamespaces()
              setReconnectTick((n) => n + 1)
            }}
          >
            offline · retry
          </button>
        </Show>
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

      {/* A sibling of the topbar, NOT a child: inside the header's flex row a full-width strip
          collapses the items beside it (the zero-basis flex-wrap trap). role=status so screen
          readers hear the silent redirect too. */}
      <Show when={nsNotice()}>
        <div class="ns-notice" role="status">
          {nsNotice()}
          <button class="ns-notice-close" aria-label="Dismiss" onClick={() => setNsNotice(null)}>
            ×
          </button>
        </div>
      </Show>

      <div class="body" classList={{ 'sidebar-collapsed': sidebarHidden() }} style={{ '--sidebar-w': `${sidebarWidth()}px`, '--drawer-w': `${drawerWidth()}px` }}>
        <Sidebar
          namespaces={sidebarNs}
          selected={namespace()}
          onSelect={(name) => {
            setNamespace(name)
            // A phone-width sidebar overlays the canvas, so picking a namespace dismisses it —
            // the operator's next move is reading the topology it was covering.
            if (isNarrowScreen()) setSidebarHidden(true)
          }}
          loading={namespaces.loading}
          failed={!!namespaces.error}
          onRetry={() => refetchNamespaces()}
          flash={nsFlash()}
          onJumpToTrouble={jumpToTrouble}
        />
        {/* Drag handle to retune the sidebar width. A focusable separator (WAI-ARIA window-splitter
            model) so the column is resizable by keyboard too — ←/→ nudge, Home/End jump to the
            min/max — keeping the four GLOBAL shortcuts intact (these are scoped to the handle, like
            the tablist arrows). Hidden when the sidebar is collapsed or overlaying (phone width). */}
        <Show when={!sidebarHidden()}>
          <div
            class="sidebar-resizer"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            aria-label="Resize the namespace sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth()}
            onPointerDown={startSidebarResize}
            onDblClick={() => setSidebarWidth(230)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 32 : 8
              if (e.key === 'ArrowLeft') { e.preventDefault(); setSidebarWidth((w) => clampSidebar(w - step)) }
              else if (e.key === 'ArrowRight') { e.preventDefault(); setSidebarWidth((w) => clampSidebar(w + step)) }
              else if (e.key === 'Home') { e.preventDefault(); setSidebarWidth(SIDEBAR_MIN) }
              else if (e.key === 'End') { e.preventDefault(); setSidebarWidth(SIDEBAR_MAX) }
            }}
          />
        </Show>
        {/* While the sidebar OVERLAYS the canvas (phone width), everything under it leaves the Tab
            order — without inert, a keyboard user tabbing the overlay lands on invisible toolbar
            chips beneath it. Desktop side-by-side keeps both surfaces interactive. */}
        <main class="main" inert={narrowScreen() && !sidebarHidden()}>
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
            noAccess={noNamespaces()}
            authFailed={authFailed()}
            // The active context's cache-build error (expired credentials, unreachable API) — the
            // diagnosis behind an offline state. Without it the empty-state's "use retry" sends an
            // operator with an expired SSO session into a retry loop; the reason ("getting
            // credentials: exec…") names the actual fix. Only the switcher's disabled-option
            // tooltip carried it before, which native selects barely surface.
            offlineReason={contextsInfo()?.contexts.find((c) => c.name === ctx())?.error}
            groupBy={groupBy()}
            onGroupBy={setGroupBy}
            capResource={capResource()}
            onCapResource={setCapResource}
            relFilter={relFilter()}
            onRelFilter={toggleRel}
            showOrphaned={showOrphaned()}
            onShowOrphaned={setShowOrphaned}
            scope={`${ctx() ?? ''}/${namespace() ?? ''}`}
            namespace={namespace() ?? ''}
            capacity={capacity()}
            search={search()}
            onSearch={setSearch}
            searchRef={searchRef}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
          />
          <Show when={drawerMounted() || drawerNode()}>
          <Suspense>
          <DetailDrawer
            ctx={ctx() ?? ''}
            node={drawerNode()}
            deleted={selectionDeleted()}
            usage={selectedUsage()}
            workloadUsage={selectedWorkloadUsage()}
            hostCapacity={selectedHostCapacity()}
            // A cross-reference jump (cycle 300) pushes history so the drawer back button walks back to
            // the resource the operator came from. The cycle-300 helper pushes the prior selection only
            // when changing to a different node — so re-selecting the same node is a no-op.
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
            resizeWidth={drawerWidth()}
            resizeMin={DRAWER_MIN}
            resizeMax={DRAWER_MAX}
            onResizeStart={startDrawerResize}
            onResizeTo={(w) => setDrawerWidth(clampDrawer(w))}
            onResizeReset={() => setDrawerWidth(DRAWER_DEFAULT)}
          />
          </Suspense>
          </Show>
        </main>
      </div>

      {/* Always present (not behind a Show) so the live region exists before its text changes —
          a region inserted at the same time as its content doesn't reliably announce. Visually
          hidden; speaks the selection to assistive tech as j/k steps through the graph. */}
      <div class="sr-only" role="status" aria-live="polite">
        {selectionAnnouncement()}
      </div>

      <Show when={showHelp()}>
        <div class="help-backdrop" onClick={() => setShowHelp(false)}>
          <div class="help-panel" role="dialog" aria-label="Help" onClick={(e) => e.stopPropagation()}>
            {/* Deliberately tiny: the four keys and the edge legend, one column, no internal
                scroll. Everything else in kd is a visible, clickable control — if this card ever
                needs columns or sections again, the key surface has regrown past what an operator
                can hold in their head (see appKeyboard.ts). */}
            <h3>Keyboard</h3>
            <ul class="help-keys">
              <li>
                <span class="help-key"><kbd>/</kbd></span> Search resources
              </li>
              <li>
                <span class="help-key"><kbd>↓</kbd> <kbd>↑</kbd></span> Step through resources, troubled first
              </li>
              <li>
                <span class="help-key"><kbd>Esc</kbd></span> Back out — close, then clear filters
              </li>
              <li>
                <span class="help-key"><kbd>?</kbd></span> This help
              </li>
            </ul>
            <h3>Lines on the map</h3>
            {/* Legend matching the topology rendering — the only cue is shape, not colour. Solid =
                ownership backbone; dashed = any other relationship (hover an edge for its kind). */}
            <ul class="help-edges">
              <li>
                <svg viewBox="0 0 36 10" width="36" height="10" aria-hidden="true">
                  <line x1="0" y1="5" x2="28" y2="5" stroke="var(--edge-color)" stroke-width="2" />
                  <path d="M 28 1.5 L 34 5 L 28 8.5 z" fill="var(--edge-color)" />
                </svg>
                Owns — a controller and what it manages
              </li>
              <li>
                <svg viewBox="0 0 36 10" width="36" height="10" aria-hidden="true">
                  <line x1="0" y1="5" x2="28" y2="5" stroke="var(--edge-color)" stroke-width="1.4" stroke-dasharray="5 4" />
                  <path d="M 28 1.5 L 34 5 L 28 8.5 z" fill="var(--edge-color)" />
                </svg>
                Any other link — hover an edge to see which
              </li>
            </ul>
          </div>
        </div>
      </Show>
    </div>
  )
}
