import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { fetchContexts, fetchNamespaces, streamGraph } from './api'
import { applyPatch, emptyState, fromSnapshot, type GraphState } from './graphState'
import { HEALTH_ORDER, healthColor, rollupHealth } from './health'
import { navCandidates, nextSelection, resolveSelectionOnSnapshot } from './nav'
import { mostTroubled } from './ns'
import type { Health, KNode, View } from './types'
import Sidebar from './components/Sidebar'
import Topology from './components/Topology'
import DetailDrawer from './components/DetailDrawer'
import ContextSwitcher from './components/ContextSwitcher'

// Each view is a relationship lens the user explicitly asked for. 'All' is the kind-grouped
// catch-all (FR-006): every node lays out in per-kind boxes, ownership edges still drawn —
// the readable replacement for the previously-removed hairball, important once CRs (which
// have no edges to the workload kinds) enter the picture.
const VIEWS: { id: View; label: string }[] = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'network', label: 'Network' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'rbac', label: 'RBAC' },
  { id: 'all', label: 'All' },
]

export default function App() {
  // The contexts list drives the topbar switcher (FR-005) and the default context the URL falls back
  // to (FR-004). It loads once on mount; the kubeconfig is snapshot at server start so a poll would
  // never change the set.
  const [contextsRes] = createResource(fetchContexts)
  const contextsInfo = createMemo(() => (contextsRes.error ? null : contextsRes() ?? null))
  // Seed namespace/view/ctx from the URL so a link or reload restores the same place.
  const params = new URLSearchParams(location.search)
  const urlView = params.get('view') as View
  const [ctx, setCtx] = createSignal<string | null>(params.get('ctx'))
  const [namespace, setNamespace] = createSignal<string | null>(params.get('ns'))
  const [view, setView] = createSignal<View>(VIEWS.some((v) => v.id === urlView) ? urlView : 'ownership')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)

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
  // Topology search lives here (not in Topology) so it resets on namespace/view change.
  const [search, setSearch] = createSignal('')
  const [showHelp, setShowHelp] = createSignal(false)

  const [graph, setGraph] = createStore<GraphState>(emptyState())

  // Pick a namespace once the list loads: keep a valid URL-seeded one, else open the most troubled
  // one (the sidebar's top item), so kd lands on "what's wrong" rather than the alphabetical first —
  // and a stale/forbidden ?ns= doesn't strand the user on an empty graph.
  createEffect(() => {
    const list = namespaceList()
    if (list.length === 0) return
    if (!list.some((n) => n.name === namespace())) setNamespace(mostTroubled(list)!.name)
  })

  // Mirror ctx/namespace/view/selection back into the URL (replace, not push, so Back isn't spammed).
  // ctx is included only when the switcher is enabled (kubeconfig mode); in-cluster keeps URLs clean.
  createEffect(() => {
    const p = new URLSearchParams()
    if (ctx() && contextsInfo()?.enabled) p.set('ctx', ctx()!)
    if (namespace()) p.set('ns', namespace()!)
    p.set('view', view())
    const id = selectedId()
    const n = id ? graph.nodes[id] : null
    if (n) p.set('sel', `${n.kind}/${n.name}`)
    history.replaceState(null, '', `${location.pathname}?${p}`)
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

  // Global keys: "/" jumps to the namespace filter, Escape backs out (blur a field, else close the
  // drawer) — the muscle-memory shortcuts operators expect, with no on-screen chrome.
  let filterEl: HTMLInputElement | undefined
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const num = Number(e.key)
      if (e.key === '?' && !typing) {
        setShowHelp((s) => !s)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        filterEl?.focus()
      } else if (!typing && num >= 1 && num <= VIEWS.length) {
        setView(VIEWS[num - 1].id) // 1-5: Ownership / Network / Nodes / Volumes / RBAC
      } else if (!typing && (e.key === 'j' || e.key === 'ArrowDown')) {
        // Walk selection through the graph, troubled-first, so stepping surfaces problems before
        // healthy nodes. Scoped to the active search/health filter so stepping visits only what's
        // spotlighted. The selection drives the drawer and the topology's pan-to-selection.
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter())
        setSelectedId((cur) => nextSelection(cand, cur, 1) ?? cur)
      } else if (!typing && (e.key === 'k' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter())
        setSelectedId((cur) => nextSelection(cand, cur, -1) ?? cur)
      } else if (e.key === 'Escape') {
        // Progressive back-out: help overlay, blur a field, close the drawer, then clear filters.
        if (showHelp()) setShowHelp(false)
        else if (typing) (el as HTMLElement).blur()
        else if (selectedId()) setSelectedId(null)
        else if (search() || healthFilter()) {
          setSearch('')
          setHealthFilter(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  // (Re)subscribe to the graph feed whenever the context, namespace, or view changes. A context
  // switch closes the old SSE stream and opens a fresh one against the new cluster's cache.
  createEffect(() => {
    const c = ctx()
    const ns = namespace()
    const v = view()
    if (!c || !ns) return
    // Preserve the selection across a view switch when the same resource exists in the new view
    // (UIDs are stable across views), so "look at pod X, switch to Volumes" keeps X selected. A
    // namespace change naturally clears it: the old UID won't be in the new namespace's graph.
    // untrack so reading the current selection doesn't make this effect re-subscribe on selection.
    const keepSel = untrack(selectedId)
    setSearch('') // a stale search/health filter would fade the whole new graph
    setHealthFilter(null)
    setGraph(reconcile(emptyState()))
    setConnState('connecting')
    const close = streamGraph(c, ns, v, {
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
      error: () => setConnState('offline'),
    })
    onCleanup(close)
  })

  const nodes = createMemo(() => Object.values(graph.nodes))
  const edges = createMemo(() => graph.edges)
  const selectedNode = createMemo(() => (selectedId() ? graph.nodes[selectedId()!] ?? null : null))
  // Owners present in the current graph, so the drawer can offer "walk up the tree" navigation.
  const ownerNodes = createMemo<KNode[]>(() => {
    const n = selectedNode()
    return (n?.ownerUIDs ?? []).map((id) => graph.nodes[id]).filter((o): o is KNode => !!o)
  })

  // Keep the sidebar entry for the namespace being viewed live from the streamed graph, instead of
  // letting it lag up to 15s behind the /namespaces poll. Only override once the graph has loaded, so
  // a still-empty stream doesn't briefly flash the namespace healthy.
  const sidebarNamespaces = createMemo(() => {
    const list = namespaceList()
    const ns = namespace()
    if (!connected() || !ns || nodes().length === 0) return list
    // Exclude cluster-scoped resources (the shared Node, ClusterRoles): they ride along in every
    // namespace's graph but aren't this namespace's health — mirrors the server's Summarize.
    const live = rollupHealth(nodes().filter((n) => n.namespace))
    return list.map((n) => (n.name === ns ? { ...n, health: live.health, nonReady: live.nonReady } : n))
  })

  const counts = createMemo(() => {
    const c: Record<string, number> = {}
    for (const n of nodes()) c[n.health] = (c[n.health] ?? 0) + 1
    return c
  })
  // Only surface health states actually present, so the legend stays a quiet summary until
  // something needs attention rather than a row of zeros.
  const shownHealth = createMemo(() => HEALTH_ORDER.filter((h) => counts()[h]))

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
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
        </div>
        <ContextSwitcher info={contextsInfo()} current={ctx()} onSelect={setCtx} />
        <Show when={namespace()}>
          {/* Breadcrumb keeps context (which ns + view) visible regardless of where the eye is —
              sidebar highlight only helps when the operator is looking at the sidebar. */}
          <span class="crumb">
            <span class="crumb-sep">›</span>
            <span class="crumb-ns">{namespace()}</span>
          </span>
        </Show>
        <div class="topbar-spacer" />
        <div class="views">
          <For each={VIEWS}>
            {(v) => (
              <button classList={{ active: v.id === view() }} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            )}
          </For>
        </div>
        <div class="legend">
          <For each={shownHealth()}>
            {(h) => (
              <button
                class="legend-item"
                classList={{ active: healthFilter() === h }}
                // Active pill borrows the health hue for its border + background tint, so the
                // visual connection to "spotlighting THIS color" is explicit (vs a neutral grey
                // active pill that loses the link to the health it represents).
                style={
                  healthFilter() === h
                    ? {
                        'border-color': healthColor(h),
                        background: `color-mix(in srgb, ${healthColor(h)} 14%, transparent)`,
                        color: 'var(--text)',
                      }
                    : undefined
                }
                onClick={() => setHealthFilter((cur) => (cur === h ? null : h))}
                title={`Spotlight ${h} resources`}
              >
                <span class="dot" style={{ background: healthColor(h) }} />
                {h}
                <span class="legend-count">{counts()[h]}</span>
              </button>
            )}
          </For>
        </div>
        <span class="conn" classList={{ live: connState() === 'live', connecting: connState() === 'connecting' }}>
          {connState() === 'live' ? 'live' : connState() === 'connecting' ? 'connecting…' : 'offline'}
        </span>
        <button class="help-btn" onClick={() => setShowHelp((s) => !s)} title="Keyboard shortcuts (?)">
          ?
        </button>
        {/* Health-distribution stripe (cycle 132): a 3px bar along the bottom edge of the topbar
            with one segment per present health state, sized in proportion. Reads as a quick
            answer to "what's the cluster doing right now?" — a sliver of red on a sea of green
            telegraphs the same idea the legend pills do, but without needing to read numbers. */}
        <Show when={shownHealth().length > 0}>
          <div class="topbar-stripe" aria-hidden="true">
            <For each={shownHealth()}>
              {(h) => (
                <span
                  style={{ flex: counts()[h], 'background-color': healthColor(h) }}
                  title={`${h}: ${counts()[h]}`}
                />
              )}
            </For>
          </div>
        </Show>
      </header>

      <div class="body">
        <Sidebar
          namespaces={sidebarNamespaces()}
          selected={namespace()}
          onSelect={setNamespace}
          loading={namespaces.loading}
          failed={!!namespaces.error}
          filterRef={(el) => (filterEl = el)}
        />
        <main class="main">
          <Topology
            nodes={nodes()}
            edges={edges()}
            selectedId={selectedId()}
            healthFilter={healthFilter()}
            connected={connected()}
            viewLabel={VIEWS.find((v) => v.id === view())?.label ?? view()}
            viewId={view()}
            search={search()}
            onSearch={setSearch}
            onSelect={setSelectedId}
            onDeselect={() => setSelectedId(null)}
          />
          <DetailDrawer
            ctx={ctx() ?? ''}
            node={selectedNode()}
            owners={ownerNodes()}
            onNavigate={setSelectedId}
            onNavigateRef={(ref) => {
              const [kind, ...rest] = ref.split('/')
              const name = rest.join('/')
              const match = Object.values(graph.nodes).find((n) => n.kind === kind && n.name === name)
              if (match) setSelectedId(match.id)
              return !!match
            }}
            onClose={() => setSelectedId(null)}
          />
        </main>
      </div>

      <Show when={showHelp()}>
        <div class="help-backdrop" onClick={() => setShowHelp(false)}>
          <div class="help-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            {/* Grouped so the overlay reads as a reference card (Navigation / Views / Actions),
                not a flat undifferentiated list. Each VIEWS entry is enumerated explicitly so
                "5 jumps to RBAC" is discoverable without counting tabs. */}
            <section class="help-section">
              <h4>Navigation</h4>
              <ul>
                <li>
                  <kbd>/</kbd> Filter namespaces
                </li>
                <li>
                  <kbd>j</kbd> <kbd>k</kbd> · <kbd>↓</kbd> <kbd>↑</kbd> Step through resources (troubled first)
                </li>
                <li>
                  Click owner chip Walk up the ownership tree
                </li>
              </ul>
            </section>
            <section class="help-section">
              <h4>Views</h4>
              <ul>
                <For each={VIEWS}>
                  {(v, i) => (
                    <li>
                      <kbd>{i() + 1}</kbd> {v.label}
                    </li>
                  )}
                </For>
              </ul>
            </section>
            <section class="help-section">
              <h4>Actions</h4>
              <ul>
                <li>
                  <kbd>Esc</kbd> Help → field blur → drawer → clear search / health filter
                </li>
                <li>
                  <kbd>?</kbd> Toggle this help
                </li>
                <li>Click a legend health Spotlight only those resources</li>
              </ul>
            </section>
          </div>
        </div>
      </Show>
    </div>
  )
}
