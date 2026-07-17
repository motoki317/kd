import { createRoot, createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphStreamHandlers } from './api'
import type { ConnState } from './clusterSession'
import { emptyState } from './graphState'
import { createGraphSubscription } from './graphSubscription'
import type { Capacity, Health, KGraph } from './types'

const graphStream = vi.hoisted(() => ({ handlers: null as GraphStreamHandlers | null }))

vi.mock('./api', () => ({
  streamGraph: vi.fn((_ctx: string, _ns: string, handlers: GraphStreamHandlers) => {
    graphStream.handlers = handlers
    return () => {}
  }),
}))

afterEach(() => {
  graphStream.handlers = null
  vi.clearAllMocks()
})

function mountSubscription() {
  return createRoot((dispose) => {
    const [ctx] = createSignal<string | null>('ctx')
    const [namespace] = createSignal<string | null>('shop')
    const [selectedId, setSelectedId] = createSignal<string | null>(null)
    const [, setSearch] = createSignal('')
    const [, setHealthFilter] = createSignal<Health | null>(null)
    const [, setKindFilter] = createSignal(new Set<string>())
    const [, setSelectionHistory] = createSignal<string[]>([])
    const [graph, setGraph] = createStore(emptyState())
    const [capacity, setCapacity] = createSignal<Capacity | null>(null)
    const [connState, setConnState] = createSignal<ConnState>('connecting')

    createGraphSubscription({
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
      recordSummary: () => {},
      capacity,
      setCapacity,
      connState,
      setConnState,
      refetchContexts: () => {},
      pendingSel: () => null,
      clearPendingSel: () => {},
    })

    return { dispose, selectedId, setSelectedId }
  })
}

describe('createGraphSubscription', () => {
  it('preserves a selection made after the initial snapshot when a replacement snapshot arrives', async () => {
    const mounted = mountSubscription()

    try {
      await Promise.resolve()
      const handlers = graphStream.handlers
      expect(handlers).not.toBeNull()
      const snapshot: KGraph = {
        nodes: [{ id: 'pod-uid', kind: 'Pod', name: 'web-a', namespace: 'shop', health: 'Healthy' }],
        edges: [],
      }
      handlers!.snapshot(snapshot)
      mounted.setSelectedId('pod-uid')
      handlers!.snapshot(snapshot)
      expect(mounted.selectedId()).toBe('pod-uid')
    } finally {
      mounted.dispose()
    }
  })

  it('preserves a capacity-only selection when a replacement graph snapshot arrives', async () => {
    const mounted = mountSubscription()

    try {
      await Promise.resolve()
      const handlers = graphStream.handlers
      expect(handlers).not.toBeNull()
      const snapshot: KGraph = { nodes: [], edges: [] }
      const capacityNode = {
        id: 'other-pod-uid',
        kind: 'Pod',
        name: 'api-b',
        namespace: 'team-b',
        health: 'Healthy' as const,
      }
      handlers!.snapshot(snapshot)
      handlers!.capacity?.({ nodes: [capacityNode] })
      mounted.setSelectedId(capacityNode.id)
      handlers!.snapshot(snapshot)
      expect(mounted.selectedId()).toBe(capacityNode.id)
    } finally {
      mounted.dispose()
    }
  })
})
