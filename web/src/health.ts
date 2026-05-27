// Maps the normalized health enum to UI colors. Centralized so the topology, legend, and
// status chips stay consistent (the colors are defined as CSS custom properties in index.css).

import type { Health } from './types'

export const HEALTH_ORDER: Health[] = ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Unknown']

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
