import { describe, expect, it } from 'vitest'
import { DASHED, EDGE_LABELS, edgePath, edgeTitle, nonOwnershipEdgeLabels } from './edgeRender'
import type { EdgeType, KEdge, KNode } from './types'

const node = (id: string, kind: string, name: string, namespace?: string): KNode =>
  ({ id, kind, name, namespace, health: 'Healthy' }) as KNode

describe('edgePath', () => {
  it('a straight 2-point edge is a plain move+line (no curve)', () => {
    expect(edgePath([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe('M 0,0 L 10,0')
  })

  // SVG numbers carry float noise (7 → 7.0000001); compare the command structure and the values
  // numerically rather than as an exact string.
  const nums = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const cmds = (d: string) => d.match(/[MLQ]/g)!.join('')

  it('rounds each interior elbow with a quadratic bezier, keeping the final segment axis-aligned', () => {
    // A right-angle elbow at (100,0): legs long enough that the 7px corner radius is not clamped. The
    // corner pulls back 7px before the vertex (L 93,0) and curves 7px past it (Q 100,0 100,7).
    const d = edgePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])
    expect(cmds(d)).toBe('MLQL')
    expect(nums(d)).toEqual([0, 0, 93, 0, 100, 0, 100, 7, 100, 100].map((n) => expect.closeTo(n, 6)))
  })

  it('clamps the corner radius to half the shorter adjacent segment so stubby legs do not overshoot', () => {
    // The leg into the vertex is only 4px, so the radius clamps to 2 (half of 4), not the 7px default.
    const d = edgePath([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 100 }])
    expect(cmds(d)).toBe('MLQL')
    expect(nums(d)).toEqual([0, 0, 2, 0, 4, 0, 4, 2, 4, 100].map((n) => expect.closeTo(n, 6)))
  })
})

describe('edgeTitle', () => {
  const byId = new Map([node('a', 'Service', 'web', 'prod'), node('b', 'Pod', 'web-0', 'prod')].map((n) => [n.id, n]))

  it('reads "<from> <verb> <to>" with namespaced labels', () => {
    const e = { from: 'a', to: 'b', type: 'selects' } as KEdge
    expect(edgeTitle(e, byId)).toBe('Service prod/web selects Pod prod/web-0')
  })

  it('names a bundled hub→pill edge as "folded resources" rather than leaking the sentinel id', () => {
    const e = { from: 'a', to: '__collapse__:host:node-1', type: 'ownerReference' } as KEdge
    expect(edgeTitle(e, byId)).toBe('Service prod/web owns folded resources')
  })

  it('falls back to the raw id when an endpoint is missing from the node set', () => {
    const e = { from: 'ghost', to: 'b', type: 'mounts' } as KEdge
    expect(edgeTitle(e, byId)).toBe('ghost mounts Pod prod/web-0')
  })
})

describe('DASHED', () => {
  it('marks non-ownership edges dashed and leaves ownerReference solid', () => {
    expect(DASHED.ownerReference).toBeUndefined()
    expect(DASHED.selects).toBe(true)
    expect(DASHED.mounts).toBe(true)
  })
})

describe('nonOwnershipEdgeLabels', () => {
  it('covers EVERY dashed edge type — the help legend had drifted and dropped "runs as"', () => {
    // The legend must list a verb for each dashed type; a hand-maintained copy silently lost
    // usesServiceAccount. Deriving from DASHED makes that impossible.
    const dashedTypes = Object.keys(DASHED) as EdgeType[]
    const labels = nonOwnershipEdgeLabels()
    expect(labels).toHaveLength(dashedTypes.length)
    expect(labels).toContain('runs as') // usesServiceAccount — the one that was missing
    for (const t of dashedTypes) expect(labels).toContain(EDGE_LABELS[t])
  })

  it('excludes the solid ownership backbone', () => {
    expect(nonOwnershipEdgeLabels()).not.toContain('owns')
  })
})
