// Maps the normalized health enum to UI colors. Centralized so the topology, legend, and
// status chips stay consistent (the colors are defined as CSS custom properties in index.css).

import type { Health } from './types'

export const HEALTH_ORDER: Health[] = ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Unknown']

// Attention-worthiness (mirrors the server's graph.severity), for ordering troubled items first.
export const healthSeverity: Record<Health, number> = {
  Degraded: 4,
  Progressing: 3,
  Unknown: 2,
  Suspended: 1,
  Healthy: 0,
}

// worstNonHealthy folds a set of health states to the most attention-worthy non-Healthy one (the
// server's graph.severity order), or null when every state is Healthy. The shared primitive behind the
// kind-chip severity dots, the collapse-pill trouble badge, and the favicon attention badge.
export function worstNonHealthy(healths: Iterable<Health>): Health | null {
  let worst: Health | null = null
  for (const h of healths) {
    if (h === 'Healthy') continue
    if (worst === null || healthSeverity[h] > healthSeverity[worst]) worst = h
  }
  return worst
}

// Plain-English gloss for each health state. The bare enum word — "Unknown" especially — doesn't
// tell a first-time operator what a colored dot means, so tooltips use this instead of the raw word.
export const healthHint: Record<Health, string> = {
  Healthy: 'Healthy — all resources are OK',
  Progressing: 'Progressing — a change is rolling out',
  Degraded: 'Degraded — something is broken',
  Suspended: 'Suspended — intentionally paused',
  Unknown: "Unknown — kd can't classify these (often custom resources)",
}

export function healthColor(h: Health): string {
  switch (h) {
    case 'Healthy':
      return 'var(--health-healthy)'
    case 'Progressing':
      return 'var(--health-progressing)'
    case 'Degraded':
      return 'var(--health-degraded)'
    case 'Suspended':
      return 'var(--health-suspended)'
    default:
      return 'var(--health-unknown)'
  }
}

// Health colour for TEXT (statuses, reasons): the vivid degraded/progressing/suspended hues sit
// under the 4.5:1 WCAG text bar on the light theme's near-white surfaces at the 11–13px sizes
// statuses render at, so text takes the darker `*-text` ink (same hue family; the dark theme maps
// them back to the vivid values). Dots/fills/borders keep healthColor — the 3:1 graphics bar.
export function healthTextColor(h: Health): string {
  switch (h) {
    case 'Progressing':
      return 'var(--progressing-text)'
    case 'Degraded':
      return 'var(--degraded-text)'
    case 'Suspended':
      return 'var(--caution-text)'
    default:
      return healthColor(h)
  }
}
