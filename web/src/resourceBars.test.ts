import { describe, it, expect } from 'vitest'
import { drawerResourceBars, hostNodeCapacity } from './resourceBars'
import type { KNode } from './types'

const Gi = 1024 ** 3

describe('drawerResourceBars — Pod / workload', () => {
  it('builds a Lim bar (ceiling=limit) over a Req bar (ceiling=request), both filled by usage', () => {
    const g = drawerResourceBars({
      isNode: false,
      usage: { cpuMilli: 300, memBytes: 1 * Gi },
      request: { cpuMilli: 200, memBytes: 1 * Gi },
      limit: { cpuMilli: 400, memBytes: 2 * Gi },
    })
    const cpu = g.find((x) => x.res === 'cpu')!
    expect(cpu.bars.map((b) => b.label)).toEqual(['Lim', 'Req']) // Lim on top, Req below
    const [lim, req] = cpu.bars
    expect(lim.ceil).toBe(400)
    expect(req.ceil).toBe(200)
    // SAME usage (300) gauged against each bound: 300/400 = 0.75 lap, 300/200 = 1.5 laps.
    expect(lim.usage).toBe(300)
    expect(req.usage).toBe(300)
    expect(lim.frac).toBeCloseTo(0.75)
    expect(lim.over).toBe(false)
    expect(req.laps).toBe(1) // wrapped once past the request
    expect(req.frac).toBeCloseTo(0.5)
    expect(req.over).toBe(true)
  })

  it('counts laps as usage wraps each ceiling repeatedly (2.5× the request → lap 2)', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 500 }, request: { cpuMilli: 200 } })
    const req = g[0].bars[0]
    expect(req.laps).toBe(2) // 500 / 200 = 2.5
    expect(req.frac).toBeCloseTo(0.5)
    expect(req.over).toBe(true)
  })

  it('reads exactly at the ceiling as a full first lap, not yet over', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 200 }, limit: { cpuMilli: 200 } })
    const lim = g[0].bars[0]
    expect(lim.laps).toBe(1)
    expect(lim.frac).toBeCloseTo(0)
    expect(lim.over).toBe(false) // ratio == 1 is full, not over
  })

  it('falls back to the HOST NODE capacity as the ceiling when neither limit nor request is set', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 }, hostCapacity: { cpuMilli: 4000 } })
    const bar = g[0].bars[0]
    expect(bar.label).toBe('Node')
    expect(bar.ceil).toBe(4000)
    expect(bar.frac).toBeCloseTo(0.0625) // 250 / 4000 — a small slice of the node
    expect(bar.unconstrained).toBeFalsy()
  })

  it('marks a truly unconstrained resource (no bound, no host capacity) so the track shows dashed', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 } })
    expect(g[0].bars[0].unconstrained).toBe(true)
    expect(g[0].bars[0].usage).toBe(250)
  })

  it('still shows the bars (empty) from spec bounds when metrics are unavailable', () => {
    const g = drawerResourceBars({ isNode: false, request: { cpuMilli: 200 }, limit: { cpuMilli: 400 } })
    const cpu = g[0]
    expect(cpu.bars.map((b) => b.label)).toEqual(['Lim', 'Req'])
    expect(cpu.bars.every((b) => b.usage === undefined && b.frac === 0)).toBe(true)
  })

  it('omits a resource entirely when it has neither usage nor any bound', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 100 } }) // memory has nothing
    expect(g.map((x) => x.res)).toEqual(['cpu'])
  })
})

describe('drawerResourceBars — Node', () => {
  it('builds a Cap bar (ceiling=capacity) over an Alloc bar (ceiling=allocatable), filled by node usage', () => {
    const g = drawerResourceBars({
      isNode: true,
      usage: { cpuMilli: 600, memBytes: 2 * Gi },
      capacity: { cpuMilli: 4000, memBytes: 8 * Gi },
      allocatable: { cpuMilli: 3800, memBytes: 7 * Gi },
    })
    const cpu = g.find((x) => x.res === 'cpu')!
    expect(cpu.bars.map((b) => b.label)).toEqual(['Cap', 'Alloc'])
    expect(cpu.bars[0].ceil).toBe(4000)
    expect(cpu.bars[1].ceil).toBe(3800)
    expect(cpu.bars.every((b) => b.usage === 600)).toBe(true) // same usage, two ceilings
  })

  it('wraps the Alloc bar first when node usage spills past allocatable into reserved', () => {
    const g = drawerResourceBars({
      isNode: true,
      usage: { cpuMilli: 3900 }, // > allocatable (3800), < capacity (4000)
      capacity: { cpuMilli: 4000 },
      allocatable: { cpuMilli: 3800 },
    })
    const [cap, alloc] = g[0].bars
    expect(cap.over).toBe(false) // 3900 < 4000 capacity
    expect(alloc.over).toBe(true) // 3900 > 3800 allocatable → wrapped
    expect(alloc.laps).toBe(1)
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
