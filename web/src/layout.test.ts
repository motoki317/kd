import { describe, expect, it } from 'vitest'
import { COLLAPSE_VISIBLE, connGroups, hostGroups, kindGroups, layoutGraph, layoutGraphByHost, layoutGraphByKind, NODE_HEIGHT, NODE_WIDTH } from './layout'
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

  it('collapses a high-fanout hub to the newest COLLAPSE_VISIBLE + a "+N older" pill, kept compact', () => {
    // One owner with 20 child pods (fan-OUT): ownerReference edges point owner -> pod. The crowd folds
    // to the newest COLLAPSE_VISIBLE pods + one pill (the older remainder), grid-wrapped.
    const hub: KNode = { id: 'owner', kind: 'ReplicaSet', name: 'r1', health: 'Healthy' }
    const pods: KNode[] = []
    const e: KEdge[] = []
    for (let i = 0; i < 20; i++) {
      pods.push({ id: `p${i}`, kind: 'Pod', name: `pod-${i}`, health: 'Healthy' })
      e.push({ from: 'owner', to: `p${i}`, type: 'ownerReference' })
    }
    const l = layoutGraph([hub, ...pods], e)
    expect(l.nodes).toHaveLength(1 + COLLAPSE_VISIBLE + 1) // hub + visible + 1 pill
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.hidden).toHaveLength(20 - COLLAPSE_VISIBLE)
    // A single bundled edge stands in for the folded pods' ownerReference edges, drawn in their real
    // direction (owner→pod): the owner is the source, so it runs owner → pill.
    expect(l.edges.some((x) => x.from === 'owner' && x.to === pill.id && x.type === 'ownerReference')).toBe(true)
    // Wrapping keeps it compact, and no two cards share a center.
    expect(l.width).toBeLessThan(NODE_WIDTH * 8)
    const seen = new Set(l.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`))
    expect(seen.size).toBe(l.nodes.length)
  })

  it('does NOT fold a fan-IN hub: its many parents stay aligned in the leftmost depth column', () => {
    // The Volumes "weird grouping" fix: a shared target (one Secret mounted by 12 Pods) must not fold
    // its degree-1 PARENTS behind a pill. Folding a subset of the Pod kind — while other Pods in the
    // same column stay bare — drew a confusing partial frame around the middle of the parent column.
    // Every parent stays a real card, all sharing depth 0 (the leftmost column), Secret at depth 1.
    const secret: KNode = { id: 'sec', kind: 'Secret', name: 'shared', health: 'Healthy' }
    const pods = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, kind: 'Pod', name: `pod-${i}`, health: 'Healthy' as const }))
    const e: KEdge[] = pods.map((p) => ({ from: p.id, to: 'sec', type: 'mounts' as const }))
    const l = layoutGraph([secret, ...pods], e, 'LR')
    expect(l.nodes.filter((n) => n.collapse)).toHaveLength(0) // no pill — nothing folds
    expect(l.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(12) // every parent rendered
    expect(connGroups(l)).toHaveLength(0) // and no grouping frame in the parent column
    const podX = new Set(l.nodes.filter((n) => n.kind === 'Pod').map((n) => Math.round(n.x)))
    expect(podX.size).toBe(1) // all parents share the leftmost depth column
    expect([...podX][0]).toBeLessThan(l.nodes.find((n) => n.id === 'sec')!.x) // left of the Secret
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

  it('collapses a high-fanout hub in LR, placing the visible cards + pill to the right (cycle 310)', () => {
    // A ReplicaSet owning 24 pods. The fold leaves the newest COLLAPSE_VISIBLE pods + a pill; those
    // still wrap into columns that grow rightward (LR), and the pill sits to the right like a child.
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web-x', health: 'Healthy' }
    const pods: KNode[] = []
    const e: KEdge[] = []
    for (let i = 0; i < 24; i++) {
      pods.push({ id: `p${i}`, kind: 'Pod', name: `web-x-${i}`, health: 'Healthy' })
      e.push({ from: 'rs', to: `p${i}`, type: 'ownerReference' })
    }
    const l = layoutGraph([rs, ...pods], e, 'LR')
    expect(l.nodes).toHaveLength(1 + COLLAPSE_VISIBLE + 1) // rs + visible + 1 pill
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.hidden).toHaveLength(24 - COLLAPSE_VISIBLE)
    expect(l.edges.some((x) => x.from === 'rs' && x.to === pill.id && x.type === 'ownerReference')).toBe(true)
    // Wrapping keeps it compact; the visible children + pill all sit to the RIGHT of the ReplicaSet.
    expect(l.height).toBeLessThan(NODE_HEIGHT * 12)
    const rsx = l.nodes.find((n) => n.id === 'rs')!.x
    expect(l.nodes.filter((n) => n.id !== 'rs').every((n) => n.x > rsx)).toBe(true)
    const seen = new Set(l.nodes.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`))
    expect(seen.size).toBe(l.nodes.length)
  })

  it('keeps a hub’s degree-1 parent to its left so ownerReference flows left→right', () => {
    // Deployment → ReplicaSet → 12 pods. The RS is a hub (many pod children), but its lone Deployment
    // parent must NOT be wrapped onto the children's (right) side — it stays left so dep→rs→pod all
    // point rightward. This is the bug where the RS rendered leftmost with its Deployment beside it.
    const dep: KNode = { id: 'dep', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web-x', health: 'Healthy' }
    const pods = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, kind: 'Pod', name: `web-x-${i}`, health: 'Healthy' as const }))
    const e: KEdge[] = [
      { from: 'dep', to: 'rs', type: 'ownerReference' },
      ...pods.map((p) => ({ from: 'rs', to: p.id, type: 'ownerReference' as const })),
    ]
    const l = layoutGraph([dep, rs, ...pods], e, 'LR')
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x
    expect(l.nodes.find((n) => n.id === 'dep')).toBeTruthy() // a real card, never folded into a pill
    expect(x('dep')).toBeLessThan(x('rs')) // parent left of the hub
    expect(l.nodes.filter((n) => n.kind === 'Pod' && !n.collapse).every((p) => p.x > x('rs'))).toBe(true)
    // The dep→rs ownerReference arrow runs left→right (its drawn start is left of its end).
    const depEdge = l.edges.find((ed) => ed.from === 'dep' && ed.to === 'rs')!
    expect(depEdge.points[0].x).toBeLessThan(depEdge.points[depEdge.points.length - 1].x)
  })

  it('routes LR edges orthogonally: parent right edge → child left edge, axis-aligned segments', () => {
    // Deployment → ReplicaSet → 2 Pods. Each edge must leave the parent's RIGHT edge and enter the
    // child's LEFT edge, with every segment purely horizontal or vertical (the "blocky" ArgoCD look).
    const dep: KNode = { id: 'dep', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web-x', health: 'Healthy' }
    const pods: KNode[] = [
      { id: 'p0', kind: 'Pod', name: 'web-x-0', health: 'Healthy' },
      { id: 'p1', kind: 'Pod', name: 'web-x-1', health: 'Healthy' },
    ]
    const e: KEdge[] = [
      { from: 'dep', to: 'rs', type: 'ownerReference' },
      ...pods.map((p) => ({ from: 'rs', to: p.id, type: 'ownerReference' as const })),
    ]
    const l = layoutGraph([dep, rs, ...pods], e, 'LR')
    const box = (id: string) => l.nodes.find((n) => n.id === id)!
    for (const ed of l.edges) {
      const src = box(ed.from), dst = box(ed.to)
      const pts = ed.points
      // Anchored on the source's right edge and the target's left edge.
      expect(pts[0].x).toBeCloseTo(src.x + src.width / 2, 3)
      expect(pts[0].y).toBeCloseTo(src.y, 3)
      expect(pts[pts.length - 1].x).toBeCloseTo(dst.x - dst.width / 2, 3)
      expect(pts[pts.length - 1].y).toBeCloseTo(dst.y, 3)
      // Every consecutive segment is axis-aligned (shares an x or a y).
      for (let i = 1; i < pts.length; i++) {
        const horizontal = Math.abs(pts[i].y - pts[i - 1].y) < 1e-6
        const vertical = Math.abs(pts[i].x - pts[i - 1].x) < 1e-6
        expect(horizontal || vertical).toBe(true)
      }
    }
  })

  it('seats a hub’s wrapped children the same depth-gap from the parent as an ungrouped child', () => {
    // Regression for "grouped children crowd too close / arrows look stunted": a hub's wrapped leaf
    // grid must sit a full rank-gap from the hub card — the SAME horizontal gap a normal Dagre child
    // gets — not the tighter HUB_GAP it used before. Two disconnected trees, compared:
    //   solo:  one Service → one Pod      (ungrouped — a plain Dagre rank)
    //   hub:   one Service → six Pods     (grouped — wrapped into a per-kind block + a fold pill)
    const soloParent: KNode = { id: 'sp', kind: 'Service', name: 'solo', health: 'Healthy' }
    const soloChild: KNode = { id: 'sc', kind: 'Pod', name: 'solo-pod', health: 'Healthy' }
    const hub: KNode = { id: 'hub', kind: 'Service', name: 'hub', health: 'Healthy' }
    const leaves: KNode[] = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, kind: 'Pod', name: `hub-pod-${i}`, health: 'Healthy' }))
    const edges: KEdge[] = [
      { from: 'sp', to: 'sc', type: 'selects' },
      ...leaves.map((l) => ({ from: 'hub', to: l.id, type: 'selects' as const })),
    ]
    const l = layoutGraph([soloParent, soloChild, hub, ...leaves], edges, 'LR')
    const box = (id: string) => l.nodes.find((n) => n.id === id)!
    const rightOf = (b: { x: number; width: number }) => b.x + b.width / 2
    const leftOf = (b: { x: number; width: number }) => b.x - b.width / 2

    const soloGap = leftOf(box('sc')) - rightOf(box('sp'))
    // The wrapped leaves fold to COLLAPSE_VISIBLE cards + a pill; every one is a direct child of the
    // hub and must share the same left x (one depth). Measure the gap from the hub card to that depth.
    const wrapped = l.nodes.filter((n) => n.kind === 'Pod' && n.name.startsWith('hub-pod'))
    expect(wrapped).toHaveLength(COLLAPSE_VISIBLE) // 6 → 3 shown + a fold pill
    const hubGap = leftOf(wrapped[0]) - rightOf(box('hub'))
    expect(wrapped.every((n) => Math.abs(leftOf(n) - leftOf(wrapped[0])) < 0.5)).toBe(true) // one column
    expect(hubGap).toBeCloseTo(soloGap, 0) // grouped children align with the normal child rank
    expect(hubGap).toBeGreaterThan(60) // and are clearly not crowded at the old ~36px HUB_GAP
  })

  it('aligns nodes into depth columns: same graph-depth ⇒ same x, even with shared/fan-in children', () => {
    // The Volumes "boxes everywhere" case in miniature. Two Pods both mount a shared Secret; one of
    // them also mounts a PVC that binds a PV. By depth: Pods=0, Secret/PVC=1, PV=2. Every node must
    // land in its depth's column (one x per depth) — in particular both Pods share column 0 even
    // though one has a longer downstream chain, and the shared Secret doesn't drag a parent rightward.
    const podA: KNode = { id: 'pa', kind: 'Pod', name: 'pod-a', health: 'Healthy' }
    const podB: KNode = { id: 'pb', kind: 'Pod', name: 'pod-b', health: 'Healthy' }
    const secret: KNode = { id: 'se', kind: 'Secret', name: 'shared', health: 'Healthy' }
    const pvc: KNode = { id: 'pvc', kind: 'PersistentVolumeClaim', name: 'data', health: 'Healthy' }
    const pv: KNode = { id: 'pv', kind: 'PersistentVolume', name: 'vol', health: 'Healthy' }
    const edges: KEdge[] = [
      { from: 'pa', to: 'se', type: 'mounts' },
      { from: 'pb', to: 'se', type: 'mounts' },
      { from: 'pa', to: 'pvc', type: 'mounts' },
      { from: 'pvc', to: 'pv', type: 'mounts' },
    ]
    const l = layoutGraph([podA, podB, secret, pvc, pv], edges, 'LR')
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x
    // Depth 0: both pods share one column.
    expect(x('pa')).toBeCloseTo(x('pb'), 3)
    // Depth 1: the shared Secret and the PVC share the next column.
    expect(x('se')).toBeCloseTo(x('pvc'), 3)
    // Strictly increasing depth: pods < {secret,pvc} < pv.
    expect(x('pa')).toBeLessThan(x('se'))
    expect(x('pvc')).toBeLessThan(x('pv'))
    // Exactly three distinct columns for three depths.
    expect(new Set(l.nodes.map((n) => Math.round(n.x))).size).toBe(3)
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

describe('same-kind collapse (+N older)', () => {
  // n pods with strictly increasing creation times: pod-00 oldest … pod-(n-1) newest.
  const pods = (n: number): KNode[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      kind: 'Pod',
      name: `pod-${String(i).padStart(2, '0')}`,
      health: 'Healthy' as const,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }))

  it('folds everything past the newest COLLAPSE_VISIBLE behind one pill, hiding the OLDEST', () => {
    const l = layoutGraphByKind(pods(12), [])
    const realPods = l.nodes.filter((n) => n.kind === 'Pod' && !n.collapse)
    expect(realPods).toHaveLength(COLLAPSE_VISIBLE) // newest COLLAPSE_VISIBLE stay
    const pill = l.nodes.find((n) => n.collapse)!
    // 12 pods, newest 3 shown → oldest 9 hidden (p0..p8).
    expect(pill.collapse!.hidden.map((n) => n.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
    expect(pill.collapse!.groupKind).toBe('Pod')
    expect(pill.collapse!.expanded).toBe(false)
    const visibleIds = new Set(realPods.map((n) => n.id))
    expect(visibleIds.has('p0')).toBe(false) // oldest is hidden
    expect(visibleIds.has('p11')).toBe(true) // newest is shown
  })

  it('expanding via its key shows all nodes and keeps the pill as a "show fewer" toggle', () => {
    const l = layoutGraphByKind(pods(12), [], new Set(['kind:Pod']))
    expect(l.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(12) // every card now shown
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.expanded).toBe(true) // pill persists to drive the re-collapse
    expect(pill.collapse!.hidden).toHaveLength(9) // still reports what it would refold
  })

  it('does not collapse when it would hide fewer than 2 (4 pods → show all 4)', () => {
    const l = layoutGraphByKind(pods(4), [])
    expect(l.nodes.some((n) => n.collapse)).toBe(false)
    expect(l.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(4)
  })

  it('chooses the oldest by creation time regardless of input order', () => {
    const l = layoutGraphByKind([...pods(12)].reverse(), [])
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.hidden.map((n) => n.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'])
  })

  it('keeps the pill inside its kind box, with no phantom __collapse__ group', () => {
    const l = layoutGraphByKind(pods(12), [])
    const groups = kindGroups(l)
    expect(groups.map((g) => g.kind)).toEqual(['Pod'])
    const pill = l.nodes.find((n) => n.collapse)!
    const g = groups[0]
    expect(pill.x - pill.width / 2).toBeGreaterThanOrEqual(g.x - 0.001)
    expect(pill.x + pill.width / 2).toBeLessThanOrEqual(g.x + g.width + 0.001)
  })

  it('connectivity: expanding a sibling-set shows all leaves, keeps a show-fewer pill, drops the bundle edge', () => {
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web', health: 'Healthy' }
    const leaves = pods(12)
    const e: KEdge[] = leaves.map((p) => ({ from: 'rs', to: p.id, type: 'ownerReference' as const }))
    const collapsed = layoutGraph([rs, ...leaves], e, 'LR')
    expect(collapsed.nodes.some((n) => n.collapse && !n.collapse.expanded)).toBe(true)
    const expanded = layoutGraph([rs, ...leaves], e, 'LR', new Set(['sib:rs:Pod']))
    expect(expanded.nodes.filter((n) => n.kind === 'Pod')).toHaveLength(12) // every leaf now drawn
    expect(expanded.nodes.some((n) => n.collapse?.expanded)).toBe(true) // show-fewer pill persists
    // No bundled hub→pill edge while expanded — each leaf has its own hub edge instead.
    expect(expanded.edges.some((x) => x.to.startsWith('__collapse__'))).toBe(false)
  })

  it('connectivity: frames a folded kind block per kind, growing on expand', () => {
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web', health: 'Healthy' }
    const leaves = pods(12)
    const e: KEdge[] = leaves.map((p) => ({ from: 'rs', to: p.id, type: 'ownerReference' as const }))
    const frames = connGroups(layoutGraph([rs, ...leaves], e, 'LR'))
    expect(frames.map((f) => f.key)).toEqual(['sib:rs:Pod']) // one per-kind frame
    expect(frames[0].expanded).toBe(false)
    // The frame grows once the kind is unfolded (all its cards now drawn inside it).
    const expanded = connGroups(layoutGraph([rs, ...leaves], e, 'LR', new Set(['sib:rs:Pod'])))
    expect(expanded[0].expanded).toBe(true)
    expect(expanded[0].height).toBeGreaterThan(frames[0].height) // taller column when unfolded
  })

  it('connectivity: frames a kind only when it folds, not merely when it has ≥2 cards', () => {
    // A hub with 3 ConfigMaps (below the fold threshold → no pill) and 6 Services (folds). The border
    // must appear only with the show-more pill, so just the Service block is framed — the 3 ConfigMaps
    // stay bare even though they're a 3-card group.
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'main', health: 'Healthy' }
    const cms = pods(3).map((p) => ({ ...p, id: `cm-${p.id}`, kind: 'ConfigMap', name: `cm-${p.name}` }))
    const svcs = pods(6).map((p) => ({ ...p, id: `svc-${p.id}`, kind: 'Service', name: `svc-${p.name}` }))
    const kids = [...cms, ...svcs]
    const e: KEdge[] = kids.map((n) => ({ from: 'es', to: n.id, type: 'ownerReference' as const }))
    const l = layoutGraph([owner, ...kids], e, 'LR')
    expect(connGroups(l).map((f) => f.key)).toEqual(['sib:es:Service']) // only the folding kind framed
    expect(l.nodes.filter((n) => n.kind === 'ConfigMap')).toHaveLength(3) // CMs all shown, just unframed
  })

  it('connectivity: a multi-kind hub groups + folds each kind independently', () => {
    // A CRD-style owner with many Services AND many Secrets: each kind gets its own frame, its own
    // pill, and folds on its own — no mixed-kind grouping.
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'main', health: 'Healthy' }
    const svcs = pods(6).map((p) => ({ ...p, id: `svc-${p.id}`, kind: 'Service', name: `svc-${p.name}` }))
    const secrets = pods(9).map((p) => ({ ...p, id: `sec-${p.id}`, kind: 'Secret', name: `sec-${p.name}` }))
    const e: KEdge[] = [...svcs, ...secrets].map((n) => ({ from: 'es', to: n.id, type: 'ownerReference' as const }))
    const l = layoutGraph([owner, ...svcs, ...secrets], e, 'LR')
    // Two pills (one per kind), folding the older Services (6→3) and Secrets (9→6) separately.
    const pillHidden = l.nodes.filter((n) => n.collapse).map((n) => n.collapse!.hidden.length).sort((a, b) => a - b)
    expect(pillHidden).toEqual([3, 6])
    // Two distinct per-kind frames.
    const frames = connGroups(l).sort((a, b) => a.key.localeCompare(b.key))
    expect(frames.map((f) => f.key)).toEqual(['sib:es:Secret', 'sib:es:Service'])
    const [secF, svcF] = frames
    // Both kinds are direct children → SAME depth (same left x), stacked vertically (disjoint in y).
    expect(Math.abs(secF.x - svcF.x)).toBeLessThan(1)
    const disjointY = secF.y + secF.height <= svcF.y || svcF.y + svcF.height <= secF.y
    expect(disjointY).toBe(true)
  })

  it('connectivity: all of a hub’s direct children share one depth (x), whatever their kind', () => {
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'main', health: 'Healthy' }
    const svcs = pods(6).map((p) => ({ ...p, id: `svc-${p.id}`, kind: 'Service', name: `svc-${p.name}` }))
    const secrets = pods(9).map((p) => ({ ...p, id: `sec-${p.id}`, kind: 'Secret', name: `sec-${p.name}` }))
    const cms = pods(2).map((p) => ({ ...p, id: `cm-${p.id}`, kind: 'ConfigMap', name: `cm-${p.name}` }))
    const kids = [...svcs, ...secrets, ...cms]
    const e: KEdge[] = kids.map((n) => ({ from: 'es', to: n.id, type: 'ownerReference' as const }))
    const l = layoutGraph([owner, ...kids], e, 'LR')
    // Every real child card (not the owner, not a pill) sits at the same x column to the owner's right.
    const childXs = l.nodes.filter((n) => n.id !== 'es' && !n.collapse).map((n) => Math.round(n.x))
    expect(new Set(childXs).size).toBe(1) // one depth level for all kinds
    expect(childXs[0]).toBeGreaterThan(l.nodes.find((n) => n.id === 'es')!.x)
  })

  it('connectivity: a hub with no fold gets no frame', () => {
    const rs: KNode = { id: 'rs', kind: 'ReplicaSet', name: 'web', health: 'Healthy' }
    const leaves = pods(4) // below the collapse threshold → nothing folds
    const e: KEdge[] = leaves.map((p) => ({ from: 'rs', to: p.id, type: 'ownerReference' as const }))
    expect(connGroups(layoutGraph([rs, ...leaves], e, 'LR'))).toHaveLength(0)
  })

  it('connectivity: two parents fold their own siblings independently', () => {
    const rsA: KNode = { id: 'rsA', kind: 'ReplicaSet', name: 'a', health: 'Healthy' }
    const rsB: KNode = { id: 'rsB', kind: 'ReplicaSet', name: 'b', health: 'Healthy' }
    const podsA = pods(12).map((p) => ({ ...p, id: `a-${p.id}` }))
    const podsB = pods(15).map((p) => ({ ...p, id: `b-${p.id}` }))
    const e: KEdge[] = [
      ...podsA.map((p) => ({ from: 'rsA', to: p.id, type: 'ownerReference' as const })),
      ...podsB.map((p) => ({ from: 'rsB', to: p.id, type: 'ownerReference' as const })),
    ]
    const l = layoutGraph([rsA, ...podsA, rsB, ...podsB], e, 'LR')
    const pills = l.nodes.filter((n) => n.collapse)
    expect(pills.map((p) => p.collapse!.hidden.length).sort((a, b) => a - b)).toEqual([9, 12]) // 12→9, 15→12
  })

  it('collapses a host’s pods but never the Node card', () => {
    const nodeCard: KNode = { id: 'node', kind: 'Node', name: 'node-a', health: 'Healthy' }
    const hostPods = pods(12).map((p) => ({ ...p, host: 'node-a' }))
    const l = layoutGraphByHost([nodeCard, ...hostPods], [])
    expect(l.nodes.find((n) => n.id === 'node')).toBeTruthy() // Node card always shown
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.hidden).toHaveLength(9)
    expect(pill.collapse!.groupKind).toBe('Pod')
    // The pill rides in the host container (attributed via its host field).
    const hg = hostGroups(l).find((g) => g.host === 'node-a')!
    expect(pill.x + pill.width / 2).toBeLessThanOrEqual(hg.x + hg.width + 0.001)
  })
})
