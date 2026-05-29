import { describe, expect, it } from 'vitest'
import { hostGroups, kindGroups, layoutGraph, layoutGraphByHost, layoutGraphByKind, NODE_HEIGHT, NODE_WIDTH } from './layout'
import type { KEdge, KNode } from './types'

const nodes: KNode[] = [
  { id: 'dep', kind: 'Deployment', name: 'web', health: 'Healthy' },
  { id: 'rs', kind: 'ReplicaSet', name: 'web-x', health: 'Healthy' },
  { id: 'p1', kind: 'Pod', name: 'web-x-1', health: 'Healthy' },
  { id: 'p2', kind: 'Pod', name: 'web-x-2', health: 'Progressing' },
]
const edges: KEdge[] = [
  { from: 'dep', to: 'rs', type: 'ownerReference' },
  { from: 'rs', to: 'p1', type: 'ownerReference' },
  { from: 'rs', to: 'p2', type: 'ownerReference' },
]

describe('layoutGraph', () => {
  it('positions every node and sizes the canvas', () => {
    const l = layoutGraph(nodes, edges)
    expect(l.nodes).toHaveLength(4)
    for (const n of l.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(n.width).toBe(NODE_WIDTH)
      expect(n.height).toBe(NODE_HEIGHT)
    }
    expect(l.width).toBeGreaterThan(0)
    expect(l.height).toBeGreaterThan(0)
  })

  it('lays parents above their children (top-to-bottom)', () => {
    const l = layoutGraph(nodes, edges)
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    expect(y('dep')).toBeLessThan(y('rs'))
    expect(y('rs')).toBeLessThan(y('p1'))
    expect(y('rs')).toBeLessThan(y('p2'))
  })

  it('produces routed points for each edge', () => {
    const l = layoutGraph(nodes, edges)
    expect(l.edges).toHaveLength(3)
    for (const e of l.edges) expect(e.points.length).toBeGreaterThanOrEqual(2)
  })

  it('drops edges with a missing endpoint instead of throwing', () => {
    const l = layoutGraph(nodes, [...edges, { from: 'rs', to: 'ghost', type: 'ownerReference' }])
    expect(l.edges).toHaveLength(3)
  })

  it('stacks disconnected trees in a single vertical column, never side by side', () => {
    // 8 independent single-pod trees, like a real namespace. The contract: each tree gets its own
    // row, every tree left-aligned to a shared gutter, never two trees on the same horizontal band.
    const many: KNode[] = []
    const manyEdges: KEdge[] = []
    for (let i = 0; i < 8; i++) {
      const tag = String.fromCharCode(97 + i) // a, b, c, … so names sort distinctly
      many.push({ id: `d${i}`, kind: 'Deployment', name: `app-${tag}`, health: 'Healthy' })
      many.push({ id: `p${i}`, kind: 'Pod', name: `app-${tag}-0`, health: 'Healthy' })
      manyEdges.push({ from: `d${i}`, to: `p${i}`, type: 'ownerReference' })
    }
    const l = layoutGraph(many, manyEdges, 'LR')
    expect(l.nodes).toHaveLength(16)

    const band = (i: number) => {
      const ns = l.nodes.filter((n) => n.id === `d${i}` || n.id === `p${i}`)
      return {
        top: Math.min(...ns.map((n) => n.y - n.height / 2)),
        bottom: Math.max(...ns.map((n) => n.y + n.height / 2)),
        left: Math.min(...ns.map((n) => n.x - n.width / 2)),
      }
    }
    const bands = Array.from({ length: 8 }, (_, i) => band(i)).sort((a, b) => a.top - b.top)
    // No two trees overlap vertically → strictly one tree per row.
    for (let i = 1; i < bands.length; i++) expect(bands[i].top).toBeGreaterThanOrEqual(bands[i - 1].bottom)
    // Every tree starts at the same left edge (the shared gutter).
    const lefts = bands.map((b) => b.left)
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThan(1)
    // The column is one tree wide (not eight), and tall — roughly one row per tree.
    expect(l.width).toBeLessThan(NODE_WIDTH * 4)
    expect(l.height).toBeGreaterThan(NODE_HEIGHT * 6)
  })

  it('keeps a tree in its row (stable order) as another tree gains a pod', () => {
    // alpha sorts before bravo by componentKey ("Deployment/alpha" < "Deployment/bravo"), so alpha
    // is the top row. When bravo grows a pod its tree gets taller, but alpha — placed first — must
    // not move: ordering is by the stable key, not by component height or node UID.
    const nodes0: KNode[] = [
      { id: 'da', kind: 'Deployment', name: 'alpha', health: 'Healthy' },
      { id: 'pa', kind: 'Pod', name: 'alpha-0', health: 'Healthy' },
      { id: 'db', kind: 'Deployment', name: 'bravo', health: 'Healthy' },
      { id: 'pb0', kind: 'Pod', name: 'bravo-0', health: 'Healthy' },
    ]
    const edges0: KEdge[] = [
      { from: 'da', to: 'pa', type: 'ownerReference' },
      { from: 'db', to: 'pb0', type: 'ownerReference' },
    ]
    const ay0 = layoutGraph(nodes0, edges0, 'LR').nodes.find((n) => n.id === 'da')!.y
    const nodes1: KNode[] = [...nodes0, { id: 'pb1', kind: 'Pod', name: 'bravo-1', health: 'Healthy' }]
    const edges1: KEdge[] = [...edges0, { from: 'db', to: 'pb1', type: 'ownerReference' }]
    const l1 = layoutGraph(nodes1, edges1, 'LR')
    expect(l1.nodes.find((n) => n.id === 'da')!.y).toBe(ay0) // alpha kept its row
    expect(l1.nodes.find((n) => n.id === 'da')!.y).toBeLessThan(l1.nodes.find((n) => n.id === 'db')!.y)
  })

  it('grid-wraps a high-fanout hub instead of one wide rank', () => {
    // One Node with 20 pods scheduled on it (nodes view): scheduledOn edges point pod -> node.
    const hub: KNode = { id: 'node', kind: 'Node', name: 'n1', health: 'Healthy' }
    const pods: KNode[] = []
    const e: KEdge[] = []
    for (let i = 0; i < 20; i++) {
      pods.push({ id: `p${i}`, kind: 'Pod', name: `pod-${i}`, health: 'Healthy' })
      e.push({ from: `p${i}`, to: 'node', type: 'scheduledOn' })
    }
    const l = layoutGraph([hub, ...pods], e)
    expect(l.nodes).toHaveLength(21)
    // 20 pods in one rank would be ~20*NODE_WIDTH wide (>3800). Wrapping keeps it under ~5 columns.
    expect(l.width).toBeLessThan(NODE_WIDTH * 8)
    // No overlapping cards: every node center is distinct.
    const seen = new Set(l.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`))
    expect(seen.size).toBe(l.nodes.length)
  })

  it('keeps each tree internally top-to-bottom after packing', () => {
    const l = layoutGraph(nodes, edges)
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    expect(y('dep')).toBeLessThan(y('rs'))
    expect(y('rs')).toBeLessThan(y('p1'))
  })

  it('lays parents left of their children in LR (Ownership view orientation, cycle 310)', () => {
    const l = layoutGraph(nodes, edges, 'LR')
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x
    expect(x('dep')).toBeLessThan(x('rs'))
    expect(x('rs')).toBeLessThan(x('p1'))
    expect(x('rs')).toBeLessThan(x('p2'))
  })

  it('grid-wraps a high-fanout hub in LR into columns, not one tall single-file stack (cycle 310)', () => {
    // A ReplicaSet owning 24 pods. In LR a naive layout stacks all 24 in one vertical rank
    // (~24*NODE_HEIGHT ≈ 1900px tall); the orientation-aware wrap must break them into columns
    // that grow rightward instead, keeping the block from becoming an unreadable tall ribbon.
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web-x', health: 'Healthy' }
    const pods: KNode[] = []
    const e: KEdge[] = []
    for (let i = 0; i < 24; i++) {
      pods.push({ id: `p${i}`, kind: 'Pod', name: `web-x-${i}`, health: 'Healthy' })
      e.push({ from: 'rs', to: `p${i}`, type: 'ownerReference' })
    }
    const l = layoutGraph([rs, ...pods], e, 'LR')
    expect(l.nodes).toHaveLength(25)
    // Single-file would be ~24 rows tall; wrapping keeps it well under that.
    expect(l.height).toBeLessThan(NODE_HEIGHT * 12)
    // The pods sit to the RIGHT of their ReplicaSet (children flow rightward in LR).
    const rsx = l.nodes.find((n) => n.id === 'rs')!.x
    expect(pods.every((pod) => l.nodes.find((n) => n.id === pod.id)!.x > rsx)).toBe(true)
    // No two cards share a center (no overlap).
    const seen = new Set(l.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`))
    expect(seen.size).toBe(l.nodes.length)
  })
})

describe('layoutGraphByKind', () => {
  // A snapshot with several kinds drives the kind-grouped layout: every Deployment in one
  // box, every Pod in another, kind boxes shelf-packed into the viewport. This is the
  // "All" view's contract (FR-006) — same input as layoutGraph, fundamentally different
  // grouping.
  const allKindsNodes: KNode[] = [
    { id: 'dep1', kind: 'Deployment', name: 'web', health: 'Healthy' },
    { id: 'dep2', kind: 'Deployment', name: 'api', health: 'Healthy' },
    { id: 'svc1', kind: 'Service', name: 'web', health: 'Healthy' },
    { id: 'svc2', kind: 'Service', name: 'api', health: 'Healthy' },
    { id: 'pod1', kind: 'Pod', name: 'web-1', health: 'Healthy' },
    { id: 'pod2', kind: 'Pod', name: 'web-2', health: 'Progressing' },
    { id: 'pod3', kind: 'Pod', name: 'api-1', health: 'Healthy' },
  ]

  it('groups nodes into one box per kind and positions every node', () => {
    const l = layoutGraphByKind(allKindsNodes, [])
    expect(l.nodes).toHaveLength(allKindsNodes.length)
    for (const n of l.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
      expect(n.width).toBe(NODE_WIDTH)
      expect(n.height).toBe(NODE_HEIGHT)
    }
    const groups = kindGroups(l)
    expect(groups.map((g) => g.kind)).toEqual(['Deployment', 'Pod', 'Service'])
    // Each group's bounding box contains every node of that kind.
    for (const g of groups) {
      const members = l.nodes.filter((n) => n.kind === g.kind)
      for (const n of members) {
        expect(n.x - n.width / 2).toBeGreaterThanOrEqual(g.x - 0.001)
        expect(n.x + n.width / 2).toBeLessThanOrEqual(g.x + g.width + 0.001)
        expect(n.y - n.height / 2).toBeGreaterThanOrEqual(g.y - 0.001)
        expect(n.y + n.height / 2).toBeLessThanOrEqual(g.y + g.height + 0.001)
      }
    }
  })

  it('draws cross-kind edges as straight lines between resolved node positions', () => {
    // A Deployment owns a Pod across two kind boxes — the edge survives kind grouping so
    // the ownership backbone is still visible in the All view.
    const e: KEdge[] = [{ from: 'dep1', to: 'pod1', type: 'ownerReference' }]
    const l = layoutGraphByKind(allKindsNodes, e)
    expect(l.edges).toHaveLength(1)
    expect(l.edges[0].points).toHaveLength(2)
    const from = l.nodes.find((n) => n.id === 'dep1')!
    const to = l.nodes.find((n) => n.id === 'pod1')!
    expect(l.edges[0].points[0].x).toBeCloseTo(from.x, 5)
    expect(l.edges[0].points[0].y).toBeCloseTo(from.y, 5)
    expect(l.edges[0].points[1].x).toBeCloseTo(to.x, 5)
    expect(l.edges[0].points[1].y).toBeCloseTo(to.y, 5)
  })

  it('handles an empty graph', () => {
    const l = layoutGraphByKind([], [])
    expect(l.nodes).toEqual([])
    expect(l.edges).toEqual([])
  })
})

describe('layoutGraphByHost (Nodes view, cycle 205)', () => {
  const hostNodes: KNode[] = [
    { id: 'n1', kind: 'Node', name: 'node-a', health: 'Healthy' },
    { id: 'n2', kind: 'Node', name: 'node-b', health: 'Healthy' },
    { id: 'p1', kind: 'Pod', name: 'p1', health: 'Healthy', host: 'node-a' },
    { id: 'p2', kind: 'Pod', name: 'p2', health: 'Degraded', host: 'node-a' },
    { id: 'p3', kind: 'Pod', name: 'p3', health: 'Healthy', host: 'node-b' },
    { id: 'p4', kind: 'Pod', name: 'unscheduled', health: 'Progressing', host: '' },
  ]
  const hostEdges: KEdge[] = [
    { from: 'p1', to: 'n1', type: 'scheduledOn' },
    { from: 'p2', to: 'n1', type: 'scheduledOn' },
    { from: 'p3', to: 'n2', type: 'scheduledOn' },
  ]

  it('groups pods under their host (Node card + pods sit in one container)', () => {
    const l = layoutGraphByHost(hostNodes, hostEdges)
    expect(l.nodes).toHaveLength(6)
    // No scheduledOn lines — containment implies the relationship in this view.
    expect(l.edges).toEqual([])
    const groups = hostGroups(l)
    const labels = groups.map((g) => g.label).sort()
    // Two hosts + an orphan group ("Unscheduled") for the pod with no matching Node card.
    expect(labels).toEqual(['Unscheduled', 'node-a', 'node-b'])
  })

  it('places the Node card and its pods inside the same host-group rect', () => {
    const l = layoutGraphByHost(hostNodes, hostEdges)
    const groups = hostGroups(l)
    const a = groups.find((g) => g.label === 'node-a')!
    const insideA = l.nodes.filter((n) => (n.kind === 'Node' && n.name === 'node-a') || n.host === 'node-a')
    for (const n of insideA) {
      expect(n.x - n.width / 2).toBeGreaterThanOrEqual(a.x - 0.001)
      expect(n.x + n.width / 2).toBeLessThanOrEqual(a.x + a.width + 0.001)
      expect(n.y - n.height / 2).toBeGreaterThanOrEqual(a.y - 0.001)
      expect(n.y + n.height / 2).toBeLessThanOrEqual(a.y + a.height + 0.001)
    }
  })

  it('handles an empty graph', () => {
    expect(layoutGraphByHost([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})
