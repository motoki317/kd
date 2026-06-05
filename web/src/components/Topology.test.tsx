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

  it('empty-state distinguishes connecting (spinner) from offline (static, points at retry)', () => {
    // Connecting: an empty graph with connected=false and not offline → spinner + "Connecting…".
    const connecting = render(() => <Topology nodes={[]} edges={[]} search="" {...base} connected={false} />)
    expect(connecting.container.querySelector('.topology-empty-spinner')).toBeTruthy()
    expect(connecting.container.querySelector('.topology-empty-text')?.textContent).toContain('Connecting')
    connecting.unmount()
    // Offline: the connection FAILED, so no spinner (which would imply progress) — a static message
    // that points the operator at the retry control instead of implying it's still working.
    const offline = render(() => <Topology nodes={[]} edges={[]} search="" {...base} connected={false} offline={true} />)
    expect(offline.container.querySelector('.topology-empty-spinner')).toBeFalsy()
    expect(offline.container.querySelector('.topology-empty-text')?.textContent).toContain("Can't reach the cluster")
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
    const segs = [...stripe!.querySelectorAll('span')]
    expect(segs.length).toBe(2) // Healthy + Degraded
    // The lone Degraded resource (1 of 3) MUST get its own segment — a present trouble state can never
    // be dropped from the stripe. Its on-screen width is floored by CSS (min-width) so it stays visible
    // even when proportionally sub-pixel in a large namespace; that floor is verified live (jsdom can't
    // measure layout). Here we lock the data half: the segment exists and is identifiable by title.
    expect(segs.some((s) => s.getAttribute('title') === 'Degraded: 1')).toBe(true)
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
    expect(container.querySelector('.topology-count')?.textContent).toBe('2 of 3 resources match')
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

  it('the match count is a button that frames the matches on click (mouse path beside Enter)', () => {
    // The count is the affordance for reaching off-screen matches: a real <button>, focusable and
    // clickable, so a mouse operator isn't stranded staring at faded cards after typing a query.
    // jsdom can't measure the viewport move (getBoundingClientRect → 0), so we lock the DOM contract:
    // it's a button, enabled with matches, and clicking it runs without throwing.
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="web" {...base} />
    ))
    const btn = container.querySelector('.topology-matches') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.disabled).toBe(false)
    expect(() => btn.click()).not.toThrow()
    cleanup()

    // No matches → the button disables (a true no-op, not a clickable dead control).
    const none = render(() => (
      <Topology nodes={nodes} edges={edges} search="zzz-nothing-matches" {...base} />
    ))
    const noneBtn = none.container.querySelector('.topology-matches') as HTMLButtonElement
    expect(noneBtn.textContent).toBe('no matches')
    expect(noneBtn.disabled).toBe(true)
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

  it('the kind toolbar is a single Tab stop with arrow-key roving (APG toolbar pattern)', () => {
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} onKindFilter={vi.fn()} kindFilter={new Set<string>()} />
    ))
    const toolbar = container.querySelector('.topology-kinds') as HTMLElement
    const chips = [...toolbar.querySelectorAll('button')] as HTMLButtonElement[]
    expect(chips.length).toBeGreaterThan(1)
    // Exactly one Tab stop (the first chip); the rest are -1 so Tab doesn't walk every chip.
    expect(chips.filter((c) => c.tabIndex === 0).length).toBe(1)
    expect(chips[0].tabIndex).toBe(0)
    // Arrow keys move focus among the chips (jsdom supports focus()/activeElement).
    chips[0].focus()
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement).toBe(chips[1])
    toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(document.activeElement).toBe(chips[0])
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

  it('Relationships facet appears only in the relationship grouping (Nodes + Kind draw no edges)', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1' },
    ]
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 50 } } } }
    // Same ownerReference edge that lights the Relationships facet — present in every render below,
    // so a missing facet means the view suppresses it, not that the data is absent.
    const relEdges: KEdge[] = [{ from: 'node-a', to: 'p1', type: 'ownerReference' }]
    // Nodes view: groups pods by host, draws no edges → no facet.
    const inNodes = render(() => (
      <Topology nodes={nodesV} edges={relEdges} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" onRelFilter={() => {}} />
    ))
    expect(inNodes.container.querySelector('.topology-rels')).toBeNull()
    cleanup()
    // Kind view: per-kind matrix, draws no edges → no facet either.
    const inKind = render(() => (
      <Topology nodes={nodesV} edges={relEdges} search="" {...base} groupBy="kind" onRelFilter={() => {}} />
    ))
    expect(inKind.container.querySelector('.topology-rels')).toBeNull()
    cleanup()
    // Relationship view: the one grouping the filter drives → facet present.
    const inRel = render(() => (
      <Topology nodes={nodesV} edges={relEdges} search="" {...base} groupBy="relationship" onRelFilter={() => {}} />
    ))
    expect(inRel.container.querySelector('.topology-rels')).not.toBeNull()
  })

  it('Nodes view tallies Health over the displayed set only (cluster Nodes + own-namespace Pods)', () => {
    // props.nodes carries the full namespace inventory the Nodes view never draws — a Degraded
    // Deployment and a Progressing Service here must NOT leak into the health pills/stripe.
    const graph: KNode[] = [
      { id: 'd1', kind: 'Deployment', name: 'web', health: 'Degraded' },
      { id: 's1', kind: 'Service', name: 'svc', health: 'Progressing' },
      { id: 'p1', kind: 'Pod', name: 'p1', namespace: 'app', health: 'Degraded' },
    ]
    // The capacity feed is what's actually on screen: one Healthy Node, one Degraded own-namespace
    // Pod, and one Unknown pod from another namespace (folded into the gray block, so not counted).
    const capacity = {
      nodes: [
        { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
        { id: 'p1', kind: 'Pod', name: 'p1', namespace: 'app', health: 'Degraded', host: 'host-1' },
        { id: 'p2', kind: 'Pod', name: 'p2', namespace: 'kube-system', health: 'Unknown', host: 'host-1' },
      ] as KNode[],
      usage: { items: { p1: { cpuMilli: 50 }, p2: { cpuMilli: 90 } } },
    }
    const { container } = render(() => (
      <Topology nodes={graph} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="app" onHealthFilter={() => {}} />
    ))
    const pills = [...container.querySelectorAll('.topology-health-pills .legend-item')] as HTMLButtonElement[]
    const counts = Object.fromEntries(
      pills.map((p) => [p.textContent?.replace(/\d+$/, '').trim(), p.querySelector('.legend-count')?.textContent]),
    )
    // Only the displayed Node (Healthy) + own Pod (Degraded). No Progressing (Service was off-screen),
    // no Unknown (other-namespace pod), no double-counted Degraded from the Deployment.
    expect(counts).toEqual({ Healthy: '1', Degraded: '1' })
    // The stripe mirrors the pills: exactly two segments.
    expect(container.querySelector('.topology-stripe')!.querySelectorAll('span').length).toBe(2)
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

  it('Nodes view: expanded bars fill with usage and extend past the request/limit tick when over', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 }, limits: { cpuMilli: 200 } },
    ]
    // p1 uses 150m: under its 200m limit (Use bar's fill stops short of the limit tick) but OVER its
    // 100m request (Req bar's fill runs past the request tick → the overshoot is hatched). Both bars
    // fill with the same usage at the global scale; only the reference tick differs.
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 150 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // Expand the node row (clicking its card) so the per-pod cards render.
    fireEvent.click(container.querySelector('.cap-node-frame') as Element)
    expect(container.querySelectorAll('.cap-bullet').length).toBe(1) // one pod card
    expect(container.querySelectorAll('.cap-bullet .cap-bullet-tick').length).toBe(2) // request + limit ticks
    expect(container.querySelectorAll('.cap-bullet .cap-burst-overlay.req').length).toBe(1) // over its request
    expect(container.querySelectorAll('.cap-bullet .cap-burst-overlay.use').length).toBe(0) // under its limit
  })

  it('Nodes view: an expandable node row is a keyboard-operable button (role/aria-expanded + Enter)', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
    ]
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 80 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    const row = container.querySelector('.cap-row') as SVGGElement
    // Expand/collapse has no other keyboard path, so the row is a real button (the nested pod segments
    // stay non-focusable — pods are keyboard-reachable via search).
    expect(row.getAttribute('role')).toBe('button')
    expect(row.getAttribute('tabindex')).toBe('0')
    expect(row.getAttribute('aria-label')).toMatch(/host-1, 1 pod — expand node/)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelectorAll('.cap-bullet').length).toBe(0)
    // Enter activates it → the node expands (per-pod cards render, state flips).
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect((container.querySelector('.cap-row') as SVGGElement).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.cap-bullet').length).toBe(1)
  })

  it('Nodes view: clicking an expanded pod card selects that pod', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
    ]
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 80 } } } }
    let selected: string | null = null
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" onSelect={(id) => (selected = id)} />
    ))
    fireEvent.click(container.querySelector('.cap-node-frame') as Element) // expand
    fireEvent.click(container.querySelector('.cap-bullet') as Element) // click the pod card
    expect(selected).toBe('p1')
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
    // Minimal tooltip: the slice's name + just its amount (the bar's right label already shows totals).
    expect(tip.textContent).toContain('Overhead')
    expect(tip.querySelector('.cap-tooltip-value')?.textContent).toBe('200m') // 300m node total − 100m pods
  })

  it('Nodes view: hovering a pod segment shows only that part\'s amount (use vs req)', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 300 } },
    ]
    const capacity = { nodes: nodesV, usage: { items: { p1: { cpuMilli: 120 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // Use bar → the segment's usage; Req bar → the segment's request. Each tooltip carries one value.
    fireEvent.pointerMove(container.querySelector('.cap-seg.use') as Element, { clientX: 50, clientY: 50 })
    expect(container.querySelector('.cap-tooltip-value')?.textContent).toBe('120m')
    fireEvent.pointerMove(container.querySelector('.cap-seg.req') as Element, { clientX: 50, clientY: 50 })
    expect(container.querySelector('.cap-tooltip-value')?.textContent).toBe('300m')
  })

  it('Nodes view: hovering the overhead backdrop fades every pod segment (spotlight)', () => {
    const nodesV: KNode[] = [
      { id: 'node-a', kind: 'Node', name: 'host-1', health: 'Healthy', allocatable: { cpuMilli: 4000 } },
      { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
      { id: 'p2', kind: 'Pod', name: 'p2', health: 'Healthy', host: 'host-1', requests: { cpuMilli: 100 } },
    ]
    const capacity = { nodes: nodesV, usage: { items: { 'node-a': { cpuMilli: 300 }, p1: { cpuMilli: 80 }, p2: { cpuMilli: 80 } } } }
    const { container } = render(() => (
      <Topology nodes={nodesV} edges={[]} search="" {...base} groupBy="nodes" capacity={capacity} namespace="" />
    ))
    // Nothing hovered → no segment is faded.
    expect(container.querySelectorAll('.cap-seg.use.faded').length).toBe(0)
    // Hovering the node-usage backdrop spotlights it and fades every pod segment, like a pod hover does.
    fireEvent.pointerMove(container.querySelector('.cap-track-nodeuse') as Element, { clientX: 50, clientY: 50 })
    expect(container.querySelectorAll('.cap-seg.use:not(.small):not(.other)').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.cap-seg.use:not(.small):not(.other):not(.faded)').length).toBe(0)
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
    expect(filtered.container.querySelector('.topology-count')?.textContent).toBe('2 of 3 resources match')
  })

  it('count is the true match total over all nodes, so it agrees with the health pill (folded matches included)', () => {
    // The count is computed over props.nodes, not the rendered/unfaded set — so a health-filter count
    // matches the Degraded pill even when some matches fold into a collapse pill. Here 1 of 3 is
    // Degraded; the contract that matters is "count == pill", not the visible-card tally.
    const { container } = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} healthFilter="Degraded" onHealthFilter={() => {}} />
    ))
    const pill = [...container.querySelectorAll('.topology-health-pills .legend-item')].find((p) => /Degraded/.test(p.textContent || ''))
    expect(pill?.querySelector('.legend-count')?.textContent).toBe('1')
    expect(container.querySelector('.topology-count')?.textContent).toBe('1 of 3 resources match')
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

  it('pod→node is never spotlit — not even with the Disruption relationship on (it lives in the Nodes view)', () => {
    // Pod(1) is wired to its Node(2) by scheduledOn and to a sibling Pod(3) by nothing. scheduledOn
    // is no longer surfaced by ANY relationship category — the pod↔node story moved to the Nodes
    // group-by — so selecting the Pod must never drag in the Node, under Ownership OR Disruption.
    const ns: KNode[] = [
      { id: '1', kind: 'Pod', name: 'web', health: 'Healthy' },
      { id: '2', kind: 'Node', name: 'host-1', health: 'Healthy' },
      { id: '3', kind: 'Pod', name: 'other', health: 'Healthy' },
    ]
    const es: KEdge[] = [{ from: '1', to: '2', type: 'scheduledOn' }]

    // Ownership only: the Node + the other Pod both fade — nothing relates through a visible edge.
    const ownership = render(() => (
      <Topology nodes={ns} edges={es} search="" {...base} relFilter={new Set<RelCategory>(['ownership'])} selectedId="1" />
    )).container
    expect(faded(ownership)).toBe(2)
    cleanup()

    // Disruption on (the category still keyed 'scheduling'): scheduledOn STILL isn't drawn, so the
    // Node stays faded too — pod→node is not a relationship the spotlight can traverse anymore.
    const disruption = render(() => (
      <Topology nodes={ns} edges={es} search="" {...base} relFilter={new Set<RelCategory>(['scheduling'])} selectedId="1" />
    )).container
    expect(faded(disruption)).toBe(2)
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

  it('collapse pill is a keyboard-operable button (role/aria-label/aria-expanded + Enter/Space)', () => {
    // A crowded same-kind cluster folds; the "+ show N more" pill is the ONLY way to reveal it, so it
    // must be a real button (a bare <g><title> was mouse-only and unnamed to a screen reader).
    const owner: KNode = { id: 'd', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const pods: KNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `p-${i}`, kind: 'Pod', name: `web-${i}`, health: 'Healthy' as const }))
    const owns: KEdge[] = pods.map((p) => ({ from: 'd', to: p.id, type: 'ownerReference' as const }))
    const { container } = render(() => <Topology nodes={[owner, ...pods]} edges={owns} search="" {...base} />)
    const pill = container.querySelector('.collapse-pill') as SVGGElement
    expect(pill).toBeTruthy()
    expect(pill.getAttribute('role')).toBe('button')
    expect(pill.getAttribute('tabindex')).toBe('0')
    expect(pill.getAttribute('aria-label')).toMatch(/^Show \d+ more Pods$/)
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    const podCount = () => container.querySelectorAll('.node.kind-pod').length
    const pillExpanded = () => (container.querySelector('.collapse-pill') as SVGGElement).getAttribute('aria-expanded')
    const collapsed = podCount()
    // Enter activates it like a native button → the cluster expands (more pods drawn, state flips).
    pill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(podCount()).toBeGreaterThan(collapsed)
    expect(pillExpanded()).toBe('true')
    // Space is the other native-button activation key and runs the same toggle → folds back.
    ;(container.querySelector('.collapse-pill') as SVGGElement).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(pillExpanded()).toBe('false')
  })

  it('search match count includes folded matches, not just on-canvas cards', () => {
    // A Deployment "web" with 8 pods folds (the middle 5 hide behind the pill). Search "web" matches
    // all 9 resources, but 5 are folded. The toolbar count must report the honest total (9), not the
    // on-canvas-only count (4) — otherwise it disagrees with the bottom overlay and the Enter-cycle
    // silently skips every folded match (the live-found "38 vs 158" divergence).
    const owner: KNode = { id: 'd', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const pods: KNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `p-${i}`, kind: 'Pod', name: `web-${i}`, health: 'Healthy' as const }))
    const owns: KEdge[] = pods.map((p) => ({ from: 'd', to: p.id, type: 'ownerReference' as const }))
    const { container } = render(() => <Topology nodes={[owner, ...pods]} edges={owns} search="web" {...base} />)
    expect(container.querySelector('.collapse-pill')).toBeTruthy() // the fold actually happened
    expect(container.querySelector('.topology-matches')?.textContent).toMatch(/9 match/)
  })

  it('auto-expands the fold when navigation selects a hidden node (so it gets its .selected marker)', () => {
    // Enter-cycle / j-k stepping / deep-links walk the FULL node set, so a target is often a node
    // folded behind a "+N more" pill — the drawer opens but the card isn't drawn, leaving no on-canvas
    // cue. Selecting a hidden node must auto-expand its containing fold so the card renders, .selected.
    const owner: KNode = { id: 'd', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const pods: KNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `p-${i}`, kind: 'Pod', name: `web-${i}`, health: 'Healthy' as const }))
    const owns: KEdge[] = pods.map((p) => ({ from: 'd', to: p.id, type: 'ownerReference' as const }))
    // web-0 (head) + web-6/web-7 (tail) stay visible; web-1..web-5 fold. p-3 (web-3) is in the hidden
    // middle, so without auto-expand it would not render at all.
    const { container } = render(() => <Topology nodes={[owner, ...pods]} edges={owns} search="" {...base} selectedId="p-3" />)
    // The folded pod now renders with its .selected marker (name may be middle-truncated to fit the
    // card — "…-3" — so assert the ordinal suffix, not the full string).
    const selected = container.querySelector('.node.selected .node-name')
    expect(selected).toBeTruthy()
    expect(selected?.textContent).toMatch(/-3$/)
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

  it('Kind grouping never renders relationship arrows, even with a resource selected', () => {
    // The cross-kind backbone fans across the per-kind matrix with no meaningful routing, so the
    // lines are pure noise — suppressed entirely. Unselected: no edges.
    const none = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" />)
    expect(none.container.querySelectorAll('.edges > g').length).toBe(0)
    cleanup()
    // Selected: still no arrows (the selection spotlight lights the related subtree instead). This is
    // the whole point of the change — arrows stayed tangled across boxes rather than tracing a path.
    const sel = render(() => (
      <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" selectedId="1" />
    ))
    expect(sel.container.querySelectorAll('.edges > g').length).toBe(0)
    // The spotlight still works: selecting the Deployment fades the unrelated api-xyz Pod.
    expect(sel.container.querySelectorAll('g.node.faded').length).toBeGreaterThan(0)
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

  // Relationships-hidden hint: the relationship grouping with an empty relFilter draws cards with no
  // edges, which is visually identical to "these resources have no connections" — so surface that the
  // edges are hidden by choice, with a one-click restore (cluster-scope drawer cycle's sibling case).
  describe('relationships-hidden hint', () => {
    const emptyRels = () => new Set<RelCategory>()
    it('shows when grouping by relationship with no relationships selected and edges exist', () => {
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="relationship" relFilter={emptyRels()} onRelFilter={() => {}} />
      ))
      const hint = container.querySelector('.topology-rels-hidden')
      expect(hint).toBeTruthy()
      expect(hint!.textContent).toContain('Relationships hidden')
    })
    it('hides once a relationship category is selected', () => {
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="relationship" relFilter={new Set<RelCategory>(['ownership'])} />
      ))
      expect(container.querySelector('.topology-rels-hidden')).toBeNull()
    })
    it('stays hidden when no relationships exist to toggle (the disconnection is real, not filtered)', () => {
      const { container } = render(() => (
        <Topology nodes={nodes} edges={[]} search="" {...base} groupBy="relationship" relFilter={emptyRels()} onRelFilter={() => {}} />
      ))
      expect(container.querySelector('.topology-rels-hidden')).toBeNull()
    })
    it('is absent in the kind grouping (edges are never drawn there)', () => {
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="kind" relFilter={emptyRels()} kindFilter={new Set<string>()} onKindFilter={() => {}} />
      ))
      expect(container.querySelector('.topology-rels-hidden')).toBeNull()
    })
    it('the show-ownership action requests the ownership category', () => {
      let requested: RelCategory | null = null
      const { container } = render(() => (
        <Topology nodes={nodes} edges={edges} search="" {...base} groupBy="relationship" relFilter={emptyRels()} onRelFilter={(c) => (requested = c)} />
      ))
      fireEvent.click(container.querySelector('.topology-rels-hidden button')!)
      expect(requested).toBe('ownership')
    })
  })
})
