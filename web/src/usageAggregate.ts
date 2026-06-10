import type { ContainerUsage, KNode, Resources, ResourceUsage } from './types'

// WorkloadUsage is a workload's resource consumption rolled up from its descendant pods, so the drawer
// can gauge a Deployment/StatefulSet's TOTAL live usage against its TOTAL reservation — the "how much is
// this workload using?" answer a per-pod view can't give at a glance.
export interface WorkloadUsage {
  usage: ResourceUsage
  requests?: Resources
  limits?: Resources
  podCount: number // descendant pods in the graph
  meteredPods: number // how many had a usage reading (metrics-server can lag a freshly-created pod)
  // Each metered pod's own total — the "group by pod" segment source (one share per replica). Reuses
  // the ContainerUsage shape (a named cpu/mem share); name-sorted so segment order is stable across
  // ticks. Sums exactly to `usage` by construction: unmetered pods are excluded from both.
  pods: ContainerUsage[]
}

// aggregateWorkloadUsage sums descendant-pod usage and requests/limits. Usage comes from the capacity
// feed (keyed by pod UID); requests/limits from each pod node. The bound is summed over ONLY the metered
// pods — the same set the usage numerator covers — so the gauge plots a like-for-like ratio. Summing the
// bound over ALL pods while usage covers only the metered ones understated utilization on a rollout
// (a 10-replica Deployment with 3 pods not-yet-metered gauged Σusage(7) against Σrequests(10), reading
// ~30% short and faking headroom); the "summed across M of N pods" caption then describes both sides
// honestly. Returns null when no descendant pod has a usage reading yet, so the caller shows nothing
// rather than a misleading "0 used".
export function aggregateWorkloadUsage(
  pods: KNode[],
  usage: Record<string, ResourceUsage> | undefined,
): WorkloadUsage | null {
  if (!usage || pods.length === 0) return null
  let cpuMilli = 0
  let memBytes = 0
  let metered = 0
  let reqCpu = 0
  let reqMem = 0
  let limCpu = 0
  let limMem = 0
  let hasReqCpu = false
  let hasReqMem = false
  let hasLimCpu = false
  let hasLimMem = false
  // Per-container sums across the fleet ("is the sidecar overhead material workload-wide?") — the
  // same names recur on every replica, so summing by name keeps the pod-level segment vocabulary.
  const byName = new Map<string, { cpuMilli: number; memBytes: number }>()
  const podShares: ContainerUsage[] = []
  for (const p of pods) {
    const u = usage[p.id]
    if (!u) continue // unmetered pod: excluded from BOTH sides so the ratio stays like-for-like
    metered++
    cpuMilli += u.cpuMilli ?? 0
    memBytes += u.memBytes ?? 0
    podShares.push({ name: p.name, cpuMilli: u.cpuMilli ?? 0, memBytes: u.memBytes ?? 0 })
    for (const c of u.containers ?? []) {
      const acc = byName.get(c.name) ?? { cpuMilli: 0, memBytes: 0 }
      acc.cpuMilli += c.cpuMilli ?? 0
      acc.memBytes += c.memBytes ?? 0
      byName.set(c.name, acc)
    }
    if (p.requests?.cpuMilli != null) {
      hasReqCpu = true
      reqCpu += p.requests.cpuMilli
    }
    if (p.requests?.memBytes != null) {
      hasReqMem = true
      reqMem += p.requests.memBytes
    }
    if (p.limits?.cpuMilli != null) {
      hasLimCpu = true
      limCpu += p.limits.cpuMilli
    }
    if (p.limits?.memBytes != null) {
      hasLimMem = true
      limMem += p.limits.memBytes
    }
  }
  if (metered === 0) return null
  // Name-sorted like the server's per-pod breakdown, so segment order is stable across ticks.
  // Only emitted when there's a real split to show (same >1 gate as the wire format).
  const containers: ContainerUsage[] = [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => ({ name, cpuMilli: v.cpuMilli, memBytes: v.memBytes }))
  return {
    usage: { cpuMilli, memBytes, containers: containers.length > 1 ? containers : undefined },
    requests: hasReqCpu || hasReqMem ? { cpuMilli: hasReqCpu ? reqCpu : undefined, memBytes: hasReqMem ? reqMem : undefined } : undefined,
    limits: hasLimCpu || hasLimMem ? { cpuMilli: hasLimCpu ? limCpu : undefined, memBytes: hasLimMem ? limMem : undefined } : undefined,
    podCount: pods.length,
    meteredPods: metered,
    pods: podShares.sort((a, b) => a.name.localeCompare(b.name)),
  }
}
