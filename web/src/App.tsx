import { createEffect, createMemo, createResource, createSignal, For, onCleanup } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { fetchNamespaces, streamGraph } from './api'
import { applyPatch, emptyState, fromSnapshot, type GraphState } from './graphState'
import { HEALTH_ORDER, healthColor } from './health'
import type { View } from './types'
import Sidebar from './components/Sidebar'
import Topology from './components/Topology'
import DetailDrawer from './components/DetailDrawer'

const VIEWS: { id: View; label: string }[] = [
  { id: 'ownership', label: 'Ownership' },
  { id: 'network', label: 'Network' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'rbac', label: 'RBAC' },
  { id: 'all', label: 'All' },
]

export default function App() {
  const [namespaces] = createResource(fetchNamespaces)
  const [namespace, setNamespace] = createSignal<string | null>(null)
  const [view, setView] = createSignal<View>('ownership')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [connected, setConnected] = createSignal(false)

  const [graph, setGraph] = createStore<GraphState>(emptyState())

  // Default to the first namespace once the list loads.
  createEffect(() => {
    const list = namespaces()
    if (list && list.length > 0 && namespace() === null) setNamespace(list[0])
  })

  // (Re)subscribe to the graph feed whenever the namespace or view changes.
  createEffect(() => {
    const ns = namespace()
    const v = view()
    if (!ns) return
    setSelectedId(null)
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

  const counts = createMemo(() => {
    const c: Record<string, number> = {}
    for (const n of nodes()) c[n.health] = (c[n.health] ?? 0) + 1
    return c
  })

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
          <For each={HEALTH_ORDER}>
            {(h) => (
              <span class="legend-item" classList={{ dim: !counts()[h] }}>
                <span class="dot" style={{ background: healthColor(h) }} />
                {h}
                <span class="legend-count">{counts()[h] ?? 0}</span>
              </span>
            )}
          </For>
        </div>
        <span class="conn" classList={{ live: connected() }}>
          {connected() ? 'live' : '…'}
        </span>
      </header>

      <div class="body">
        <Sidebar
          namespaces={namespaces() ?? []}
          selected={namespace()}
          onSelect={setNamespace}
          loading={namespaces.loading}
        />
        <main class="main">
          <Topology nodes={nodes()} edges={edges()} selectedId={selectedId()} onSelect={setSelectedId} />
          <DetailDrawer node={selectedNode()} onClose={() => setSelectedId(null)} />
        </main>
      </div>
    </div>
  )
}
