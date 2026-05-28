import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import { CLUSTER_SCOPE, type NamespaceInfo } from '../api'

afterEach(cleanup)

const namespaces: NamespaceInfo[] = [
  { name: 'aaa', health: 'Healthy' },
  { name: 'zzz-broken', health: 'Degraded', nonReady: 3 },
  { name: 'mmm', health: 'Progressing', nonReady: 1 },
  { name: 'bbb', health: 'Healthy' },
]

const noop = () => {}

describe('Sidebar', () => {
  it('sorts troubled namespaces first (severity, then name) and counts them', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    const order = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    // Degraded > Progressing > the two Healthy (alphabetical) — independent of input order.
    expect(order).toEqual(['zzz-broken', 'mmm', 'aaa', 'bbb'])
    expect(container.querySelector('.ns-trouble')?.textContent).toBe('2')
    // Each troubled namespace shows its non-ready count; healthy ones show none.
    const counts = [...container.querySelectorAll('.ns-count')].map((e) => e.textContent)
    expect(counts).toEqual(['3', '1'])
  })

  it('filters the list by name', async () => {
    const { container, getByPlaceholderText } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: 'bbb' } })
    const names = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    expect(names).toEqual(['bbb'])
  })

  it('shows an error message when loading failed', () => {
    const { getByText } = render(() => <Sidebar namespaces={[]} selected={null} onSelect={noop} loading={false} failed={true} />)
    expect(getByText("Couldn't load namespaces.")).toBeTruthy()
  })

  it('distinguishes no namespaces visible from no filter matches', () => {
    const { getByText } = render(() => <Sidebar namespaces={[]} selected={null} onSelect={noop} loading={false} failed={false} />)
    expect(getByText('No namespaces visible.')).toBeTruthy()
  })

  it('pins the [cluster] pseudo-namespace above the list and outside the filter (FR-004)', async () => {
    const withCluster: NamespaceInfo[] = [
      { name: CLUSTER_SCOPE, health: 'Degraded', nonReady: 1 },
      { name: 'aaa', health: 'Healthy' },
      { name: 'bbb', health: 'Healthy' },
    ]
    const onSelect = vi.fn()
    const { container, getByText, getByPlaceholderText } = render(() => (
      <Sidebar namespaces={withCluster} selected={null} onSelect={onSelect} loading={false} failed={false} />
    ))
    // Pinned first regardless of name sort, identified by its [cluster] label.
    expect(getByText('[cluster]')).toBeTruthy()
    // The cluster entry sits above the namespaces list visually — it's the first ns-name.
    const names = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    expect(names[0]).toBe('[cluster]')
    // The cluster entry is excluded from the troubled-count badge so the badge keeps
    // describing namespace trouble specifically.
    expect(container.querySelector('.ns-trouble')).toBeNull()
    // Filter doesn't drop the pinned entry — operator can always jump to cluster scope.
    fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: 'aaa' } })
    expect(getByText('[cluster]')).toBeTruthy()
    // Click forwards CLUSTER_SCOPE through onSelect — the server uses this exact value in URLs.
    fireEvent.click(getByText('[cluster]'))
    expect(onSelect).toHaveBeenCalledWith(CLUSTER_SCOPE)
  })

  it('degraded [cluster] entry does not shift the divider (cluster scope excluded from dividerAt)', () => {
    // A degraded [cluster] entry + one troubled namespace + two healthy ones: the divider
    // should appear between the one troubled namespace and the two healthy ones — [cluster]
    // must not count as the first troubled namespace, which would place the divider at index 0
    // (hiding the boundary).
    const withClusterDegraded: NamespaceInfo[] = [
      { name: CLUSTER_SCOPE, health: 'Degraded', nonReady: 2 },
      { name: 'a', health: 'Degraded', nonReady: 1 },
      { name: 'b', health: 'Healthy' },
      { name: 'c', health: 'Healthy' },
    ]
    const { container } = render(() => (
      <Sidebar namespaces={withClusterDegraded} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Exactly one divider between the troubled and healthy namespaces (not zero).
    expect(container.querySelectorAll('.ns-divider').length).toBe(1)
  })

  it('inserts a divider between troubled and healthy namespaces (none when all-troubled / all-healthy)', () => {
    // Mixed: divider should render once between the troubled group and the healthy group.
    const mixed = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    expect(mixed.container.querySelectorAll('.ns-divider').length).toBe(1)
    cleanup()
    // All healthy: no boundary to mark.
    const allHealthy: NamespaceInfo[] = [
      { name: 'a', health: 'Healthy' },
      { name: 'b', health: 'Healthy' },
    ]
    const healthy = render(() => (
      <Sidebar namespaces={allHealthy} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    expect(healthy.container.querySelectorAll('.ns-divider').length).toBe(0)
    cleanup()
    // All troubled: no boundary to mark either.
    const allTroubled: NamespaceInfo[] = [
      { name: 'a', health: 'Degraded', nonReady: 1 },
      { name: 'b', health: 'Progressing', nonReady: 1 },
    ]
    const troubled = render(() => (
      <Sidebar namespaces={allTroubled} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    expect(troubled.container.querySelectorAll('.ns-divider').length).toBe(0)
  })
})
