import { healthSeverity } from './health'
import type { PositionedNode } from './layout'
import type { Health } from './types'

export interface KindStat {
  count: number
  // The most-severe non-Healthy health among this kind's nodes, or null when all are Healthy — drives
  // the per-chip severity dot ("which kinds carry trouble"). Healthy never sets it, so a kind with no
  // trouble shows no dot.
  worst: Health | null
}

// kindStats tallies per-kind counts and the worst (most-severe non-Healthy) health across the
// CURRENTLY LAID-OUT nodes, used to badge the kind-filter chips. The load-bearing subtlety is the
// collapse pill: a synthetic "+N more" pill is folded back into the count ONLY while collapsed (its
// hidden nodes aren't drawn, so the chip must still include them); once expanded those nodes are real
// cards counted directly, so folding them back too would double-count. A pill also drags descendants of
// another kind (a folded Workflow's Pods) — those fold back the same way so every kind chip stays
// honest regardless of what is currently folded.
export function kindStats(nodes: PositionedNode[]): Map<string, KindStat> {
  const stats = new Map<string, KindStat>()
  const add = (n: { kind: string; health: Health }) => {
    const s = stats.get(n.kind)
    if (!s) {
      stats.set(n.kind, { count: 1, worst: n.health !== 'Healthy' ? n.health : null })
      return
    }
    s.count++
    if (n.health !== 'Healthy' && (s.worst === null || healthSeverity[n.health] > healthSeverity[s.worst])) {
      s.worst = n.health
    }
  }
  for (const n of nodes) {
    if (n.collapse) {
      if (!n.collapse.expanded) {
        for (const h of n.collapse.hidden) add(h)
        for (const h of n.collapse.hiddenDescendants ?? []) add(h)
      }
      continue
    }
    add(n)
  }
  return stats
}
