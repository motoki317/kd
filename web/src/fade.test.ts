import { describe, it, expect } from 'vitest'
import { isNodeFaded, type FadeContext } from './fade'

const node = (id: string, kind = 'Pod', health = 'Healthy') => ({ id, kind, health })
const base: FadeContext = { kindOk: () => true, matchIds: null, relatedIds: null }

describe('isNodeFaded precedence', () => {
  it('never fades the selected node, even when a filter would exclude it', () => {
    // A search matching nothing relevant + a health filter it fails — selection still wins.
    const ctx: FadeContext = { ...base, selectedId: 'sel', matchIds: new Set<string>(), healthFilter: 'Degraded' }
    expect(isNodeFaded(node('sel', 'Pod', 'Healthy'), ctx)).toBe(false)
  })

  it('fades a node of an unselected kind regardless of search/health (kinds compose)', () => {
    const ctx: FadeContext = { ...base, kindOk: (k) => k === 'Service', matchIds: new Set(['p']), healthFilter: 'Healthy' }
    // 'p' is in the match set AND Healthy, but it's a Pod and the kind filter only allows Service.
    expect(isNodeFaded(node('p', 'Pod', 'Healthy'), ctx)).toBe(true)
    expect(isNodeFaded(node('s', 'Service', 'Healthy'), { ...ctx, matchIds: new Set(['s']) })).toBe(false)
  })

  it('search wins over health + related once kind passes', () => {
    const ctx: FadeContext = { ...base, matchIds: new Set(['hit']), healthFilter: 'Degraded', relatedIds: new Set(['other']) }
    expect(isNodeFaded(node('hit'), ctx)).toBe(false) // matched
    expect(isNodeFaded(node('miss'), ctx)).toBe(true) // unmatched, even if it were related/healthy
  })

  it('health filter applies when there is no search', () => {
    const ctx: FadeContext = { ...base, healthFilter: 'Degraded' }
    expect(isNodeFaded(node('a', 'Pod', 'Degraded'), ctx)).toBe(false)
    expect(isNodeFaded(node('b', 'Pod', 'Healthy'), ctx)).toBe(true)
  })

  it('falls back to the related subtree when only a selection is active', () => {
    const ctx: FadeContext = { ...base, selectedId: 'sel', relatedIds: new Set(['sel', 'friend']) }
    expect(isNodeFaded(node('friend'), ctx)).toBe(false) // in the spotlight subtree
    expect(isNodeFaded(node('stranger'), ctx)).toBe(true) // outside it
  })

  it('fades nothing when no selection, search, or filter is active', () => {
    expect(isNodeFaded(node('x'), base)).toBe(false)
  })
})
