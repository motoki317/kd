import type { KNode, Resources, ResourceUsage } from './types'

// WorkloadUsage is a workload's resource consumption rolled up from its descendant pods, so the drawer
// can gauge a Deployment/StatefulSet's TOTAL live usage against its TOTAL reservation — the "how much is
// this workload using?" answer a per-pod view can't give at a glance.
export interface WorkloadUsage {
  usage: ResourceUsage
  requests?: Resources
  limits?: Resources
  podCount: number // descendant pods in the graph
  meteredPods: number // how many had a usage reading (metrics-server can lag a freshly-created pod)
}

// aggregateWorkloadUsage sums descendant-pod usage and requests/limits. Usage comes from the capacity
// feed (keyed by pod UID); requests/limits from each pod node. A bound is summed across the pods that set
// it and stays defined if ANY pod does (identical replicas reserve identically; a partial set still reads
// meaningfully as "ΣrequestsThatExist"). Returns null when no descendant pod has a usage reading yet, so
// the caller shows nothing rather than a misleading "0 used".
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
  for (const p of pods) {
    const u = usage[p.id]
    if (u) {
      metered++
      cpuMilli += u.cpuMilli ?? 0
      memBytes += u.memBytes ?? 0
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
  return {
    usage: { cpuMilli, memBytes },
    requests: hasReqCpu || hasReqMem ? { cpuMilli: hasReqCpu ? reqCpu : undefined, memBytes: hasReqMem ? reqMem : undefined } : undefined,
    limits: hasLimCpu || hasLimMem ? { cpuMilli: hasLimCpu ? limCpu : undefined, memBytes: hasLimMem ? limMem : undefined } : undefined,
    podCount: pods.length,
    meteredPods: metered,
  }
}
