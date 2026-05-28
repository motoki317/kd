import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Topology from './Topology'
import type { KEdge, KNode } from '../types'

afterEach(cleanup)

const nodes: KNode[] = [
  { id: '1', kind: 'Deployment', name: 'web', health: 'Healthy' },
  { id: '2', kind: 'Pod', name: 'web-abc', health: 'Degraded' },
  { id: '3', kind: 'Pod', name: 'api-xyz', health: 'Healthy' },
]
const edges: KEdge[] = [{ from: '1', to: '2', type: 'ownerReference' }]

const base = { selectedId: null, connected: true, viewLabel: 'Ownership', onSearch: () => {}, onSelect: () => {} }
const faded = (c: Element) => c.querySelectorAll('g.node.faded').length

describe('Topology', () => {
  it('renders one chip per node', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    expect(container.querySelectorAll('g.node').length).toBe(3)
    expect(faded(container)).toBe(0)
  })

  it('tags Pod cards with kind-pod (cycle 202: distinct accent for the fundamental workload)', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    // Only the two Pods carry the kind-pod class; the Deployment doesn't.
    expect(container.querySelectorAll('g.node.kind-pod').length).toBe(2)
  })

  it('renders a kind-filter chip per present kind, ordered by count (cycle 203)', () => {
    // nodes has 2 Pods + 1 Deployment, so the chips should be [Pod (2), Deployment (1)].
    const onKindFilter = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onKindFilter={onKindFilter} kindFilter={new Set<string>()} />
    ))
    const labels = [...container.querySelectorAll('.kind-chip-label')].map((e) => e.textContent)
    // Short labels: Pod -> "POD", Deployment -> "DEPLOY". Most common kind first.
    expect(labels[0]).toMatch(/POD/i)
    expect(labels.length).toBe(2)
  })

  it('fades non-matching kinds when a kind filter is active, lit ones survive (cycle 203)', () => {
    // kindFilter={Pod} → the Deployment should fade, the two Pods stay lit.
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search=""
        {...base}
        onKindFilter={() => {}}
        kindFilter={new Set(['Pod'])}
      />
    ))
    expect(faded(container)).toBe(1) // only the Deployment
    const lit = [...container.querySelectorAll('g.node:not(.faded)')]
    expect(lit.every((g) => g.classList.contains('kind-pod'))).toBe(true)
  })

  it('hides the kind-chip row when only one kind is present (no-op filter)', () => {
    const single: KNode[] = [{ id: '1', kind: 'Pod', name: 'only-pod', health: 'Healthy' }]
    const { container } = render(() => (
      <Topology nodes={single} edges={[]} search="" {...base} onKindFilter={() => {}} kindFilter={new Set<string>()} />
    ))
    expect(container.querySelector('.topology-kinds')).toBeNull()
  })

  it('count reflects the kind filter ("2 of 3" when only Pods are active, cycle 213)', () => {
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search=""
        {...base}
        onKindFilter={() => {}}
        kindFilter={new Set(['Pod'])}
      />
    ))
    // 2 Pods of 3 total resources, computed from the intersected filter set.
    expect(container.querySelector('.topology-count')?.textContent).toBe('2 of 3')
  })

  it('selected node never fades, even when a filter excludes it (cycle 224)', () => {
    // kindFilter={Deployment}, selected the Pod web-abc → the Pod stays lit so the operator's
    // focus doesn't ghost out. Of the two unselected nodes, the other Pod fades and the
    // Deployment stays lit (matches the filter).
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search=""
        {...base}
        selectedId="2"
        onKindFilter={() => {}}
        kindFilter={new Set(['Deployment'])}
      />
    ))
    // Only the api-xyz Pod (not selected, not Deployment) should be faded.
    expect(faded(container)).toBe(1)
  })

  it('toggles the kind filter via the chip click handler', () => {
    const onKindFilter = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onKindFilter={onKindFilter} kindFilter={new Set<string>()} />
    ))
    const firstChip = container.querySelector('.kind-chip') as HTMLButtonElement
    fireEvent.click(firstChip)
    // The most common kind (Pod) sits first, so clicking the first chip dispatches 'Pod'.
    expect(onKindFilter).toHaveBeenCalledWith('Pod')
  })

  it('fades nodes not matching the search query', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="web" {...base} />)
    // "web" matches the Deployment and web-abc pod; api-xyz is faded.
    expect(faded(container)).toBe(1)
  })

  it('fades nodes not matching the health filter', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" healthFilter="Degraded" {...base} />)
    // Only the single Degraded pod stays lit.
    expect(faded(container)).toBe(2)
  })

  it('shows the resource count, switching to "M of N" when filtered', () => {
    // No filter → total count.
    const noFilter = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    expect(noFilter.container.querySelector('.topology-count')?.textContent).toBe('3 resources')
    cleanup()
    // Search "web" matches the Deployment + web-abc Pod (2 of 3).
    const filtered = render(() => <Topology nodes={nodes} edges={edges} search="web" {...base} />)
    expect(filtered.container.querySelector('.topology-count')?.textContent).toBe('2 of 3')
  })

  it('calls onDeselect when a background click lands outside any card (cycle 161)', () => {
    const onDeselect = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} selectedId="1" onDeselect={onDeselect} />
    ))
    const svg = container.querySelector('.topology-svg')!
    // Pointer down + up on the SVG itself (target lacks a .node ancestor) without dragging.
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(svg, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(onDeselect).toHaveBeenCalledOnce()
  })

  it('lights the selected node\'s full connected component, fading the rest (cycle 157)', () => {
    // Chain: Deployment → ReplicaSet → Pod (3 cards, 2 ownerReference edges). Plus an unrelated
    // standalone Pod (id=4). Selecting the Pod in the chain should keep the whole chain lit
    // (faded=0 for {1,2,3}) and fade only the standalone (faded=1 for {4}).
    const chainNodes: KNode[] = [
      { id: '1', kind: 'Deployment', name: 'd', health: 'Healthy' },
      { id: '2', kind: 'ReplicaSet', name: 'rs', health: 'Healthy' },
      { id: '3', kind: 'Pod', name: 'p', health: 'Healthy' },
      { id: '4', kind: 'Pod', name: 'standalone', health: 'Healthy' },
    ]
    const chainEdges: KEdge[] = [
      { from: '1', to: '2', type: 'ownerReference' },
      { from: '2', to: '3', type: 'ownerReference' },
    ]
    const { container } = render(() => (
      <Topology nodes={chainNodes} edges={chainEdges} search="" {...base} selectedId="3" />
    ))
    // Only the standalone Pod (id=4) should be faded; the chain (1,2,3) stays lit.
    expect(faded(container)).toBe(1)
  })

  it('does NOT call onDeselect when a card click lands on a node (cycle 161)', () => {
    const onDeselect = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} selectedId="1" onDeselect={onDeselect} />
    ))
    // The node group <g class="node">: pointerup whose target is inside should NOT deselect.
    const node = container.querySelector('g.node')!
    fireEvent.pointerDown(node, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(node, { clientX: 10, clientY: 10, pointerId: 1 })
    expect(onDeselect).not.toHaveBeenCalled()
  })

  it('All view: renders all 3 nodes in kind-grouped layout (viewId=all)', () => {
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" viewId="all" {...base} viewLabel="All" />
    ))
    // The All view should still render one chip per node regardless of layout strategy.
    expect(container.querySelectorAll('g.node').length).toBe(3)
  })

  it('All view: search still fades non-matching nodes when viewId=all', () => {
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" viewId="all" {...base} viewLabel="All" />
    ))
    expect(faded(container)).toBe(1) // api-xyz is faded
  })
})
