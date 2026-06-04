import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Topology from './Topology'
import type { KEdge, KNode, RelCategory } from '../types'

afterEach(cleanup)

const nodes: KNode[] = [
  { id: '1', kind: 'Deployment', name: 'web', health: 'Healthy' },
  { id: '2', kind: 'Pod', name: 'web-abc', health: 'Degraded' },
  { id: '3', kind: 'Pod', name: 'api-xyz', health: 'Healthy' },
]
const edges: KEdge[] = [{ from: '1', to: '2', type: 'ownerReference' }]

// Default base = group by relationship with the Ownership relationship on, reproducing the old
// landing Ownership view (the ownerReference backbone is drawn, names shorten under their owner).
const base = {
  selectedId: null,
  connected: true,
  relFilter: new Set<RelCategory>(['ownership']),
  onSearch: () => {},
  onSelect: () => {},
}
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

  it('kind chips with any non-Healthy resource get a severity dot (cycle 289)', () => {
    // nodes contains a Degraded Pod, so the Pod chip should carry .troubled + a .kind-chip-dot.
    // The Deployment is Healthy, so the Deployment chip should not. onKindFilter has to be
    // present for chips to render at all (the Show gate).
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} kindFilter={new Set<string>()} onKindFilter={() => {}} />
    ))
    const chips = [...container.querySelectorAll('.kind-chip')] as HTMLButtonElement[]
    expect(chips.length).toBeGreaterThanOrEqual(2)
    const labelOf = (c: HTMLButtonElement) => c.querySelector('.kind-chip-label')?.textContent ?? ''
    const podChip = chips.find((c) => /pod/i.test(labelOf(c)))
    const depChip = chips.find((c) => /dep/i.test(labelOf(c)))
    expect(podChip?.classList.contains('troubled')).toBe(true)
    expect(podChip?.querySelector('.kind-chip-dot')).toBeTruthy()
    expect(depChip?.classList.contains('troubled')).toBe(false)
    expect(depChip?.querySelector('.kind-chip-dot')).toBeFalsy()
  })

  it('renders the health filter pills in the toolbar, one per present state', () => {
    // nodes: 2 Healthy + 1 Degraded → pills [Healthy 2, Degraded 1] in HEALTH_ORDER. onHealthFilter
    // must be present for the pills to render (the Show gate).
    const onHealthFilter = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onHealthFilter={onHealthFilter} />
    ))
    const pills = [...container.querySelectorAll('.topology-health-pills .legend-item')] as HTMLButtonElement[]
    expect(pills.length).toBe(2)
    // Order is HEALTH_ORDER (Healthy before Degraded); counts come from the node set.
    expect(pills[0].textContent).toContain('Healthy')
    expect(pills[0].querySelector('.legend-count')?.textContent).toBe('2')
    expect(pills[1].textContent).toContain('Degraded')
    expect(pills[1].querySelector('.legend-count')?.textContent).toBe('1')
  })

  it('renders the full-width health-distribution stripe with one segment per present state', () => {
    // The stripe is a status bar pinned to the top of the canvas — independent of the filter pills,
    // so it renders even without an onHealthFilter handler (it's a display, not a control).
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    const stripe = container.querySelector('.topology-stripe')
    expect(stripe).toBeTruthy()
    expect(stripe!.querySelectorAll('span').length).toBe(2) // Healthy + Degraded
  })

  it('toggles the health filter when a pill is clicked, and clears it when the active pill is re-clicked', () => {
    const onHealthFilter = vi.fn()
    // No active filter: clicking Degraded spotlights it.
    const off = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} onHealthFilter={onHealthFilter} />)
    const degraded = [...off.container.querySelectorAll('.topology-health-pills .legend-item')].find((p) =>
      p.textContent?.includes('Degraded'),
    ) as HTMLButtonElement
    fireEvent.click(degraded)
    expect(onHealthFilter).toHaveBeenCalledWith('Degraded')
    cleanup()
    onHealthFilter.mockClear()
    // Degraded already active: clicking it again clears the filter (null).
    const on = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} healthFilter="Degraded" onHealthFilter={onHealthFilter} />
    ))
    const active = [...on.container.querySelectorAll('.topology-health-pills .legend-item')].find((p) =>
      p.textContent?.includes('Degraded'),
    ) as HTMLButtonElement
    expect(active.classList.contains('active')).toBe(true)
    fireEvent.click(active)
    expect(onHealthFilter).toHaveBeenCalledWith(null)
  })

  it('hides the health filter pills when no onHealthFilter handler is wired (the stripe still shows)', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    expect(container.querySelector('.topology-health-pills')).toBeNull()
    // The stripe is a status display, not a filter, so it survives without a handler.
    expect(container.querySelector('.topology-stripe')).toBeTruthy()
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
    // 2 Pods of 3 total resources, computed from the intersected filter set. (Trailing sr-only noun
    // for the live region, cycle 335/R8.)
    expect(container.querySelector('.topology-count')?.textContent).toBe('2 of 3 resources shown')
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
    // The most common kind (Pod) sits first, so clicking the first chip dispatches 'Pod'. The
    // second arg is `solo` (cycle 255) — false on a plain click; Shift+click sets it true.
    expect(onKindFilter).toHaveBeenCalledWith('Pod', false)
  })

  it('shows "X of N matches" when the selected node is itself a match (cycle 285)', () => {
    // selectedId=2 is the Degraded Pod 'web-abc'; search "web" matches both Deployment 'web' (id=1)
    // and 'web-abc'. In severity-first order the Degraded pod (web-abc, id=2) comes first, so the
    // selection is position 1 of 2.
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" {...base} selectedId="2" />
    ))
    const counter = container.querySelector('.topology-matches') as HTMLElement
    expect(counter).toBeTruthy()
    expect(counter.textContent).toBe('1 of 2')
    cleanup()
    // Same matches but selection is outside the match set → falls back to the bare count.
    const m = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" {...base} selectedId="3" />
    ))
    const c2 = m.container.querySelector('.topology-matches') as HTMLElement
    expect(c2.textContent).toBe('2 matches')
  })

  it('Enter in the topology search selects the most-troubled match (cycle 259)', () => {
    const onSelect = vi.fn()
    // Render with a search query that hits two nodes; the Degraded one ('web-abc') should win
    // the severity-first sort even though 'api-xyz' is alpha-first.
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onSelect={onSelect} onSearch={() => {}} />
    ))
    // Type into the search field, then Enter.
    const input = container.querySelector('.topology-search input') as HTMLInputElement
    expect(input).toBeTruthy()
    // To get a query that matches both pods, we set 'b' (matches 'web-abc' on 'b') AND 'a' too — but
    // setQuery is driven by props.onSearch in the public API. The test renders search="" via base
    // and treats setQuery as a local signal; in production App.tsx round-trips through onSearch.
    // So we directly fire input on the field — Topology's internal query() is props.search, which
    // only updates when the parent re-renders. To test Enter behavior end-to-end we simulate the
    // re-render via the props.search prop.
    // Simpler: directly dispatch keyDown('Enter') with an empty search — that exercises the no-op
    // branch (no matches() set). Then re-render with a search that matches and dispatch Enter.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    cleanup()
    // Search that matches the two Pods (both contain 'e' indirectly... pick a clearer one).
    const onSelect2 = vi.fn()
    const m = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" {...base} onSelect={onSelect2} onSearch={() => {}} />
    ))
    fireEvent.keyDown(m.container.querySelector('.topology-search input') as HTMLInputElement, { key: 'Enter' })
    // 'web' matches 'web' (Deployment, Healthy) and 'web-abc' (Pod, Degraded). The Degraded Pod
    // is the most attention-worthy, so it should win the severity-first sort.
    expect(onSelect2).toHaveBeenCalledWith('2')
  })

  it('clicking the already-selected card calls onDeselect (cycle 298 toggle; deferred since 315)', () => {
    vi.useFakeTimers()
    try {
      const onSelect = vi.fn()
      const onDeselect = vi.fn()
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} selectedId="2" onSelect={onSelect} onDeselect={onDeselect} />
      ))
      // Node id=2 is selected. Click it again — should deselect, not re-select. The deselect is
      // deferred ~220ms (cycle 315) so a double-click can cancel it, so advance timers to see it.
      const card = container.querySelector('g.node.selected') as SVGGElement
      expect(card).toBeTruthy()
      fireEvent.click(card)
      expect(onDeselect).not.toHaveBeenCalled() // still pending
      vi.advanceTimersByTime(250)
      expect(onDeselect).toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('double-clicking a card cancels the deferred deselect and keeps it selected (cycle 315)', () => {
    vi.useFakeTimers()
    try {
      const onSelect = vi.fn()
      const onDeselect = vi.fn()
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} selectedId="2" onSelect={onSelect} onDeselect={onDeselect} />
      ))
      const card = container.querySelector('g.node.selected') as SVGGElement
      // A double-click = a click (which would schedule deselect) followed by the dblclick event.
      fireEvent.click(card)
      fireEvent.dblClick(card)
      vi.advanceTimersByTime(250)
      // The pending deselect was cancelled; the card is (re)selected instead.
      expect(onDeselect).not.toHaveBeenCalled()
      expect(onSelect).toHaveBeenCalledWith('2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clicking a kind-grouping kind group bg solos that kind (cycle 276)', () => {
    const onKindFilter = vi.fn()
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search=""
        {...base}
        onKindFilter={onKindFilter}
        kindFilter={new Set<string>()}
        groupBy="kind"
      />
    ))
    // First kind group's bg rect is the click target since it covers the area. Group order is
    // layout-driven, not count-driven — assert on the dispatched kind shape, not which group.
    const groupBg = container.querySelector('.kind-group .kind-group-bg') as SVGRectElement
    expect(groupBg).toBeTruthy()
    fireEvent.click(groupBg)
    // Either Pod or Deployment (the two kinds in the test fixture); both call with solo=true.
    expect(onKindFilter).toHaveBeenCalledOnce()
    const [kind, solo] = onKindFilter.mock.calls[0]
    expect(['Pod', 'Deployment']).toContain(kind)
    expect(solo).toBe(true)
  })

  it('Shift+click on a kind chip dispatches solo=true (cycle 255)', () => {
    const onKindFilter = vi.fn()
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onKindFilter={onKindFilter} kindFilter={new Set<string>()} />
    ))
    const firstChip = container.querySelector('.kind-chip') as HTMLButtonElement
    fireEvent.click(firstChip, { shiftKey: true })
    expect(onKindFilter).toHaveBeenCalledWith('Pod', true)
  })

  it('Nodes view renders a capacity row per node with a usage segment per pod', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000, memBytes: 8 * 1024 ** 3 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 200 } },
      { id: 'p2', kind: 'Pod', name: 'p2', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
    ]
    // The Nodes view draws from the cluster-wide `capacity` feed, not the namespace graph.
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 150 }, p2: { cpuMilli: 80 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // One capacity row for the node, one usage segment per pod.
    expect(container.querySelectorAll('.cap-row').length).toBe(1)
    expect(container.querySelectorAll('.cap-seg.use').length).toBe(2)
    // Explicit Req/Use axis labels are present (item: explicit over implicit).
    const axis = [...container.querySelectorAll('.cap-axis-label')].map((e) => e.textContent)
    expect(axis).toContain('Req')
    expect(axis).toContain('Use')
    // The capacity view draws no relationship edges (containment carries scheduling).
    expect(container.querySelectorAll('g.edges > g').length).toBe(0)
  })

  it('Nodes view dims other-namespace pods as a distinct gray group', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', namespace: 'app', health: 'Healthy', host: 'host-1' },
      { id: 'p2', kind: 'Pod', name: 'p2', namespace: 'kube-system', health: 'Healthy', host: 'host-1' },
    ]
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 50 }, p2: { cpuMilli: 90 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="app" />
    ))
    // The app pod is one bright segment; every other namespace folds into a single gray block.
    expect(container.querySelectorAll('.cap-seg.use:not(.other)').length).toBe(1)
    expect(container.querySelectorAll('.cap-seg.use.other').length).toBe(1)
  })

  it('Nodes view folds many tiny pods into one explicit "small pods" block, not a wall of floors', () => {
    const nodesV: KNode[] = [{ id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 8000 } }]
    const items: Record<string, { cpuMilli: number }> = { big: { cpuMilli: 600 } }
    for (let i = 0; i < 12; i++) {
      nodesV.push({ id: `t${i}`, kind: 'Pod', name: `t${i}`, health: 'Healthy', host: 'host-1' })
      items[`t${i}`] = { cpuMilli: 1 }
    }
    nodesV.push({ id: 'big', kind: 'Pod', name: 'big', health: 'Healthy', host: 'host-1' })
    const capacity = { nodes: nodesV, usage: { items } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // Only the big pod draws individually; the 12 tinies collapse into one folded block (not 12 segments).
    expect(container.querySelectorAll('.cap-seg.use:not(.other):not(.small)').length).toBe(1)
    expect(container.querySelectorAll('.cap-seg.use.small').length).toBe(1)
  })

  it('Nodes view: both expanded bars fill with usage; Req wraps when usage bursts past request', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 }, limits: { cpuMilli: 200 } },
    ]
    // p1 uses 150m: under its 200m limit (Use bar 75%, no wrap) but OVER its 100m request (Req bar
    // 150% → wraps into a lap-2 band). Both bars fill with the same usage, against different ceilings.
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 150 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // Expand the node row (clicking its card) so the per-pod gauges render.
    fireEvent.click(container.querySelector('.cap-node-frame') as Element)
    expect(container.querySelectorAll('.cap-bullet .cap-seg.req.lap-2').length).toBe(1) // burst past request
    expect(container.querySelectorAll('.cap-bullet .cap-seg.use.lap-2').length).toBe(0) // under the limit
  })

  it('Nodes view: the node-usage backdrop shows an overhead tooltip (node total − pod sum)', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
    ]
    // Node total usage 300m (NodeMetrics, keyed by node id) vs the one pod's 100m → 200m overhead
    // (other namespaces' pods + system/kubelet) that the gray backdrop beyond the pod segment shows.
    const capacity = { nodes: nodesV, usage: { items: { 'node-a': { cpuMilli: 300 }, p1: { cpuMilli: 100 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    fireEvent.pointerMove(container.querySelector('.cap-track-nodeuse') as Element, { clientX: 50, clientY: 50 })
    const tip = container.querySelector('.cap-tooltip')!
    expect(tip.textContent).toContain('Overhead')
    expect(tip.textContent).toContain('Node total')
    expect(tip.textContent).toContain('200m') // overhead = 300m total − 100m pods
  })

  it('clears all filters via onClearFilters (cycle 216)', () => {
    const onClearFilters = vi.fn()
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search="web"
        {...base}
        onClearFilters={onClearFilters}
      />
    ))
    const clear = container.querySelector('.topology-clear') as HTMLButtonElement
    expect(clear).toBeTruthy()
    fireEvent.click(clear)
    expect(onClearFilters).toHaveBeenCalledOnce()
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
    // Search "web" matches the Deployment + web-abc Pod (2 of 3). textContent includes the sr-only
    // suffix that gives the live announcement a noun (cycle 335/R8).
    const filtered = render(() => <Topology nodes={nodes} edges={edges} search="web" {...base} />)
    expect(filtered.container.querySelector('.topology-count')?.textContent).toBe('2 of 3 resources shown')
  })

  // The match count is a polite live region so screen readers hear it update as the filter narrows.
  it('marks the resource count as an atomic polite live region (cycle 335/R8)', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    const count = container.querySelector('.topology-count')!
    expect(count.getAttribute('aria-live')).toBe('polite')
    expect(count.getAttribute('aria-atomic')).toBe('true')
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

  it('selection spotlight follows only the SELECTED relationships, not all edges', () => {
    // Pod(1) is wired to its Node(2) by scheduledOn and to a sibling Pod(3) by nothing. With only
    // the Ownership relationship on, selecting the Pod must NOT drag in the Node via the (hidden)
    // scheduledOn edge — otherwise the spotlight + selection-fit reach a node that isn't even drawn.
    const ns: KNode[] = [
      { id: '1', kind: 'Pod', name: 'web', health: 'Healthy' },
      { id: '2', kind: 'Node', name: 'host-1', health: 'Healthy' },
      { id: '3', kind: 'Pod', name: 'other', health: 'Healthy' },
    ]
    const es: KEdge[] = [{ from: '1', to: '2', type: 'scheduledOn' }]

    // Ownership only (scheduledOn not drawn): the Node + the other Pod both fade — nothing relates
    // to the selected Pod through a visible relationship.
    const ownership = render(() => (
      <Topology nodes={ns} edges={es} search="" {...base} relFilter={new Set<RelCategory>(['ownership'])} selectedId="1" />
    )).container
    expect(faded(ownership)).toBe(2)
    cleanup()

    // Turn Scheduling on and the Node lights up (the scheduledOn edge is now displayed), so only the
    // unrelated sibling Pod fades.
    const scheduling = render(() => (
      <Topology nodes={ns} edges={es} search="" {...base} relFilter={new Set<RelCategory>(['scheduling'])} selectedId="1" />
    )).container
    expect(faded(scheduling)).toBe(1) // only the other Pod
  })

  it('collapse pill: a bare selection shows no "N match" badge (empty search)', () => {
    // Regression: selecting a resource lights its whole related subtree (related()). A fold inside
    // that subtree must NOT report its hidden siblings as search "matches" while the search box is
    // empty — the badge is for explicit search/health queries, not navigation. A CRD owner with 6
    // Services folds the crowded Service block; selecting the owner pulls every Service into related().
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'main', health: 'Healthy' }
    const svcs: KNode[] = Array.from({ length: 6 }, (_, i) => ({ id: `svc-${i}`, kind: 'Service', name: `svc-${i}`, health: 'Healthy' as const }))
    const owns: KEdge[] = svcs.map((s) => ({ from: 'es', to: s.id, type: 'ownerReference' as const }))

    const empty = render(() => (
      <Topology nodes={[owner, ...svcs]} edges={owns} search="" {...base} selectedId="es" />
    )).container
    expect(empty.querySelector('.collapse-pill')).toBeTruthy() // the fold actually happened
    expect(empty.querySelectorAll('.collapse-pill-match').length).toBe(0) // ...but no phantom badge

    // An explicit search hitting the hidden Services brings the badge back.
    const searched = render(() => (
      <Topology nodes={[owner, ...svcs]} edges={owns} search="svc" {...base} selectedId="es" />
    )).container
    expect(searched.querySelectorAll('.collapse-pill-match').length).toBeGreaterThan(0)
  })

  it('accents only edges directly touching the selected node, not the whole component (cycle 309)', () => {
    // Chain: Deployment(1) → ReplicaSet(2) → Pod(3). Selecting the Pod should accent only the
    // RS→Pod edge (2→3) that touches it — NOT the Deployment→RS edge (1→2) further up the tree.
    const chainNodes: KNode[] = [
      { id: '1', kind: 'Deployment', name: 'd', health: 'Healthy' },
      { id: '2', kind: 'ReplicaSet', name: 'rs', health: 'Healthy' },
      { id: '3', kind: 'Pod', name: 'p', health: 'Healthy' },
    ]
    const chainEdges: KEdge[] = [
      { from: '1', to: '2', type: 'ownerReference' },
      { from: '2', to: '3', type: 'ownerReference' },
    ]
    const { container } = render(() => (
      <Topology nodes={chainNodes} edges={chainEdges} search="" {...base} selectedId="3" />
    ))
    const adjacent = [...container.querySelectorAll('.edges path.adjacent')]
    expect(adjacent.length).toBe(1)
    // The one accented edge is RS→Pod (touches the selection), confirmed via its <title>.
    expect(adjacent[0].parentElement?.querySelector('title')?.textContent).toContain('owns Pod p')
    // The rest of the subtree stays lit as context — no edge in the component is faded.
    expect(container.querySelectorAll('.edges path.faded').length).toBe(0)
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

  it('Kind grouping: renders all 3 nodes in kind-grouped layout (groupBy=kind)', () => {
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" />
    ))
    // Kind grouping should still render one chip per node regardless of layout strategy.
    expect(container.querySelectorAll('g.node').length).toBe(3)
  })

  it('search match count + Enter-cycle respect the active kind filter (cycle 314)', () => {
    // Search "web" matches the Deployment "web" and the Pod "web-abc" (2). With a Pod-only kind
    // filter active, only the Pod should count as a match — the faded Deployment must be excluded.
    const onSelect = vi.fn()
    const { container } = render(() => (
      <Topology
        nodes={nodes}
        edges={edges}
        search="web"
        {...base}
        onSelect={onSelect}
        kindFilter={new Set(['Pod'])}
        onKindFilter={() => {}}
      />
    ))
    expect(container.querySelector('.topology-matches')?.textContent).toMatch(/1 match/)
    // Enter cycles only the lit match — selects the Pod, never the filtered-out Deployment.
    const input = container.querySelector('.topology-search input') as HTMLInputElement
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('2') // the web-abc Pod
  })

  it('Kind grouping hides edges until a resource is selected', () => {
    // No selection: the cross-kind backbone lines are suppressed (they fan across the matrix as
    // noise). The lone ownerReference edge must not render.
    const none = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" />)
    expect(none.container.querySelectorAll('.edges > g').length).toBe(0)
    cleanup()
    // With a resource selected, edges come back as the "what connects to this" highlight.
    const sel = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" selectedId="1" />
    ))
    expect(sel.container.querySelectorAll('.edges > g').length).toBe(1)
  })

  it('relationship grouping shows edges even with no selection', () => {
    // Relationship grouping keeps its backbone always — the suppression gate is kind-specific.
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="relationship" />)
    expect(container.querySelectorAll('.edges > g').length).toBe(1)
  })

  it('Kind grouping: search still fades non-matching nodes', () => {
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" {...base} groupBy="kind" />
    ))
    expect(faded(container)).toBe(1) // api-xyz is faded
  })

  // Edge-hover endpoint halo (cycle 330/R4): hovering an edge marks both its endpoint cards .target.
  it('halos both endpoint cards while an edge is hovered', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    const edgeG = container.querySelector('.edges > g') as SVGGElement
    expect(edgeG).toBeTruthy()
    expect(container.querySelectorAll('.node.target').length).toBe(0)
    fireEvent.pointerEnter(edgeG)
    // The lone edge connects nodes '1' and '2', so exactly those two cards light up.
    const lit = [...container.querySelectorAll('.node.target')]
    expect(lit.length).toBe(2)
    fireEvent.pointerLeave(edgeG)
    expect(container.querySelectorAll('.node.target').length).toBe(0)
  })

  // Keyboard zoom (cycle 329/R3). The handler lives on window keydown; reads the viewport transform's
  // scale factor off the root <g>. '0' resets to exactly 1× regardless of the prior scale.
  it('zooms with = / - / 0 keys', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    const groupScale = () => {
      const t = container.querySelector('.topology svg > g')?.getAttribute('transform') || ''
      return parseFloat(/scale\(([-\d.]+)\)/.exec(t)?.[1] ?? 'NaN')
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0' })) // normalize to 1× first
    expect(groupScale()).toBeCloseTo(1, 5)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=' }))
    expect(groupScale()).toBeCloseTo(1.2, 5)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }))
    expect(groupScale()).toBeCloseTo(1, 5)
    // A non-Shift modifier is left to the browser (Cmd+- is browser zoom), so it must not zoom.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: true }))
    expect(groupScale()).toBeCloseTo(1, 5)
  })
})
