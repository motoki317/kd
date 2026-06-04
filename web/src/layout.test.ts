import { describe, expect, it } from 'vitest'
import { COLLAPSE_VISIBLE, connGroups, formatQuantity, hostGroups, kindGroups, layoutGraph, layoutGraphByCapacity, layoutGraphByHost, layoutGraphByKind, NODE_HEIGHT, NODE_WIDTH } from './layout'
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

  it('folds a crowded same-kind sibling group even when the siblings own subtrees (status-agnostic)', () => {
    // Motivating case: many Workflows under one WorkflowTemplate, where some Workflows own Pods
    // (degree > 1) so the leaf-block path never folds them. The whole Workflow group folds by natural
    // name order, keeping the first + last two — and a hidden Workflow's Pod subtree folds with it
    // (restored on expand).
    const tmpl: KNode = { id: 'tmpl', kind: 'WorkflowTemplate', name: 'build', health: 'Healthy' }
    const wfs: KNode[] = []
    const pods: KNode[] = []
    const e: KEdge[] = []
    for (let i = 0; i < 6; i++) {
      const id = `wf${i}`
      wfs.push({ id, kind: 'Workflow', name: `wf-${i}`, health: 'Healthy' })
      e.push({ from: 'tmpl', to: id, type: 'refers' })
      // Give two of them a Pod child so the group is non-leaf (the case the leaf-block path skips):
      // wf-0 (the head → stays visible) and wf-3 (a middle one → folds away with its pod).
      if (i % 3 === 0) {
        pods.push({ id: `${id}-pod`, kind: 'Pod', name: `${id}-pod`, health: 'Healthy' })
        e.push({ from: id, to: `${id}-pod`, type: 'ownerReference' })
      }
    }
    const l = layoutGraph([tmpl, ...wfs, ...pods], e, 'LR')
    const pill = l.nodes.find((n) => n.collapse)
    expect(pill).toBeTruthy()
    expect(pill!.collapse!.groupKind).toBe('Workflow')
    expect(pill!.collapse!.hidden).toHaveLength(6 - COLLAPSE_VISIBLE) // middle 3 folded (wf-1,2,3)
    // Only the head + last two Workflows are drawn (wf-0, wf-4, wf-5); the middle is behind the pill.
    expect(l.nodes.filter((n) => n.kind === 'Workflow')).toHaveLength(COLLAPSE_VISIBLE)
    // A hidden Workflow's Pod folds away with it (wf-3 is in the middle → hidden; its pod is gone),
    // while a visible Workflow's Pod stays. Net: only the visible non-leaf workflows' pods remain.
    const drawnPodIds = new Set(l.nodes.filter((n) => n.kind === 'Pod').map((n) => n.id))
    expect(drawnPodIds.has('wf3-pod')).toBe(false) // wf-3 (middle) folded → its pod folded too
    expect(drawnPodIds.has('wf0-pod')).toBe(true) // wf-0 (head) visible → its pod stays
    // The folded Pod is tracked as a hidden descendant so the Pod chip can stay honest.
    expect(pill!.collapse!.hiddenDescendants!.some((n) => n.id === 'wf3-pod')).toBe(true)
    // The pill hangs off the template (one bundled edge), and expanding restores everyone.
    expect(l.edges.some((x) => x.from === 'tmpl' && x.to === pill!.id)).toBe(true)
    const expanded = layoutGraph([tmpl, ...wfs, ...pods], e, 'LR', new Set([pill!.collapse!.key]))
    expect(expanded.nodes.filter((n) => n.kind === 'Workflow')).toHaveLength(6) // all shown
    expect(expanded.nodes.some((n) => n.id === 'wf3-pod')).toBe(true) // folded subtree restored
    expect(expanded.nodes.find((n) => n.collapse)!.collapse!.expanded).toBe(true) // pill is now a "show fewer" toggle
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

  it('orders a non-collapsing sibling group top-to-bottom by natural name in LR (StatefulSet pods)', () => {
    // A StatefulSet with 3 pods is below the fold threshold, so its pods land in the Dagre-seeded
    // skeleton column — where Dagre's crossing-min seed used to leave them in an arbitrary order
    // (web-1, web-0, web-2). The siblings must instead read web-0,1,2 down the column. Scramble both
    // the node and edge order so the result can't be an accident of input order.
    const sts: KNode = { id: 'sts', kind: 'StatefulSet', name: 'web', health: 'Healthy' }
    const p = (i: number): KNode => ({ id: `web-${i}`, kind: 'Pod', name: `web-${i}`, health: 'Healthy' })
    const podsIn = [p(2), p(0), p(1)]
    const e: KEdge[] = [
      { from: 'sts', to: 'web-1', type: 'ownerReference' },
      { from: 'sts', to: 'web-2', type: 'ownerReference' },
      { from: 'sts', to: 'web-0', type: 'ownerReference' },
    ]
    const l = layoutGraph([sts, ...podsIn], e, 'LR')
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    expect(y('web-0')).toBeLessThan(y('web-1')) // top-to-bottom natural order
    expect(y('web-1')).toBeLessThan(y('web-2'))
  })

  it('centres a small child group on its parent in LR, even when the parent column is re-packed', () => {
    // The parent (sts) shares its column with a tall sibling stack (many secrets), which pushes sts
    // away from its raw Dagre seed when the column is packed. Its 3 pods (one column right, below the
    // fold threshold) must follow sts and stay centred on it — not sink to their own stale seed. Assert
    // the pod group's mid-y is close to the parent's centre.
    const sts: KNode = { id: 'sts', kind: 'StatefulSet', name: 'es', health: 'Healthy' }
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'es', health: 'Healthy' }
    const pods: KNode[] = [0, 1, 2].map((i) => ({ id: `es-${i}`, kind: 'Pod', name: `es-${i}`, health: 'Healthy' }))
    const secrets: KNode[] = Array.from({ length: 6 }, (_, i) => ({ id: `sec-${i}`, kind: 'Secret', name: `sec-${i}`, health: 'Healthy' }))
    const e: KEdge[] = [
      { from: 'es', to: 'sts', type: 'ownerReference' },
      ...pods.map((p): KEdge => ({ from: 'sts', to: p.id, type: 'ownerReference' })),
      ...secrets.map((s): KEdge => ({ from: 'es', to: s.id, type: 'ownerReference' })),
    ]
    const l = layoutGraph([owner, sts, ...pods, ...secrets], e, 'LR')
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    const podMid = (y('es-0') + y('es-2')) / 2
    expect(Math.abs(podMid - y('sts'))).toBeLessThan(NODE_HEIGHT) // pods stay centred on their parent
  })

  it('straddles a parent with its many children in LR rather than hanging them below it', () => {
    // A parent (es) with many children that collide in the child column. The children must be CENTRED
    // around the parent's height — some above, some below — not all start at the parent and cascade
    // down. Assert the children's bounding mid-y is close to the parent, and at least one child sits
    // above the parent and one below.
    const owner: KNode = { id: 'es', kind: 'Elasticsearch', name: 'es', health: 'Healthy' }
    const kids: KNode[] = Array.from({ length: 8 }, (_, i) => ({ id: `c-${i}`, kind: i % 2 ? 'ConfigMap' : 'Service', name: `c-${i}`, health: 'Healthy' }))
    const e: KEdge[] = kids.map((k): KEdge => ({ from: 'es', to: k.id, type: 'ownerReference' }))
    const l = layoutGraph([owner, ...kids], e, 'LR')
    const y = (id: string) => l.nodes.find((n) => n.id === id)!.y
    const ys = kids.map((k) => y(k.id))
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2
    expect(Math.abs(mid - y('es'))).toBeLessThan(NODE_HEIGHT) // stack centred on the parent
    expect(Math.min(...ys)).toBeLessThan(y('es')) // some children above the parent
    expect(Math.max(...ys)).toBeGreaterThan(y('es')) // some below
  })

  it('separates two same-kind sibling leaf blocks (different parents) by more than the in-block gap', () => {
    // Two CronWorkflows under one template, each owning a high-fanout set of Workflows that wraps into
    // its own dashed leaf block. The two blocks are the same kind (Workflow) but different parents, so
    // they must read as separate framed groupings with a real margin between them — not the tight
    // within-block gap that would let the two frames touch.
    const tmpl: KNode = { id: 'wt', kind: 'WorkflowTemplate', name: 'wt', health: 'Healthy' }
    const crons: KNode[] = ['a', 'b'].map((s) => ({ id: `c-${s}`, kind: 'CronWorkflow', name: `cron-${s}`, health: 'Healthy' }))
    const wfs: KNode[] = []
    const e: KEdge[] = crons.map((c): KEdge => ({ from: 'wt', to: c.id, type: 'ownerReference' }))
    for (const c of crons) {
      for (let i = 0; i < 6; i++) {
        const id = `${c.id}-wf-${i}`
        wfs.push({ id, kind: 'Workflow', name: `${c.name}-wf-${i}`, health: 'Healthy' })
        e.push({ from: c.id, to: id, type: 'ownerReference' })
      }
    }
    const l = layoutGraph([tmpl, ...crons, ...wfs], e, 'LR')
    const ext = (prefix: string) => {
      const cards = l.nodes.filter((n) => n.id.startsWith(prefix))
      return { top: Math.min(...cards.map((n) => n.y - NODE_HEIGHT / 2)), bot: Math.max(...cards.map((n) => n.y + NODE_HEIGHT / 2)) }
    }
    const a = ext('c-a-wf')
    const b = ext('c-b-wf')
    const [upper, lower] = a.bot <= b.top ? [a, b] : [b, a]
    expect(lower.top).toBeGreaterThan(upper.bot) // the two blocks don't overlap or interleave
    expect(lower.top - upper.bot).toBeGreaterThan(18) // wider than the within-block COL_V_GAP
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

  it('wraps a high-fanout hub whose leaves have a SECOND parent (argocd Application case)', () => {
    // 12 Applications, each owned by an ApplicationSet (ownerReference) AND referring to one AppProject
    // (refers) — so every leaf has degree 2. The old degree===1 test left them all unwrapped, strung
    // down the skeleton one per row. They must now fold under the ApplicationSet (its ownerReference
    // wins as the primary hub), with the AppProject left in the skeleton, not wrapped.
    const appset: KNode = { id: 'appset', kind: 'ApplicationSet', name: 'apps', health: 'Healthy' }
    const proj: KNode = { id: 'proj', kind: 'AppProject', name: 'default', health: 'Healthy' }
    const apps = Array.from({ length: 12 }, (_, i) => ({ id: `app${i}`, kind: 'Application', name: `app-${i}`, health: 'Healthy' as const }))
    const e: KEdge[] = [
      ...apps.map((a) => ({ from: 'appset', to: a.id, type: 'ownerReference' as const })),
      ...apps.map((a) => ({ from: 'proj', to: a.id, type: 'refers' as const })),
    ]
    const l = layoutGraph([appset, proj, ...apps], e, 'LR')
    const pill = l.nodes.find((n) => n.collapse)
    expect(pill).toBeTruthy() // the group folded instead of stringing 12 rows down the skeleton
    expect(pill!.collapse!.hidden).toHaveLength(12 - COLLAPSE_VISIBLE)
    expect(l.nodes.filter((n) => n.kind === 'Application')).toHaveLength(COLLAPSE_VISIBLE) // rest folded away
    // The fold is owned by the ApplicationSet (primary hub); the AppProject stays an unwrapped skeleton card.
    expect(l.edges.some((x) => x.from === 'appset' && x.to === pill!.id)).toBe(true)
    expect(l.nodes.some((n) => n.id === 'proj')).toBe(true)
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

  it('folds a crowded same-kind set of unconnected (orphan) nodes into one block', () => {
    // The ownership view keeps every resource, including parentless ones. A namespace's many loose
    // ConfigMaps must not string down the canvas one per row — once they pass the fan-out threshold
    // they fold into a single collapsible block, while a small set stays as individual cards.
    const dep: KNode = { id: 'dep', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const pod: KNode = { id: 'pod', kind: 'Pod', name: 'web-x', health: 'Healthy' }
    const cms = Array.from({ length: 9 }, (_, i) => ({ id: `cm${i}`, kind: 'ConfigMap', name: `cfg-${i}`, health: 'Healthy' as const }))
    const secrets = Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, kind: 'Secret', name: `sec-${i}`, health: 'Healthy' as const }))
    const e: KEdge[] = [{ from: 'dep', to: 'pod', type: 'ownerReference' }]
    const l = layoutGraph([dep, pod, ...cms, ...secrets], e, 'LR')
    // 9 ConfigMaps fold: only COLLAPSE_VISIBLE remain as cards + one pill, framed as one block.
    const cmCards = l.nodes.filter((n) => n.kind === 'ConfigMap')
    expect(cmCards).toHaveLength(COLLAPSE_VISIBLE)
    const pill = l.nodes.find((n) => n.collapse?.groupKind === 'ConfigMap')!
    expect(pill.collapse!.hidden).toHaveLength(9 - COLLAPSE_VISIBLE)
    expect(cmCards.every((n) => n.collapseGroup === 'orphan:ConfigMap')).toBe(true) // framed as a group
    // 2 Secrets are below the threshold → individual cards, not folded.
    expect(l.nodes.filter((n) => n.kind === 'Secret')).toHaveLength(2)
    expect(l.nodes.some((n) => n.collapse?.groupKind === 'Secret')).toBe(false)
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

  it('shelf-packs the kind boxes into a grid, not one tall column', () => {
    // Many single-card kinds: a single-column stack would leave every box on its own row. The
    // grid pack must instead flow them across the width, so at least one pair of kind boxes shares
    // a horizontal band (overlapping y-range at different x) — proving width is used, not just height.
    const many: KNode[] = Array.from({ length: 9 }, (_, i) => ({
      id: `n${i}`,
      kind: `Kind${String.fromCharCode(97 + i)}`, // distinct kinds Kinda…Kindi
      name: `r${i}`,
      health: 'Healthy' as const,
    }))
    const l = layoutGraphByKind(many, [])
    const groups = kindGroups(l)
    expect(groups).toHaveLength(9)
    const sharesRow = groups.some((a) =>
      groups.some((b) => a.kind !== b.kind && a.y < b.y + b.height && b.y < a.y + a.height && a.x !== b.x),
    )
    expect(sharesRow).toBe(true)
    // The packed box is wider than a single column (the whole point of using the width).
    expect(l.width).toBeGreaterThan(NODE_WIDTH * 2)
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

  it('arranges many hosts into a multi-column grid, not one tall column', () => {
    // Mirrors a real multi-node cluster: several hosts each running a few pods. A single-column
    // stack wastes the screen's width (the reported bug); the grid must place at least one pair of
    // host boxes side by side (overlapping y-range at different x).
    const nodes: KNode[] = []
    for (let h = 0; h < 7; h++) {
      const host = `node-${h}`
      nodes.push({ id: `node-${h}`, kind: 'Node', name: host, health: 'Healthy' })
      for (let p = 0; p < 3; p++) nodes.push({ id: `p-${h}-${p}`, kind: 'Pod', name: `pod-${h}-${p}`, health: 'Healthy', host })
    }
    const l = layoutGraphByHost(nodes, [])
    const groups = hostGroups(l)
    expect(groups).toHaveLength(7)
    const sharesRow = groups.some((a) =>
      groups.some((b) => a.host !== b.host && a.y < b.y + b.height && b.y < a.y + a.height && a.x !== b.x),
    )
    expect(sharesRow).toBe(true)
    expect(l.width).toBeGreaterThan(NODE_WIDTH * 2)
  })
})

describe('same-kind collapse (+N more)', () => {
  // n pods named pod-00 … pod-(n-1); the fold keeps the head + last two of this natural name order.
  const pods = (n: number): KNode[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      kind: 'Pod',
      name: `pod-${String(i).padStart(2, '0')}`,
      health: 'Healthy' as const,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }))

  it('folds the MIDDLE behind one pill, keeping the first and the last two cards', () => {
    const l = layoutGraphByKind(pods(12), [])
    const realPods = l.nodes.filter((n) => n.kind === 'Pod' && !n.collapse)
    expect(realPods).toHaveLength(COLLAPSE_VISIBLE) // head (1) + tail (2) stay
    const pill = l.nodes.find((n) => n.collapse)!
    // 12 pods in natural order p0..p11: keep p0 + p10,p11, hide the middle p1..p9.
    expect(pill.collapse!.hidden.map((n) => n.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'])
    expect(pill.collapse!.groupKind).toBe('Pod')
    expect(pill.collapse!.expanded).toBe(false)
    const visibleIds = new Set(realPods.map((n) => n.id))
    expect(visibleIds.has('p0')).toBe(true) // first card stays visible
    expect(visibleIds.has('p10')).toBe(true) // and the last two
    expect(visibleIds.has('p11')).toBe(true)
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

  it('hides the same middle set regardless of input order', () => {
    const l = layoutGraphByKind([...pods(12)].reverse(), [])
    const pill = l.nodes.find((n) => n.collapse)!
    expect(pill.collapse!.hidden.map((n) => n.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'])
  })

  it('orders ordinals numerically (web-10 after web-9), keeping the numeric first + last two', () => {
    // Unpadded names: a lexical sort would order web-10 right after web-1, so the "last two" would
    // wrongly be web-8/web-9. Numeric sort keeps web-0 as head and web-10/web-11 as the tail, hiding
    // the numeric middle web-1..web-9 — the StatefulSet "0,1,2,…,10,11" reading the user asked for.
    const webPods: KNode[] = Array.from({ length: 12 }, (_, i) => ({
      id: `w${i}`,
      kind: 'Pod',
      name: `web-${i}`,
      health: 'Healthy' as const,
    }))
    const l = layoutGraphByKind(webPods, [])
    const visibleNames = l.nodes.filter((n) => n.kind === 'Pod' && !n.collapse).map((n) => n.name).sort()
    expect(visibleNames).toEqual(['web-0', 'web-10', 'web-11']) // numeric head + last two
    const pill = l.nodes.find((n) => n.collapse)!
    const hiddenNames = pill.collapse!.hidden.map((n) => n.name)
    expect(hiddenNames).toContain('web-9') // web-9 is mid-pack, not the largest → hidden
    expect(hiddenNames).not.toContain('web-10') // web-10 is numerically last → visible, not hidden
  })

  it('keeps head + tail in place across expand (no reshuffle), pill stays a show-fewer toggle', () => {
    // The whole point of folding the middle: the visible cards an operator already sees must not jump
    // when they expand. The head (p0) and tail (p10,p11) of the collapsed view are still present and in
    // the same natural order once expanded — expanding only reveals the previously-hidden middle.
    const collapsed = layoutGraphByKind(pods(12), [])
    const visibleBefore = collapsed.nodes.filter((n) => n.kind === 'Pod' && !n.collapse).map((n) => n.id).sort()
    expect(visibleBefore).toEqual(['p0', 'p10', 'p11'])
    const expanded = layoutGraphByKind(pods(12), [], new Set(['kind:Pod']))
    const allShown = expanded.nodes.filter((n) => n.kind === 'Pod').map((n) => n.id)
    expect(allShown).toHaveLength(12) // every card now shown
    // Head + tail are a subset of the expanded set, so they never disappeared/moved out on expand.
    expect(visibleBefore.every((id) => allShown.includes(id))).toBe(true)
    expect(expanded.nodes.find((n) => n.collapse)!.collapse!.expanded).toBe(true)
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

describe('layoutGraphByCapacity (Nodes capacity view)', () => {
  const capNodes: KNode[] = [
    { id: 'n1', kind: 'Node', name: 'big', health: 'Healthy', allocatable: { cpuMilli: 8000, memBytes: 16 * 1024 ** 3 } },
    { id: 'n2', kind: 'Node', name: 'small', health: 'Healthy', allocatable: { cpuMilli: 4000, memBytes: 8 * 1024 ** 3 } },
    { id: 'pa', kind: 'Pod', name: 'a', health: 'Healthy', host: 'big', requests: { cpuMilli: 500 }, limits: { cpuMilli: 1000 } },
    { id: 'pb', kind: 'Pod', name: 'b', health: 'Healthy', host: 'big' }, // no request
    { id: 'pc', kind: 'Pod', name: 'c', health: 'Healthy', host: 'small', requests: { cpuMilli: 2000 } },
  ]
  const usage = { pa: { cpuMilli: 800 }, pc: { cpuMilli: 100 }, n1: { cpuMilli: 1200 } }

  it('sizes node tracks proportional to capacity on one global scale', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'split')
    const big = l.rows.find((r) => r.host === 'big')!
    const small = l.rows.find((r) => r.host === 'small')!
    expect(big.cap).toBe(8000)
    expect(small.cap).toBe(4000)
    expect(big.trackW).toBeCloseTo(small.trackW * 2, 0) // 2× capacity ⇒ 2× track length
  })

  it('totals requests/usage and flags usage overshooting request', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'split')
    const big = l.rows.find((r) => r.host === 'big')!
    expect(big.reqTotal).toBe(500) // only pa sets a request
    expect(big.useTotal).toBe(800) // pa 800 + pb 0
    expect(big.useSegs.find((s) => s.node.id === 'pa')!.over).toBe(true) // 800 > 500
  })

  it('puts only request-bearing pods in the requested bar; every pod gets a usage segment', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'split')
    const big = l.rows.find((r) => r.host === 'big')!
    expect(big.reqSegs.map((s) => s.node.id)).toEqual(['pa']) // pb has no request
    expect(big.useSegs).toHaveLength(2) // pb still gets a (min-width) segment, never vanishes
    expect(big.useSegs.every((s) => s.width > 0)).toBe(true)
  })

  it('overlay mode emits a Σrequest marker instead of a requested bar', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'overlay')
    const big = l.rows.find((r) => r.host === 'big')!
    expect(big.reqSegs).toHaveLength(0)
    expect(big.reqMarkerX!).toBeGreaterThan(0)
  })

  it('flags overcommit when Σrequest exceeds capacity', () => {
    const over: KNode[] = [
      { id: 'n', kind: 'Node', name: 'h', health: 'Healthy', allocatable: { cpuMilli: 1000 } },
      { id: 'p', kind: 'Pod', name: 'p', health: 'Healthy', host: 'h', requests: { cpuMilli: 2000 } },
    ]
    expect(layoutGraphByCapacity(over, {}, 'cpu', 'split').rows[0].overcommit).toBe(true)
  })

  it('expands a node into per-pod bullets with their own scale', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'split', new Set(['host:big']))
    const big = l.rows.find((r) => r.host === 'big')!
    expect(big.bullets).toHaveLength(2)
    expect(big.bulletScale!).toBeGreaterThan(0)
  })

  it('carries the node total usage as a backdrop value', () => {
    const l = layoutGraphByCapacity(capNodes, usage, 'cpu', 'split')
    expect(l.rows.find((r) => r.host === 'big')!.nodeUse).toBe(1200)
  })

  it('buckets host-less pods into an Unscheduled row', () => {
    const l = layoutGraphByCapacity([{ id: 'p', kind: 'Pod', name: 'p', health: 'Healthy' }], {}, 'cpu', 'split')
    expect(l.rows.map((r) => r.label)).toContain('Unscheduled')
  })

  it('returns empty geometry for no nodes', () => {
    const l = layoutGraphByCapacity([], {}, 'cpu', 'split')
    expect(l.rows).toEqual([])
    expect(l.nodes).toEqual([])
  })
})

describe('formatQuantity', () => {
  it('renders CPU millicores as cores or milli', () => {
    expect(formatQuantity(500, 'cpu')).toBe('500m')
    expect(formatQuantity(2000, 'cpu')).toBe('2')
    expect(formatQuantity(1500, 'cpu')).toBe('1.5')
  })
  it('renders memory bytes in binary units', () => {
    expect(formatQuantity(8 * 1024 ** 3, 'memory')).toBe('8Gi')
    expect(formatQuantity(512 * 1024 ** 2, 'memory')).toBe('512Mi')
  })
  it('renders undefined as an em dash', () => {
    expect(formatQuantity(undefined, 'cpu')).toBe('—')
  })
})
