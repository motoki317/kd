import { describe, expect, it } from 'vitest'
import { aggregateWorkloadUsage } from './usageAggregate'
import type { KNode, ResourceUsage } from './types'

function pod(id: string, requests?: KNode['requests'], limits?: KNode['limits']): KNode {
  return { id, kind: 'Pod', name: id, namespace: 'ns', health: 'Healthy', requests, limits } as KNode
}

describe('aggregateWorkloadUsage', () => {
  it('sums usage and requests/limits across descendant pods', () => {
    const pods = [
      pod('a', { cpuMilli: 100, memBytes: 200 }, { cpuMilli: 250, memBytes: 500 }),
      pod('b', { cpuMilli: 100, memBytes: 200 }, { cpuMilli: 250, memBytes: 500 }),
    ]
    const usage: Record<string, ResourceUsage> = {
      a: { cpuMilli: 80, memBytes: 150 },
      b: { cpuMilli: 120, memBytes: 250 },
    }
    const agg = aggregateWorkloadUsage(pods, usage)
    expect(agg).toEqual({
      usage: { cpuMilli: 200, memBytes: 400 },
      requests: { cpuMilli: 200, memBytes: 400 },
      limits: { cpuMilli: 500, memBytes: 1000 },
      podCount: 2,
      meteredPods: 2,
    })
  })

  it('counts only metered pods for usage but all pods for podCount', () => {
    const pods = [pod('a', { cpuMilli: 100 }), pod('b', { cpuMilli: 100 })]
    const agg = aggregateWorkloadUsage(pods, { a: { cpuMilli: 70 } })
    expect(agg?.usage).toEqual({ cpuMilli: 70, memBytes: 0 })
    expect(agg?.podCount).toBe(2)
    expect(agg?.meteredPods).toBe(1)
    // request summed across both pods that set it
    expect(agg?.requests).toEqual({ cpuMilli: 200, memBytes: undefined })
  })

  it('returns null when no descendant pod has a usage reading', () => {
    expect(aggregateWorkloadUsage([pod('a', { cpuMilli: 100 })], {})).toBeNull()
    expect(aggregateWorkloadUsage([pod('a')], undefined)).toBeNull()
  })

  it('returns null for an empty pod set', () => {
    expect(aggregateWorkloadUsage([], { a: { cpuMilli: 10 } })).toBeNull()
  })

  it('leaves a bound undefined when no pod sets it', () => {
    // pods set requests but no limits → limits stays undefined (not a phantom 0-ceiling gauge)
    const agg = aggregateWorkloadUsage([pod('a', { cpuMilli: 100, memBytes: 200 })], { a: { cpuMilli: 50, memBytes: 100 } })
    expect(agg?.requests).toEqual({ cpuMilli: 100, memBytes: 200 })
    expect(agg?.limits).toBeUndefined()
  })
})
