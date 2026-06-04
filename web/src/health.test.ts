import { describe, it, expect } from 'vitest'
import { HEALTH_ORDER, healthSeverity, healthHint, healthColor } from './health'
import type { Health } from './types'

describe('health mappings', () => {
  it('orders severity troubled-first (Degraded highest, Healthy lowest)', () => {
    // The drawer/legend and j/k navigation step "troubled first" off this ordering.
    const bySeverity = [...HEALTH_ORDER].sort((a, b) => healthSeverity[b] - healthSeverity[a])
    expect(bySeverity).toEqual(['Degraded', 'Progressing', 'Unknown', 'Suspended', 'Healthy'])
  })

  it('maps each state to its own health CSS variable', () => {
    expect(healthColor('Healthy')).toBe('var(--health-healthy)')
    expect(healthColor('Progressing')).toBe('var(--health-progressing)')
    expect(healthColor('Degraded')).toBe('var(--health-degraded)')
    expect(healthColor('Suspended')).toBe('var(--health-suspended)')
    expect(healthColor('Unknown')).toBe('var(--health-unknown)')
  })

  it('falls back to the unknown colour for an unexpected value', () => {
    // The server is the source of truth for Health; a value the client doesn't know must still
    // render a dot (the neutral unknown grey), not undefined.
    expect(healthColor('Bogus' as Health)).toBe('var(--health-unknown)')
  })

  // Completeness guard: adding a Health enum value but forgetting to give it a hint, severity, or a
  // distinct colour is a silent gap (a blank tooltip, a mis-ordered dot). Pin that every state in
  // HEALTH_ORDER is fully mapped and every colour is distinct.
  it('fully and distinctly maps every state in HEALTH_ORDER', () => {
    const colours = new Set<string>()
    for (const h of HEALTH_ORDER) {
      expect(healthSeverity[h]).toBeTypeOf('number')
      expect(healthHint[h]).toBeTruthy()
      expect(healthHint[h].toLowerCase()).toContain(h.toLowerCase()) // hint names its state
      colours.add(healthColor(h))
    }
    expect(colours.size).toBe(HEALTH_ORDER.length) // no two states share a colour
  })
})
