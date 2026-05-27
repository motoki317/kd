import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import Topology from './Topology'
import type { KEdge, KNode } from '../types'

afterEach(cleanup)

const nodes: KNode[] = [
  { id: '1', kind: 'Deployment', name: 'web', health: 'Healthy' },
  { id: '2', kind: 'Pod', name: 'web-abc', health: 'Degraded' },
  { id: '3', kind: 'Pod', name: 'api-xyz', health: 'Healthy' },
]
const edges: KEdge[] = [{ from: '1', to: '2', type: 'ownerReference' }]

const base = { selectedId: null, connected: true, onSearch: () => {}, onSelect: () => {} }
const faded = (c: Element) => c.querySelectorAll('g.node.faded').length

describe('Topology', () => {
  it('renders one chip per node', () => {
    const { container } = render(() => <Topology nodes={nodes} edges={edges} search="" {...base} />)
    expect(container.querySelectorAll('g.node').length).toBe(3)
    expect(faded(container)).toBe(0)
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
})
