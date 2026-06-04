import { describe, it, expect } from 'vitest'
import { kindStats } from './kindStats'
import type { PositionedNode } from './layout'
import type { Health } from './types'

// Minimal positioned node — kindStats only reads kind/health/collapse, so the geometry is filler.
const node = (kind: string, health: Health, extra: Partial<PositionedNode> = {}): PositionedNode => ({
  id: `${kind}-${Math.round(extra.x ?? 0)}-${health}`,
  kind,
  name: kind.toLowerCase(),
  health,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ...extra,
})

const pill = (groupKind: string, hidden: PositionedNode[], expanded: boolean, hiddenDescendants?: PositionedNode[]): PositionedNode =>
  node('__collapse__', 'Healthy', {
    collapse: { key: 'k', groupKind, hidden, expanded, hiddenDescendants } as PositionedNode['collapse'],
  })

describe('kindStats', () => {
  it('counts per kind and keeps the most-severe non-Healthy worst', () => {
    const stats = kindStats([node('Pod', 'Healthy'), node('Pod', 'Degraded'), node('Pod', 'Progressing'), node('Service', 'Healthy')])
    expect(stats.get('Pod')).toEqual({ count: 3, worst: 'Degraded' }) // Degraded outranks Progressing
    expect(stats.get('Service')).toEqual({ count: 1, worst: null }) // all Healthy → no dot
  })

  it('folds a COLLAPSED pill\'s hidden nodes back into the count (chip reflects the true total)', () => {
    const hidden = [node('Pod', 'Healthy'), node('Pod', 'Degraded')]
    const stats = kindStats([node('Pod', 'Healthy'), pill('Pod', hidden, false)])
    // 1 visible + 2 hidden = 3, worst from the hidden Degraded.
    expect(stats.get('Pod')).toEqual({ count: 3, worst: 'Degraded' })
  })

  it('does NOT fold an EXPANDED pill (its nodes are real cards counted directly — no double count)', () => {
    const hidden = [node('Pod', 'Healthy'), node('Pod', 'Degraded')]
    // Expanded: the two hidden are present as real cards in the list; the pill must contribute nothing.
    const stats = kindStats([node('Pod', 'Healthy'), node('Pod', 'Degraded'), pill('Pod', hidden, true)])
    expect(stats.get('Pod')?.count).toBe(2)
    // __collapse__ is synthetic and must never become its own kind chip.
    expect(stats.has('__collapse__')).toBe(false)
  })

  it('folds hidden DESCENDANTS of another kind back too (a folded Workflow drags its Pods)', () => {
    const hiddenWf = [node('Workflow', 'Healthy')]
    const hiddenPods = [node('Pod', 'Healthy'), node('Pod', 'Healthy')]
    const stats = kindStats([pill('Workflow', hiddenWf, false, hiddenPods)])
    expect(stats.get('Workflow')?.count).toBe(1)
    expect(stats.get('Pod')?.count).toBe(2) // the dragged-along Pods stay counted while folded
  })
})
