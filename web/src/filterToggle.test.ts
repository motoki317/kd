import { describe, expect, it } from 'vitest'
import { toggleInSet } from './filterToggle'

describe('toggleInSet', () => {
  describe('plain toggle (no solo)', () => {
    it('adds an item not in the set', () => {
      expect([...toggleInSet(new Set(['a']), 'b', false)].sort()).toEqual(['a', 'b'])
    })
    it('removes an item already in the set', () => {
      expect([...toggleInSet(new Set(['a', 'b']), 'b', false)]).toEqual(['a'])
    })
    it('does not mutate the input set', () => {
      const input = new Set(['a'])
      toggleInSet(input, 'b', false)
      expect([...input]).toEqual(['a'])
    })
  })

  describe('solo', () => {
    it('isolates the item, clearing a prior multi-select', () => {
      expect([...toggleInSet(new Set(['a', 'b', 'c']), 'b', true)]).toEqual(['b'])
    })
    it('isolates the item from an empty set', () => {
      expect([...toggleInSet(new Set<string>(), 'b', true)]).toEqual(['b'])
    })
    it('clears to empty when the filter is ALREADY exactly that one item (re-solo toggles off)', () => {
      // The deliberate edge case: a second solo on the sole active chip empties the filter,
      // doubling as a "clear all chips" gesture.
      expect([...toggleInSet(new Set(['b']), 'b', true)]).toEqual([])
    })
    it('does NOT clear when the sole item differs from the soloed one', () => {
      expect([...toggleInSet(new Set(['a']), 'b', true)]).toEqual(['b'])
    })
  })
})
