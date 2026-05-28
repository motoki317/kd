// Favicon attention badge. Multi-tab operators keep several kd tabs open (prod / staging / one per
// cluster); a static favicon means they have to click into a tab to learn whether anything's wrong
// there. This module composes the brand mark with a small colored circle in the corner whose color
// matches the worst-health state visible in the current view, so the tab itself signals "look at
// me" — same idea as Gmail's unread count favicon, but for cluster trouble.

import { healthSeverity, HEALTH_ORDER } from './health'
import type { Health } from './types'

// Hex values mirror the --health-* CSS variables in index.css. Centralized as plain hex here
// because data-URL SVGs can't read CSS custom properties (no document context to resolve them).
// If the CSS palette changes, update both.
const HEALTH_HEX: Record<Health, string> = {
  Healthy: '#18be94',
  Progressing: '#2f86eb',
  Degraded: '#e5544b',
  Suspended: '#f0a92a',
  Unknown: '#9aa5b1',
}

// worstHealth returns the most attention-worthy health state present in the given counts, or null
// when nothing is present at all (empty/loading state — favicon falls back to plain brand mark).
// Pure healthy reads as "no badge needed" → returns null so the caller hides the dot.
export function worstHealth(counts: Partial<Record<Health, number>>): Health | null {
  let worst: Health | null = null
  for (const h of HEALTH_ORDER) {
    if (!counts[h]) continue
    if (worst === null || healthSeverity[h] > healthSeverity[worst]) worst = h
  }
  return worst && worst !== 'Healthy' ? worst : null
}

// faviconSvg returns the SVG markup for the favicon. The badge is a filled circle in the bottom-
// right at ~30% of the canvas size, with a white outline so it stays visible on light favicons in
// dark browser chrome (and vice versa). Hidden entirely when worst is null.
export function faviconSvg(worst: Health | null): string {
  const badge = worst
    ? `<circle cx="12.5" cy="12.5" r="3.2" fill="${HEALTH_HEX[worst]}" stroke="#ffffff" stroke-width="0.9"/>`
    : ''
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32">' +
    '<rect x="5" y="2" width="6" height="2.4" rx="1" fill="#2f6feb"/>' +
    '<rect x="3" y="6.6" width="10" height="2.4" rx="1" fill="#2f6feb"/>' +
    '<rect x="1" y="11.2" width="14" height="2.4" rx="1" fill="#2f6feb"/>' +
    badge +
    '</svg>'
  )
}

// faviconDataUrl wraps faviconSvg into a data: URL suitable for assignment to <link rel="icon">.
// Using encodeURIComponent is enough — the SVG payload contains only ASCII, no need for base64.
export function faviconDataUrl(worst: Health | null): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(worst))}`
}
