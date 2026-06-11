import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from 'solid-js'
import { createStore } from 'solid-js/store'
import { CLUSTER_SCOPE, type NamespaceSummary } from './api'
import { hasDescendantPod } from './loggable'
import { emptyState, type GraphState } from './graphState'
import { matchSel } from './nav'
import { namespaceLabel } from './ns'
import type { Capacity, Health } from './types'
import { REL_CATEGORIES } from './relationships'
import { nonOwnershipEdgeLabels } from './edgeRender'
import { readRawPref, writePref } from './prefs'
import Sidebar from './components/Sidebar'
import Topology, { GROUP_OPTIONS } from './components/Topology'
import DetailDrawer from './components/DetailDrawer'
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
    namespaceList,
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

  // Clicking a legend health spotlights those nodes (fades the rest); click again to clear.
  const [healthFilter, setHealthFilter] = createSignal<Health | null>(null)
  // Topology search lives here (not in Topology) so it resets on namespace/view change.
  const [search, setSearch] = createSignal('')
  const [showHelp, setShowHelp] = createSignal(false)
  // Collapsible sidebar (cycle 299): operators with wide ownership graphs sometimes want every
  // pixel for the canvas. Cmd/Ctrl+B or the topbar toggle; state persists in localStorage so a
  // reload doesn't surprise them with the sidebar re-appearing. Default expanded — except on a
  // phone-width screen with no stored pref, where the 220px sidebar would leave a sliver of
  // canvas: there it starts hidden and overlays the topology when opened (see the
  // NARROW_SCREEN_QUERY media blocks in index.css; constants in screen.ts).
  const [sidebarHidden, setSidebarHidden] = createSignal(
    (readRawPref('kd:sidebarHidden') ?? (isNarrowScreen() ? '1' : '0')) === '1',
  )
  createEffect(() => writePref('kd:sidebarHidden', sidebarHidden() ? '1' : '0'))
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

  const nodes = createMemo(() => Object.values(graph.nodes))
  const edges = createMemo(() => graph.edges)
  // Selection-derived state for the drawer (capacity-feed fallback, live usage, the "deleted"
  // terminal state, owner chips) — see selection.ts.
  const {
    capById,
    selectedUsage,
    selectedWorkloadUsage,
    selectedHostCapacity,
    selectionAnnouncement,
    drawerNode,
    selectionDeleted,
    ownerNodes,
  } = createSelectionDetails({ selectedId, graph, capacity, nodes })

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
    setLiveSummary,
    setCapacity,
    connState,
    setConnState,
    refetchContexts,
    pendingSel: () => pendingSel,
    clearPendingSel: () => {
      pendingSel = null
    },
  })

  // Sidebar rows kept live from the SSE summary + the favicon attention badge — see sidebarHealth.ts.
  const { sidebarNs } = createSidebarHealth({ namespaceList, namespace, liveSummary, connected })

  // Global keyboard shortcuts (returns the ref-setters for the inputs they focus) — see appKeyboard.ts.
  const { filterRef, searchRef } = createAppKeyboard({
    nodes,
    search,
    setSearch,
    healthFilter,
    setHealthFilter,
    kindFilter,
    setKindFilter,
    selectedId,
    setSelectedId,
    graph,
    setGroupBy,
    setSidebarHidden,
    showHelp,
    setShowHelp,
    setCopiedRef,
    goBackSelection,
    jumpToTrouble,
  })

  return (
    <div class="app">
      <header class="topbar">
        {/* Clickable home: resets grouping + relationships + filters + selection without touching
            the namespace (cycle 290). Operators land on the default "group by relationship,
            ownership only, no spotlight" stance — without hunting for the right controls. */}
        {/* Sidebar toggle: the pointer/touch counterpart of Cmd/Ctrl+B — without it, phones and
            mice had no way to reclaim (or restore) the namespace column. Far left, directly above
            the panel it controls (proximity); shares the round topbar-utility chrome. */}
        <button
          class="sidebar-btn"
          type="button"
          aria-expanded={!sidebarHidden()}
          aria-controls="ns-sidebar"
          title={sidebarHidden() ? 'Show the namespace sidebar (Ctrl/⌘+B)' : 'Hide the namespace sidebar (Ctrl/⌘+B)'}
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

      <div class="body" classList={{ 'sidebar-collapsed': sidebarHidden() }}>
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
          filterRef={filterRef}
          onRetry={() => refetchNamespaces()}
          flash={nsFlash()}
          onJumpToTrouble={jumpToTrouble}
        />
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
          <DetailDrawer
            ctx={ctx() ?? ''}
            node={drawerNode()}
            deleted={selectionDeleted()}
            owners={ownerNodes()}
            usage={selectedUsage()}
            workloadUsage={selectedWorkloadUsage()}
            hostCapacity={selectedHostCapacity()}
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
                  <kbd>Alt</kbd>+<kbd>T</kbd> Next troubled namespace (worst first)
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>K</kbd> / <kbd>Ctrl</kbd><kbd>K</kbd> Search resources in view (<kbd>Enter</kbd> next match · <kbd>Shift</kbd>+<kbd>Enter</kbd> previous)
                  <div class="help-hint">
                    Matches name, kind, status, IP, image, and labels. <code>po/web-abc</code> finds one kind.
                  </div>
                </li>
                <li>
                  <kbd>j</kbd> <kbd>k</kbd> · <kbd>↓</kbd> <kbd>↑</kbd> Step through resources (troubled first)
                </li>
                <li>
                  <kbd>y</kbd> Copy the selection as <code>Kind/name</code> for <code>kubectl</code>
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>B</kbd> / <kbd>Ctrl</kbd><kbd>B</kbd> Toggle the namespace sidebar
                </li>
                <li>
                  Click an owner chip to open the owner
                </li>
                <li>
                  <kbd>Alt</kbd>+<kbd>←</kbd> Back to the previously viewed resource
                </li>
                <li>
                  <kbd>[</kbd> <kbd>]</kbd> Cycle the drawer's tabs (Logs ↔ Events ↔ Manifest)
                </li>
                <li>
                  <kbd>⌘</kbd><kbd>F</kbd> / <kbd>Ctrl</kbd><kbd>F</kbd> Find in logs / manifest · <kbd>Shift</kbd>+<kbd>E</kbd> next error line
                </li>
                <li>
                  <strong>[cluster]</strong> Cluster-wide resources (Nodes, PVs, CRDs)
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
                  Chips in the toolbar toggle each relationship; several can be on at once.
                  <kbd>Shift</kbd>+click shows only one.
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
                  <kbd>Esc</kbd> Closes one layer per press: help, typing focus, drawer, then filters
                </li>
                <li>
                  <kbd>?</kbd> Toggle this help
                </li>
                <li>Click a health pill to spotlight those resources</li>
                <li>Click a kind chip to filter by it · <kbd>Shift</kbd>+click shows only it</li>
                <li><kbd>f</kbd> or double-click the canvas to fit everything in view</li>
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
                  Owns — a controller and what it manages
                </li>
                <li>
                  <svg viewBox="0 0 36 10" width="36" height="10" aria-hidden="true">
                    <line x1="0" y1="5" x2="28" y2="5" stroke="var(--edge-color)" stroke-width="1.4" stroke-dasharray="5 4" />
                    <path d="M 28 1.5 L 34 5 L 28 8.5 z" fill="var(--edge-color)" />
                  </svg>
                  Other links — {nonOwnershipEdgeLabels().join(', ')}
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
