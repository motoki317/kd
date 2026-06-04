import { describe, it, expect } from 'vitest'
import { layoutGraphByCapacity } from './capacityLayout'
import type { KNode, Resources } from './types'

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

  it('reports hasUsage from the presence of usage data', () => {
    const nodes = [node('n1', 1000, 1000), pod('p', 'n1', 'shop', { use: 10, req: 10 })]
    expect(layoutGraphByCapacity(nodes, undefined, 'cpu', 'shop').hasUsage).toBe(false)
    expect(layoutGraphByCapacity(nodes, usageOf(['p', 10]), 'cpu', 'shop').hasUsage).toBe(true)
  })
})
