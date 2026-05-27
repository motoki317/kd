import { describe, expect, it } from 'vitest'
import { rollupHealth } from './health'
import type { Health } from './types'

const h = (health: Health) => ({ health })

describe('rollupHealth', () => {
  it('reports the worst health present and counts the non-healthy', () => {
    expect(rollupHealth([h('Healthy'), h('Progressing'), h('Degraded'), h('Healthy')])).toEqual({
      health: 'Degraded',
      nonReady: 2,
    })
  })

  it('is Healthy with a zero count when everything is healthy', () => {
    expect(rollupHealth([h('Healthy'), h('Healthy')])).toEqual({ health: 'Healthy', nonReady: 0 })
  })

  it('is Healthy/0 for an empty set', () => {
    expect(rollupHealth([])).toEqual({ health: 'Healthy', nonReady: 0 })
  })

  it('ranks Progressing above Suspended/Unknown as the worst', () => {
    expect(rollupHealth([h('Suspended'), h('Unknown'), h('Progressing')]).health).toBe('Progressing')
  })
})
