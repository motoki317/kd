import { describe, it, expect } from 'vitest'
import { drawerResourceBars, hostNodeCapacity } from './resourceBars'
import type { KNode } from './types'

const Gi = 1024 ** 3

describe('drawerResourceBars — Pod / workload', () => {
  it('puts both bars on ONE shared scale: same usage ⇒ same fill, bounds differ only in track length', () => {
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
    // groupMax = max(usage 300, lim 400, req 200) = 400. The fill is the SAME usage on both bars, so it
    // draws the SAME length (0.75) — the comparability the old per-bound-as-100% model lacked.
    expect(lim.fillFrac).toBeCloseTo(0.75)
    expect(req.fillFrac).toBeCloseTo(0.75)
    // The bounds differ only in track length on the shared ruler: the 400 limit reaches 1.0, the
    // 200 request only 0.5 — so the Req bar reads visibly shorter.
    expect(lim.boundFrac).toBeCloseTo(1.0)
    expect(req.boundFrac).toBeCloseTo(0.5)
    // Usage is under the limit but over the request → only the Req bar is "over" (fill past its ceiling).
    expect(lim.over).toBe(false)
    expect(req.over).toBe(true)
  })

  it('lets the fill run to the full scale when usage bursts past every bound', () => {
    // usage 500 is the group max → fill 1.0; the 200 request bound sits at 0.4, so 0.4→1.0 is overshoot.
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 500 }, request: { cpuMilli: 200 } })
    const req = g[0].bars[0]
    expect(req.fillFrac).toBeCloseTo(1.0)
    expect(req.boundFrac).toBeCloseTo(0.4)
    expect(req.over).toBe(true)
  })

  it('reads exactly at the bound as a full bar, not over', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 200 }, limit: { cpuMilli: 200 } })
    const lim = g[0].bars[0]
    expect(lim.fillFrac).toBeCloseTo(1.0)
    expect(lim.boundFrac).toBeCloseTo(1.0)
    expect(lim.over).toBe(false) // usage == bound is full, not over
  })

  it('falls back to the HOST NODE capacity as the bound when neither limit nor request is set', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 }, hostCapacity: { cpuMilli: 4000 } })
    const bar = g[0].bars[0]
    expect(bar.label).toBe('Node')
    expect(bar.ceil).toBe(4000)
    expect(bar.fillFrac).toBeCloseTo(0.0625) // 250 / 4000 — a small slice of the node
    expect(bar.boundFrac).toBeCloseTo(1.0)
    expect(bar.unconstrained).toBeFalsy()
  })

  it('marks a truly unconstrained resource (no bound, no host capacity) so the track shows dashed', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 250 } })
    expect(g[0].bars[0].unconstrained).toBe(true)
    expect(g[0].bars[0].usage).toBe(250)
    expect(g[0].bars[0].boundFrac).toBeUndefined()
  })

  it('still shows the bars (empty fill, bound-length tracks) from spec bounds when metrics are unavailable', () => {
    const g = drawerResourceBars({ isNode: false, request: { cpuMilli: 200 }, limit: { cpuMilli: 400 } })
    const cpu = g[0]
    expect(cpu.bars.map((b) => b.label)).toEqual(['Lim', 'Req'])
    expect(cpu.bars.every((b) => b.usage === undefined && b.fillFrac === 0)).toBe(true)
    // Even with no usage, the track lengths still encode the relative bounds (limit 1.0, request 0.5).
    expect(cpu.bars[0].boundFrac).toBeCloseTo(1.0)
    expect(cpu.bars[1].boundFrac).toBeCloseTo(0.5)
  })

  it('omits a resource entirely when it has neither usage nor any bound', () => {
    const g = drawerResourceBars({ isNode: false, usage: { cpuMilli: 100 } }) // memory has nothing
    expect(g.map((x) => x.res)).toEqual(['cpu'])
  })
})

describe('drawerResourceBars — Node', () => {
  it('builds a Cap bar (bound=capacity) over an Alloc bar (bound=allocatable), one shared scale', () => {
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
    expect(cpu.bars.every((b) => b.usage === 600)).toBe(true) // same usage, two bounds
    expect(cpu.bars[0].fillFrac).toBeCloseTo(cpu.bars[1].fillFrac) // identical fill length
    expect(cpu.bars[1].boundFrac).toBeCloseTo(0.95) // allocatable 3800 / 4000 scale
  })

  it('flags only the Alloc bar over when node usage spills past allocatable into reserved', () => {
    const g = drawerResourceBars({
      isNode: true,
      usage: { cpuMilli: 3900 }, // > allocatable (3800), < capacity (4000)
      capacity: { cpuMilli: 4000 },
      allocatable: { cpuMilli: 3800 },
    })
    const [cap, alloc] = g[0].bars
    expect(cap.over).toBe(false) // 3900 < 4000 capacity
    expect(alloc.over).toBe(true) // 3900 > 3800 allocatable → fill runs past its ceiling
    expect(alloc.fillFrac).toBeCloseTo(0.975) // 3900 / 4000
    expect(alloc.boundFrac).toBeCloseTo(0.95) // 3800 / 4000
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
