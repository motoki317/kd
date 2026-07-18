import { describe, it, expect } from 'vitest'
import { formatPair, layoutGraphByCapacity } from './capacityLayout'
import type { KNode, Resources } from './types'

describe('formatPair', () => {
  it('CPU: a cores-scale cap pulls the numerator into cores (no "876m / 16" clash)', () => {
    expect(formatPair(876, 16000, 'cpu')).toEqual({ value: '0.88', cap: '16' })
    expect(formatPair(2150, 16000, 'cpu')).toEqual({ value: '2.15', cap: '16' })
  })
  it('CPU: a sub-core cap keeps both parts in millicores (already one unit)', () => {
    expect(formatPair(480, 940, 'cpu')).toEqual({ value: '480m', cap: '940m' })
  })
  it('CPU: unitRef from the node total keeps the Req bar in cores when its allocatable dips sub-core', () => {
    // The real bug: a 1-core node's Use bar (cap 1000 → cores "0.06 / 1") clashed with its Req bar
    // (cap 940, judged alone → millicores "480m / 940m"). Passing the node total (1000) as unitRef
    // pulls the Req bar into cores too, so both stacked bars read one unit.
    expect(formatPair(60, 1000, 'cpu', 1000)).toEqual({ value: '0.06', cap: '1' })
    expect(formatPair(480, 940, 'cpu', 1000)).toEqual({ value: '0.48', cap: '0.94' })
  })
  it('CPU: trims trailing zeros on the cores form', () => {
    expect(formatPair(2000, 2000, 'cpu')).toEqual({ value: '2', cap: '2' })
  })
  it('memory: both parts in the cap’s binary unit', () => {
    const Gi = 1024 ** 3
    expect(formatPair(0.5 * Gi, 8 * Gi, 'memory')).toEqual({ value: '0.5Gi', cap: '8Gi' })
  })
  it('an undefined cap falls back to a single formatted value (no reference unit to match)', () => {
    expect(formatPair(500, undefined, 'cpu')).toEqual({ value: '500m', cap: '' })
  })
  it('an undefined value renders as a dash, keeping the cap', () => {
    expect(formatPair(undefined, 16000, 'cpu')).toEqual({ value: '—', cap: '16' })
  })
  it('a non-zero side never displays as "0" — it borrows its natural unit instead', () => {
    // 2m idling on a 1-core node rounded to "0 / 1" — a live reading that reads as dead. The value
    // side falls back to formatQuantity's unit in exactly this corner; a TRUE zero still shows "0".
    expect(formatPair(2, 1000, 'cpu', 1000)).toEqual({ value: '2m', cap: '1' })
    expect(formatPair(0, 1000, 'cpu', 1000)).toEqual({ value: '0', cap: '1' })
    // The bound side gets the same guard: a 4m request beside a multi-core limit must not read "/ 0".
    expect(formatPair(2, 4, 'cpu', 8000)).toEqual({ value: '2m', cap: '4m' })
    const Gi = 1024 ** 3
    expect(formatPair(10 * 1024, 2 * Gi, 'memory', 2 * Gi)).toEqual({ value: '10Ki', cap: '2Gi' })
  })
})

const node = (name: string, allocCpu: number, capCpu: number): KNode => ({
  id: `node-${name}`,
  kind: 'Node',
  name,
  health: 'Healthy',
  allocatable: { cpuMilli: allocCpu },
  capacityRes: { cpuMilli: capCpu },
})

const pod = (id: string, host: string, namespace: string, useReq: { use: number; req?: number }): KNode => ({
  id,
  kind: 'Pod',
  name: id,
  namespace,
  host,
  health: 'Healthy',
  requests: useReq.req === undefined ? undefined : ({ cpuMilli: useReq.req } as Resources),
})

const usageOf = (...pairs: [string, number][]) =>
  Object.fromEntries(pairs.map(([id, c]) => [id, { cpuMilli: c }]))

describe('layoutGraphByCapacity', () => {
  it('returns the empty base layout for no nodes', () => {
    const l = layoutGraphByCapacity([], undefined, 'cpu', '')
    expect(l.rows).toEqual([])
    expect(l.width).toBe(0)
    expect(l.hasUsage).toBe(false)
  })

  it('scales every node track off ONE global max-capacity scale (a 2× node reads 2× as long)', () => {
    const nodes = [node('n1', 900, 1000), node('n2', 1800, 2000)]
    const l = layoutGraphByCapacity(nodes, undefined, 'cpu', '')
    const r1 = l.rows.find((r) => r.host === 'n1')!
    const r2 = l.rows.find((r) => r.host === 'n2')!
    // n2 has 2× the capacity and 2× the allocatable → 2× both track lengths, on the shared linear scale.
    expect(r2.useTrackW).toBeCloseTo(r1.useTrackW * 2, 1)
    expect(r2.trackW).toBeCloseTo(r1.trackW * 2, 1)
    // Use-bar ceiling (capacity) ≥ Req-bar ceiling (allocatable) on the same node.
    expect(r1.useTrackW).toBeGreaterThanOrEqual(r1.trackW)
  })

  it('orders own segments largest-first by max(use, request)', () => {
    const nodes = [
      node('n1', 1000, 1000),
      pod('big-req', 'n1', 'shop', { use: 50, req: 300 }), // max 300
      pod('big-use', 'n1', 'shop', { use: 200, req: 100 }), // max 200
    ]
    const l = layoutGraphByCapacity(nodes, usageOf(['big-use', 200], ['big-req', 50]), 'cpu', 'shop')
    const row = l.rows.find((r) => r.host === 'n1')!
    // big-req (max 300) sorts ahead of big-use (max 200), even though it uses less.
    expect(row.useSegs.map((s) => s.node.id)).toEqual(['big-req', 'big-use'])
  })

  it('floats nodes running THIS namespace’s pods to the top in namespace scope', () => {
    // Alphabetically n-z would sort last, but it is the only node running a "shop" pod — in a
    // namespace Nodes view it must lead so "where do my pods run" reads at the top, not buried among
    // nodes that only host other namespaces.
    const nodes = [
      node('n-a', 1000, 1000),
      node('n-m', 1000, 1000),
      node('n-z', 1000, 1000),
      pod('shop-pod', 'n-z', 'shop', { use: 100, req: 100 }),
      pod('infra-pod', 'n-a', 'infra', { use: 50, req: 50 }),
    ]
    const usage = usageOf(['shop-pod', 100], ['infra-pod', 50])
    const ns = layoutGraphByCapacity(nodes, usage, 'cpu', 'shop')
    expect(ns.rows.map((r) => r.host)).toEqual(['n-z', 'n-a', 'n-m']) // own-pod node first, then alphabetical
    // Cluster scope: every pod is "own", so the order stays plain alphabetical (no reshuffle).
    const cluster = layoutGraphByCapacity(nodes, usage, 'cpu', '')
    expect(cluster.rows.map((r) => r.host)).toEqual(['n-a', 'n-m', 'n-z'])
  })

  it('folds other-namespace pods into one block in namespace scope, but not in cluster scope', () => {
    const nodes = [
      node('n1', 1000, 1000),
      pod('own-a', 'n1', 'shop', { use: 100, req: 100 }),
      pod('own-b', 'n1', 'shop', { use: 80, req: 90 }),
      pod('other-x', 'n1', 'infra', { use: 70, req: 60 }),
    ]
    const usage = usageOf(['own-a', 100], ['own-b', 80], ['other-x', 70])

    const ns = layoutGraphByCapacity(nodes, usage, 'cpu', 'shop').rows.find((r) => r.host === 'n1')!
    expect(ns.ownCount).toBe(2)
    expect(ns.otherCount).toBe(1)
    expect(ns.otherUseSeg?.variant).toBe('other')
    expect(ns.otherUseSeg?.count).toBe(1)
    // Totals span ALL pods; ownUseTotal is just the selected namespace's.
    expect(ns.useTotal).toBe(250) // 100 + 80 + 70
    expect(ns.reqTotal).toBe(250) // 100 + 90 + 60
    expect(ns.ownUseTotal).toBe(180) // 100 + 80

    const cluster = layoutGraphByCapacity(nodes, usage, 'cpu', '').rows.find((r) => r.host === 'n1')!
    expect(cluster.ownCount).toBe(3) // every pod is "own" in cluster scope
    expect(cluster.otherCount).toBe(0)
    expect(cluster.otherUseSeg).toBeUndefined()
  })

  // The overshoot invariant is owned by docs/frontend-internals.md "Nodes capacity view": N near-zero
  // pods must NOT each draw at a per-segment floor (31 pods at 8% use drew ~70%). Healthy
  // sub-threshold pods fold into ONE exact-sum block, so the bar end stays honest.
  describe('small-pod folding (overshoot guard)', () => {
    const huge = node('huge', 100_000, 100_000) // scale = 1080/100000 = 0.0108 → 100m draws ~1px (< fold)

    it('folds many tiny healthy pods into one EXACT-sum block, never N tiled minimums', () => {
      const tinies = Array.from({ length: 5 }, (_, i) => pod(`t${i}`, 'huge', 'shop', { use: 100, req: 100 }))
      const usage = usageOf(...tinies.map((p) => [p.id, 100] as [string, number]))
      const row = layoutGraphByCapacity([huge, ...tinies], usage, 'cpu', 'shop').rows.find((r) => r.host === 'huge')!

      expect(row.useSegs).toHaveLength(0) // all five folded, none drawn individually
      expect(row.smallUseSeg?.count).toBe(5)
      // Width tracks the EXACT summed value (500·0.0108 ≈ 5.4px), NOT 5 tiled 4px floors (20px).
      expect(row.smallUseSeg!.width).toBeCloseTo(500 * (1080 / 100_000), 1)
      expect(row.smallUseSeg!.width).toBeLessThan(5 * 4)
    })

    it('floors a LONE sub-threshold pod individually rather than folding (fold needs ≥2)', () => {
      const lone = pod('lone', 'huge', 'shop', { use: 100, req: 100 })
      const row = layoutGraphByCapacity([huge, lone], usageOf(['lone', 100]), 'cpu', 'shop').rows.find((r) => r.host === 'huge')!
      expect(row.smallUseSeg).toBeUndefined()
      expect(row.useSegs).toHaveLength(1)
      expect(row.useSegs[0].width).toBe(4) // floored to CAP_SEG_FOLD so it stays visible/hittable
    })

    it('never folds an unhealthy tiny pod — a problem pod stays individually visible', () => {
      const a = pod('ok-a', 'huge', 'shop', { use: 100, req: 100 })
      const b = pod('ok-b', 'huge', 'shop', { use: 100, req: 100 })
      const sick: KNode = { ...pod('sick', 'huge', 'shop', { use: 100, req: 100 }), health: 'Degraded' }
      const usage = usageOf(['ok-a', 100], ['ok-b', 100], ['sick', 100])
      const row = layoutGraphByCapacity([huge, a, b, sick], usage, 'cpu', 'shop').rows.find((r) => r.host === 'huge')!
      // The two healthy tinies fold; the Degraded one is drawn on its own.
      expect(row.smallUseSeg?.count).toBe(2)
      expect(row.useSegs.map((s) => s.node.id)).toEqual(['sick'])
    })

    it('never folds a near-limit tiny pod — the OOM/throttle warning needs its own segment', () => {
      // Tight-limit tiny pods are exactly the ones likeliest to run near their limit; folding one
      // into the anonymous "small" block would hide the bar's most urgent state.
      const a = pod('ok-a', 'huge', 'shop', { use: 100, req: 100 })
      const b = pod('ok-b', 'huge', 'shop', { use: 100, req: 100 })
      const hot: KNode = { ...pod('hot', 'huge', 'shop', { use: 100, req: 100 }), limits: { cpuMilli: 105 } as Resources }
      const usage = usageOf(['ok-a', 100], ['ok-b', 100], ['hot', 100]) // 100 ≥ 0.9 × 105
      const row = layoutGraphByCapacity([huge, a, b, hot], usage, 'cpu', 'shop').rows.find((r) => r.host === 'huge')!
      expect(row.smallUseSeg?.count).toBe(2)
      expect(row.useSegs.map((s) => s.node.id)).toEqual(['hot'])
      expect(row.useSegs[0].nearLimit).toBe(true)
    })
  })

  it('flags overcommit when summed requests exceed allocatable', () => {
    const over = [
      node('n1', 1000, 1000),
      pod('a', 'n1', 'shop', { use: 10, req: 600 }),
      pod('b', 'n1', 'shop', { use: 10, req: 600 }), // 1200 req > 1000 allocatable
    ]
    const under = [
      node('n2', 1000, 1000),
      pod('c', 'n2', 'shop', { use: 10, req: 300 }),
      pod('d', 'n2', 'shop', { use: 10, req: 300 }), // 600 req < 1000
    ]
    const rowOf = (nodes: KNode[], host: string) =>
      layoutGraphByCapacity(nodes, undefined, 'cpu', 'shop').rows.find((r) => r.host === host)!
    expect(rowOf(over, 'n1').overcommit).toBe(true)
    expect(rowOf(under, 'n2').overcommit).toBe(false)
  })

  it('buckets pods on an unknown host into a trailing "Unscheduled" row', () => {
    const nodes = [
      node('n1', 1000, 1000),
      pod('scheduled', 'n1', 'shop', { use: 10, req: 10 }),
      pod('orphan', 'ghost-node', 'shop', { use: 10, req: 10 }), // host isn't a known Node
    ]
    const l = layoutGraphByCapacity(nodes, usageOf(['scheduled', 10], ['orphan', 10]), 'cpu', 'shop')
    const last = l.rows[l.rows.length - 1]
    expect(last.label).toBe('Unscheduled') // the orphan bucket sorts last
    expect(last.node).toBeUndefined() // no backing Node resource
    expect(last.useSegs.map((s) => s.node.id)).toContain('orphan')
  })

  it('bounds every track when an unscheduled request exceeds the biggest node', () => {
    // A pending pod asking for 4× the node (a fat-fingered "cpu: 64") must not stretch its track
    // kilopixels off-canvas; the scale keys on the larger of capacity and demand, so the giant row
    // takes the max track and the node row shrinks in proportion (the honest 1:4 picture).
    const nodes = [
      node('n1', 1000, 1000),
      pod('giant', 'nowhere', 'shop', { use: 0, req: 4000 }), // unknown host → Unscheduled bucket
    ]
    const l = layoutGraphByCapacity(nodes, usageOf(), 'cpu', 'shop')
    const orphanRow = l.rows[l.rows.length - 1]
    const nodeRow = l.rows.find((r) => r.host === 'n1')!
    expect(orphanRow.label).toBe('Unscheduled')
    const maxTrack = Math.max(orphanRow.trackW, orphanRow.useTrackW)
    expect(maxTrack).toBeLessThanOrEqual(1080) // CAP_TRACK_MAX — nothing runs off-canvas
    expect(nodeRow.trackW).toBeCloseTo(maxTrack / 4, 0) // proportionality preserved
  })

  it('displays the FULL node name — the …compute.internal domain is kept, not stripped', () => {
    const fqdn = 'ip-10-8-77-146.us-west-2.compute.internal'
    const l = layoutGraphByCapacity([node(fqdn, 1000, 1000)], undefined, 'cpu', 'shop')
    const row = l.rows.find((r) => r.host === fqdn)!
    expect(row.label).toBe(fqdn) // not the short 'ip-10-8-77-146'
  })

  it('lays out the memory resource off memBytes just like cpu', () => {
    const memNode: KNode = {
      id: 'node-m', kind: 'Node', name: 'm', health: 'Healthy',
      allocatable: { memBytes: 8e9 }, capacityRes: { memBytes: 8e9 },
    }
    const memPod: KNode = {
      id: 'mp', kind: 'Pod', name: 'mp', namespace: 'shop', host: 'm', health: 'Healthy',
      requests: { memBytes: 2e9 },
    }
    const l = layoutGraphByCapacity([memNode, memPod], { mp: { memBytes: 1e9 } }, 'memory', 'shop')
    const row = l.rows.find((r) => r.host === 'm')!
    expect(l.resource).toBe('memory')
    expect(row.useTotal).toBe(1e9) // read from memBytes usage
    expect(row.reqTotal).toBe(2e9) // read from memBytes request
    expect(row.useSegs).toHaveLength(1)
  })

  it('sizes the usage bar by request when metrics are absent (no usage feed)', () => {
    const nodes = [node('n1', 1000, 1000), pod('p', 'n1', 'shop', { use: 0, req: 400 })]
    const row = layoutGraphByCapacity(nodes, undefined, 'cpu', 'shop').rows.find((r) => r.host === 'n1')!
    // hasUsage is false → the usage bar falls back to drawing the pod's request, so it isn't empty.
    expect(row.useSegs).toHaveLength(1)
    expect(row.useSegs[0].width).toBeGreaterThan(4)
  })

  it('reports hasUsage from the presence of usage data', () => {
    const nodes = [node('n1', 1000, 1000), pod('p', 'n1', 'shop', { use: 10, req: 10 })]
    expect(layoutGraphByCapacity(nodes, undefined, 'cpu', 'shop').hasUsage).toBe(false)
    expect(layoutGraphByCapacity(nodes, usageOf(['p', 10]), 'cpu', 'shop').hasUsage).toBe(true)
  })
})
