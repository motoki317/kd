import { describe, it, expect } from 'vitest'
import { drawerResourceBars, nodeRequestSum, hostNodeCapacity } from './resourceBars'
import type { KNode } from './types'

const Gi = 1024 ** 3

describe('drawerResourceBars — Node', () => {
  it('builds a Use bar (usage / capacity) over a Req bar (Σrequest / allocatable) per resource', () => {
    const g = drawerResourceBars({
      isNode: true,
      usage: { cpuMilli: 600, memBytes: 2 * Gi },
      capacity: { cpuMilli: 4000, memBytes: 8 * Gi },
      allocatable: { cpuMilli: 3800, memBytes: 7 * Gi },
      reqSum: { cpuMilli: 1900, memBytes: 3 * Gi },
    })
    expect(g.map((x) => x.res)).toEqual(['cpu', 'memory'])
    const cpu = g[0]
    expect(cpu.track).toBe(4000) // shared track = total capacity
    expect(cpu.bars.map((b) => b.kind)).toEqual(['use', 'req'])
    expect(cpu.bars[0].pct).toBeCloseTo(15) // 600 / 4000
    expect(cpu.bars[1].pct).toBeCloseTo(47.5) // 1900 / 4000, gauged on the SAME track as Use
    expect(cpu.bars[0].ceilLabel).toBe('cap')
    expect(cpu.bars[1].ceilLabel).toBe('alloc')
    // The allocatable line sits short of the capacity track (3800/4000).
    expect(cpu.allocPct).toBeCloseTo(95)
  })

  it('flags node overcommit — Σrequest past allocatable recolours the Req bar (hard breach)', () => {
    const g = drawerResourceBars({
      isNode: true,
      usage: { cpuMilli: 500 },
      capacity: { cpuMilli: 4000 },
      allocatable: { cpuMilli: 3800 },
      reqSum: { cpuMilli: 4200 }, // promised more than schedulable
    })
    const req = g[0].bars.find((b) => b.kind === 'req')!
    expect(req.over).toBe(true)
    expect(req.pct).toBe(100) // clamped — the bar fills the whole capacity track
  })

  it('falls back to allocatable as the track when total capacity is unknown', () => {
    const g = drawerResourceBars({ isNode: true, usage: { cpuMilli: 100 }, allocatable: { cpuMilli: 2000 }, reqSum: { cpuMilli: 500 } })
    expect(g[0].track).toBe(2000)
    expect(g[0].allocPct).toBeUndefined() // alloc == track, so no distinct marker
  })
})

describe('drawerResourceBars — Pod / workload', () => {
  it('builds Use + Req bars sharing the limit as the track', () => {
    const g = drawerResourceBars({
      isNode: false,
      usage: { cpuMilli: 120, memBytes: 1 * Gi },
      request: { cpuMilli: 200, memBytes: 1 * Gi },
      limit: { cpuMilli: 400, memBytes: 2 * Gi },
    })
    const cpu = g[0]
    expect(cpu.track).toBe(400) // limit is the shared ceiling
    expect(cpu.bars[0].pct).toBeCloseTo(30) // use 120/400
    expect(cpu.bars[1].pct).toBeCloseTo(50) // req 200/400
    expect(cpu.bars.every((b) => b.ceilLabel === 'lim')).toBe(true)
  })

  it('recolours the Use bar past the limit but never the Req bar (request is soft)', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 500 }, request: { cpuMilli: 200 }, limit: { cpuMilli: 400 } })
    const cpu = g[0]
    expect(cpu.bars.find((b) => b.kind === 'use')!.over).toBe(true)
    expect(cpu.bars.find((b) => b.kind === 'req')!.over).toBe(false)
  })

  it('gauges against the request when no limit is set (soft ceiling, no recolour on burst)', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 300 }, request: { cpuMilli: 200 } })
    const cpu = g[0]
    expect(cpu.track).toBe(200)
    expect(cpu.bars.find((b) => b.kind === 'use')!.over).toBe(false) // request is soft — bursting is fine
    expect(cpu.bars[0].ceilLabel).toBe('req')
  })

  it('falls back to the HOST NODE capacity when neither limit nor request is set', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 }, hostCapacity: { cpuMilli: 4000 } })
    const cpu = g[0]
    expect(cpu.track).toBe(4000) // the node's capacity, not the bare usage
    expect(cpu.bars[0].pct).toBeCloseTo(6.25) // 250 / 4000 — reads as a small slice of the node
    expect(cpu.bars[0].ceilLabel).toBe('node')
    expect(cpu.unconstrained).toBe(false) // it IS gauged, against the node
    expect(cpu.bars.some((b) => b.kind === 'req')).toBe(false) // no request → no Req bar
  })

  it('marks a truly unconstrained resource (no limit/request/host capacity) so the track shows dashed', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 } })
    expect(g[0].unconstrained).toBe(true)
  })

  it('omits a resource entirely when it has neither usage nor any bound', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 100 } }) // memory has nothing
    expect(g.map((x) => x.res)).toEqual(['cpu'])
  })
})

describe('nodeRequestSum', () => {
  const feed: KNode[] = [
    { id: 'n', kind: 'Node', name: 'host-1', health: 'Healthy' },
    { id: 'p1', kind: 'Pod', name: 'p1', host: 'host-1', health: 'Healthy', requests: { cpuMilli: 100, memBytes: 1 * Gi } },
    { id: 'p2', kind: 'Pod', name: 'p2', host: 'host-1', health: 'Healthy', requests: { cpuMilli: 200 } },
    { id: 'p3', kind: 'Pod', name: 'p3', host: 'host-2', health: 'Healthy', requests: { cpuMilli: 999 } }, // other node
  ]

  it('sums requests of pods scheduled on the node, ignoring other nodes', () => {
    expect(nodeRequestSum('host-1', feed)).toEqual({ cpuMilli: 300, memBytes: 1 * Gi })
  })

  it('returns undefined when no scheduled pod sets a request', () => {
    expect(nodeRequestSum('host-3', feed)).toBeUndefined()
  })
})

describe('hostNodeCapacity', () => {
  const feed: KNode[] = [
    { id: 'n', kind: 'Node', name: 'host-1', health: 'Healthy', capacityRes: { cpuMilli: 4000 }, allocatable: { cpuMilli: 3800 } },
    { id: 'n2', kind: 'Node', name: 'host-2', health: 'Healthy', allocatable: { cpuMilli: 2000 } },
  ]

  it('returns the host node total capacity (preferring capacityRes)', () => {
    expect(hostNodeCapacity('host-1', feed)).toEqual({ cpuMilli: 4000 })
  })

  it('falls back to allocatable when capacityRes is absent', () => {
    expect(hostNodeCapacity('host-2', feed)).toEqual({ cpuMilli: 2000 })
  })

  it('returns undefined for an unknown or absent host', () => {
    expect(hostNodeCapacity('ghost', feed)).toBeUndefined()
    expect(hostNodeCapacity(undefined, feed)).toBeUndefined()
  })
})
