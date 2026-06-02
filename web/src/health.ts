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
