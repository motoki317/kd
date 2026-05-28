import { describe, expect, it } from 'vitest'
import { faviconDataUrl, faviconSvg, worstHealth } from './favicon'

describe('favicon', () => {
  describe('worstHealth', () => {
    it('returns null when counts are empty (no badge to draw)', () => {
      expect(worstHealth({})).toBe(null)
    })

    it('returns null when only Healthy is present (favicon stays plain)', () => {
      expect(worstHealth({ Healthy: 7 })).toBe(null)
    })

    it('picks Degraded over Progressing (severity order)', () => {
      expect(worstHealth({ Progressing: 1, Degraded: 1, Healthy: 5 })).toBe('Degraded')
    })

    it('picks Progressing over Unknown', () => {
      expect(worstHealth({ Unknown: 1, Progressing: 1 })).toBe('Progressing')
    })

    it('ignores zero-count entries', () => {
      expect(worstHealth({ Degraded: 0, Progressing: 2 })).toBe('Progressing')
    })
  })

  describe('faviconSvg', () => {
    it('omits the badge when worst is null', () => {
      const svg = faviconSvg(null)
      expect(svg).not.toContain('<circle')
      expect(svg).toContain('<rect') // brand mark still present
    })

    it('embeds the badge with the matching health hex when worst is set', () => {
      // Degraded color from index.css is #e5544b — favicon mirrors it directly.
      const svg = faviconSvg('Degraded')
      expect(svg).toContain('<circle')
      expect(svg).toContain('#e5544b')
    })
  })

  describe('faviconDataUrl', () => {
    it('returns a data:image/svg+xml URL', () => {
      expect(faviconDataUrl('Degraded')).toMatch(/^data:image\/svg\+xml,/)
    })

    it('encodes the svg payload so it can be assigned to link.href', () => {
      const url = faviconDataUrl('Progressing')
      expect(url).toContain('%3Csvg')
    })
  })
})
