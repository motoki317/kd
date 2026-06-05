import { describe, expect, it } from 'vitest'
import { activeEdgeTypes, projectEdges, relCategoriesPresent, REL_CATEGORIES } from './relationships'
import type { KEdge, RelCategory } from './types'

const e = (from: string, to: string, type: KEdge['type']): KEdge => ({ from, to, type })

const sample: KEdge[] = [
  e('dep', 'rs', 'ownerReference'),
  e('wf', 'tmpl', 'refers'), // referrer→referenced; ownership reverses it
  e('ing', 'svc', 'routes'),
  e('svc', 'pod', 'selects'),
  e('pod', 'cm', 'mounts'),
  e('rb', 'role', 'binds'),
  e('pod', 'node', 'scheduledOn'),
]

const set = (...c: RelCategory[]) => new Set(c)

describe('activeEdgeTypes', () => {
  it('unions the selected categories edge types', () => {
    expect([...activeEdgeTypes(set('ownership'))].sort()).toEqual(['ownerReference', 'refers'])
    expect([...activeEdgeTypes(set('network'))].sort()).toEqual(['routes', 'selects'])
    expect([...activeEdgeTypes(set('ownership', 'network'))].sort()).toEqual(['ownerReference', 'refers', 'routes', 'selects'])
    // Scheduling carries both pod→node and PDB→guarded-pods (a node-drain/disruption concern).
    expect([...activeEdgeTypes(set('scheduling'))].sort()).toEqual(['guards', 'scheduledOn'])
  })
  it('is empty for an empty selection', () => {
    expect(activeEdgeTypes(set()).size).toBe(0)
  })
})

describe('projectEdges', () => {
  it('keeps only edges whose type is enabled', () => {
    const out = projectEdges(sample, set('network'))
    expect(out.map((x) => x.type).sort()).toEqual(['routes', 'selects'])
  })

  it('reverses refers so the referenced provider becomes the parent', () => {
    const out = projectEdges(sample, set('ownership'))
    const refers = out.find((x) => x.type === 'refers')!
    expect(refers).toEqual({ from: 'tmpl', to: 'wf', type: 'refers' }) // swapped
    // ownerReference is NOT reversed
    expect(out.find((x) => x.type === 'ownerReference')).toEqual({ from: 'dep', to: 'rs', type: 'ownerReference' })
  })

  it('returns no edges for an empty selection (every node orphans)', () => {
    expect(projectEdges(sample, set())).toEqual([])
  })

  it('composes several categories at once', () => {
    const out = projectEdges(sample, set('ownership', 'volumes', 'scheduling'))
    expect(out.map((x) => x.type).sort()).toEqual(['mounts', 'ownerReference', 'refers', 'scheduledOn'])
  })
})

describe('relCategoriesPresent', () => {
  it('reports a category present when any of its edge types appears', () => {
    expect(relCategoriesPresent([e('a', 'b', 'binds')])).toEqual(new Set(['rbac']))
    expect(relCategoriesPresent([e('a', 'b', 'usesServiceAccount')])).toEqual(new Set(['rbac']))
    expect(relCategoriesPresent(sample)).toEqual(new Set(REL_CATEGORIES.map((c) => c.id)))
  })
  it('is empty for an edgeless graph', () => {
    expect(relCategoriesPresent([]).size).toBe(0)
  })
})
