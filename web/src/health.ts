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

// rollupHealth summarizes resources into the worst health present and how many are not Healthy — the
// client mirror of the server's namespace Summarize. It keeps the sidebar entry for the namespace
// you're viewing live (from the streamed graph) instead of waiting for the 15s /namespaces poll.
export function rollupHealth(items: { health: Health }[]): { health: Health; nonReady: number } {
  let health: Health = 'Healthy'
  let nonReady = 0
  for (const it of items) {
    if (it.health !== 'Healthy') nonReady++
    if (healthSeverity[it.health] > healthSeverity[health]) health = it.health
  }
  return { health, nonReady }
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
