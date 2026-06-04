import { describe, expect, it } from 'vitest'
import { tipFromAgg, tipFromNodeUse, tipFromSeg } from './capacityTooltips'
import type { CapAggregate, CapRow, CapSeg } from './capacityLayout'

const seg = (use: number, req?: number): CapSeg =>
  ({ node: { id: 'p', kind: 'Pod', name: 'web-0', health: 'Healthy' }, use, req, over: false, nearLimit: false, x: 0, y: 0, width: 0, height: 0 }) as CapSeg

describe('capacity tooltips', () => {
  it('a segment shows its name + the metric it contributes on the hovered bar', () => {
    expect(tipFromSeg(seg(800, 500), 'use', 'cpu')).toEqual({ title: 'web-0', value: '800m' })
    expect(tipFromSeg(seg(800, 500), 'req', 'cpu')).toEqual({ title: 'web-0', value: '500m' })
    // No request → req metric reads 0, never NaN/undefined.
    expect(tipFromSeg(seg(800), 'req', 'cpu')).toEqual({ title: 'web-0', value: '0' })
  })

  it('formats by the active resource', () => {
    expect(tipFromSeg(seg(2 * 1024 ** 3), 'use', 'memory').value).toBe('2Gi')
  })

  it('a small fold names the pod count; an other-ns fold adds the outside-namespace sub', () => {
    const small: CapAggregate = { variant: 'small', count: 3, use: 12, req: 30, x: 0, y: 0, width: 0, height: 0 }
    expect(tipFromAgg(small, 'req', 'cpu')).toEqual({ title: '3 small pods', sub: undefined, value: '30m' })
    const other: CapAggregate = { variant: 'other', count: 1, use: 50, req: 0, x: 0, y: 0, width: 0, height: 0 }
    expect(tipFromAgg(other, 'use', 'cpu')).toEqual({ title: 'Other namespaces', sub: '1 pod outside this namespace', value: '50m' })
  })

  it('overhead is node total usage minus all pods, floored at 0', () => {
    const row = { nodeUse: 1200, useTotal: 800 } as CapRow
    expect(tipFromNodeUse(row, 'cpu')).toEqual({ title: 'Overhead', sub: 'non-pod / system (kubelet, runtime)', value: '400m' })
    // Pods sum to more than NodeMetrics reports (sampling skew) → overhead clamps to 0, not negative.
    expect(tipFromNodeUse({ nodeUse: 700, useTotal: 800 } as CapRow, 'cpu').value).toBe('0')
  })
})
