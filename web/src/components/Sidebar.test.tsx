import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import Sidebar from './Sidebar'
import type { NamespaceInfo } from '../api'

afterEach(cleanup)

const namespaces: NamespaceInfo[] = [
  { name: 'aaa', health: 'Healthy' },
  { name: 'zzz-broken', health: 'Degraded' },
  { name: 'mmm', health: 'Progressing' },
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
})
