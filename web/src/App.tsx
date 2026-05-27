import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { fetchNamespaces, streamGraph } from './api'
import { applyPatch, emptyState, fromSnapshot, type GraphState } from './graphState'
import { HEALTH_ORDER, healthColor } from './health'
import type { Health, KNode, View } from './types'
import Sidebar from './components/Sidebar'
import Topology from './components/Topology'
import DetailDrawer from './components/DetailDrawer'

// Each view is a relationship lens the user explicitly asked for. There is no "everything at
// once" view on purpose: a whole-namespace hairball is the opposite of reading state at a glance.
const VIEWS: { id: View; label: string }[] = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'network', label: 'Network' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'rbac', label: 'RBAC' },
]

export default function App() {
  const [namespaces, { refetch: refetchNamespaces }] = createResource(fetchNamespaces)
  // Seed namespace/view from the URL so a link or reload restores the same place.
  const params = new URLSearchParams(location.search)
  const urlView = params.get('view') as View
  const [namespace, setNamespace] = createSignal<string | null>(params.get('ns'))
  const [view, setView] = createSignal<View>(VIEWS.some((v) => v.id === urlView) ? urlView : 'ownership')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  // A URL-seeded "Kind/name" selection to restore once its node appears in the graph (UIDs aren't
  // stable across reloads, so we key the link on the stable identity).
  let pendingSel = params.get('sel')
  const [connected, setConnected] = createSignal(false)
  // Clicking a legend health spotlights those nodes (fades the rest); click again to clear.
  const [healthFilter, setHealthFilter] = createSignal<Health | null>(null)
  // Topology search lives here (not in Topology) so it resets on namespace/view change.
  const [search, setSearch] = createSignal('')

  const [graph, setGraph] = createStore<GraphState>(emptyState())

  // Pick a namespace once the list loads: keep a valid URL-seeded one, else fall back to the first
  // (so a stale/forbidden ?ns= doesn't strand the user on an empty graph).
  createEffect(() => {
    const list = namespaces()
    if (!list || list.length === 0) return
    if (!list.some((n) => n.name === namespace())) setNamespace(list[0].name)
  })

  // Mirror namespace/view/selection back into the URL (replace, not push, so Back isn't spammed).
  createEffect(() => {
    const p = new URLSearchParams()
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
      if (e.key === '/' && !typing) {
        e.preventDefault()
        filterEl?.focus()
      } else if (e.key === 'Escape') {
        // Progressive back-out: blur a field, else close the drawer, else clear active filters.
        if (typing) (el as HTMLElement).blur()
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

  // (Re)subscribe to the graph feed whenever the namespace or view changes.
  createEffect(() => {
    const ns = namespace()
    const v = view()
    if (!ns) return
    setSelectedId(null)
    setSearch('') // a stale search/health filter would fade the whole new graph
    setHealthFilter(null)
    setGraph(reconcile(emptyState()))
    setConnected(false)
    const close = streamGraph(ns, v, {
      snapshot: (g) => {
        setGraph(reconcile(fromSnapshot(g)))
        setConnected(true)
      },
      patch: (p) => setGraph(reconcile(applyPatch(graph, p))),
      error: () => setConnected(false),
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
        <div class="brand">kd</div>
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
        <span class="conn" classList={{ live: connected() }}>
          {connected() ? 'live' : 'offline'}
        </span>
      </header>

      <div class="body">
        <Sidebar
          namespaces={namespaces() ?? []}
          selected={namespace()}
          onSelect={setNamespace}
          loading={namespaces.loading}
          filterRef={(el) => (filterEl = el)}
        />
        <main class="main">
          <Topology
            nodes={nodes()}
            edges={edges()}
            selectedId={selectedId()}
            healthFilter={healthFilter()}
            connected={connected()}
            search={search()}
            onSearch={setSearch}
            onSelect={setSelectedId}
          />
          <DetailDrawer node={selectedNode()} owners={ownerNodes()} onNavigate={setSelectedId} onClose={() => setSelectedId(null)} />
        </main>
      </div>
    </div>
  )
}
