import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import Sidebar from './Sidebar'
import type { NamespaceInfo } from '../api'

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
