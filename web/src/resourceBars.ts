// The drawer's CPU/memory resource bars. Mirrors the Nodes capacity view's "Use over Req" idiom: per
// resource, a Use bar (live usage) sits directly over a Req bar (reserved request), BOTH sharing one
// track (the same px scale) so the two read against each other at a glance — exactly the node bars in
// the Nodes group-by, brought into the drawer. A Node gauges Use against its total capacity and Req
// against allocatable (Σ pod requests vs schedulable, the overcommit line); a Pod/workload gauges both
// against its limit, falling back to its request, then to its HOST NODE's capacity when neither is set
// (an unconstrained pod still reads as a fraction of what its node can give, rather than a fake-full bar).
import type { KNode, Resources, ResourceUsage } from './types'
import type { CapResource } from './capacityLayout'

const RES: CapResource[] = ['cpu', 'memory']
const LABEL: Record<CapResource, string> = { cpu: 'CPU', memory: 'Mem' }

const pick = (r: Resources | ResourceUsage | undefined, res: CapResource): number | undefined =>
  !r ? undefined : res === 'cpu' ? r.cpuMilli : r.memBytes

export interface ResBarModel {
  kind: 'use' | 'req'
  value: number // the bar's quantity in canonical units (usage, or request / Σ request)
  pct: number // value / track, clamped to [0, 100]
  ceil?: number // this bar's OWN ceiling for the label (Use: limit/capacity; Req: request/allocatable)
  ceilLabel: string | null // the word after the ceiling value ("lim" / "req" / "cap" / "alloc" / "node")
  over: boolean // value past a HARD ceiling — recolour red (usage > limit/capacity; Σreq > allocatable)
  near: boolean // within 90% of a hard ceiling — amber
}

export interface ResGroupModel {
  res: CapResource
  label: string // "CPU" / "Mem"
  track: number // shared denominator for both bars (the resource's ceiling)
  unitRef: number // the value formatPair keys its unit off, so both bars read in one unit (cores/Gi)
  bars: ResBarModel[] // Use first, then Req — each present only when its value is known
  allocPct?: number // a Node's allocatable line on the track (Σreq past it = overcommit); absent for pods
  unconstrained?: boolean // no real ceiling exists (no limit/request/host-capacity) — show a dashed empty track
}

// Inputs already resolved by the caller, so this stays a pure transform. A Node passes capacity +
// allocatable + the summed pod requests; a Pod/workload passes its (own or summed) request + limit and
// its host node's capacity for the unconstrained fallback. `usage` is the live read for either.
export interface ResBarInputs {
  isNode: boolean
  usage?: ResourceUsage
  // Node:
  capacity?: Resources // total physical capacity (Use track + ceiling)
  allocatable?: Resources // schedulable (Req ceiling + overcommit line)
  reqSum?: Resources // Σ pod requests scheduled on the node (Req fill)
  // Pod / workload:
  request?: Resources // own or summed request (Req fill, soft ceiling)
  limit?: Resources // own or summed limit (Use hard ceiling)
  hostCapacity?: Resources // host node capacity, the unconstrained-pod track fallback
}

function bar(kind: 'use' | 'req', value: number, track: number, ceil: number | undefined, ceilLabel: string | null, hardCeil: number | undefined): ResBarModel {
  const pct = Math.min(100, Math.max(0, (value / track) * 100))
  const over = hardCeil != null && value > hardCeil
  const near = hardCeil != null && value >= 0.9 * hardCeil && value <= hardCeil
  return { kind, value, pct, ceil, ceilLabel, over, near }
}

export function drawerResourceBars(input: ResBarInputs): ResGroupModel[] {
  const groups: ResGroupModel[] = []
  for (const res of RES) {
    const use = pick(input.usage, res)
    if (input.isNode) {
      const cap = pick(input.capacity, res) ?? pick(input.allocatable, res)
      const alloc = pick(input.allocatable, res)
      const reqSum = pick(input.reqSum, res)
      const track = cap ?? Math.max(use ?? 0, reqSum ?? 0, 1)
      const bars: ResBarModel[] = []
      // Use gauges against total capacity (a hard ceiling — usage spilling past it is real pressure).
      if (use != null) bars.push(bar('use', use, track, cap, cap != null ? 'cap' : null, cap))
      // Req = Σ pod requests, gauged against allocatable; past it is overcommit (hard, recolours red).
      if (reqSum != null) bars.push(bar('req', reqSum, track, alloc, alloc != null ? 'alloc' : null, alloc))
      if (bars.length === 0) continue
      // The allocatable line is only a distinct marker when it sits short of the capacity track.
      const allocPct = alloc != null && cap != null && alloc < cap ? (alloc / track) * 100 : undefined
      groups.push({ res, label: LABEL[res], track, unitRef: cap ?? track, bars, allocPct })
      continue
    }
    // Pod / workload: both bars share the resource's ceiling — limit, else request, else the host node's
    // capacity (so an unconstrained pod still reads against what its node can give, per the fallback rule).
    const lim = pick(input.limit, res)
    const req = pick(input.request, res)
    const hostCap = pick(input.hostCapacity, res)
    const ceil = lim ?? req ?? hostCap
    const ceilLabel = lim != null ? 'lim' : req != null ? 'req' : hostCap != null ? 'node' : null
    const track = ceil ?? Math.max(use ?? 0, 1)
    const bars: ResBarModel[] = []
    if (use != null) {
      // Usage recolours only against a HARD ceiling (the limit). Bursting past a soft request is expected.
      const hard = lim != null ? lim : undefined
      bars.push(bar('use', use, track, ceil, ceilLabel, hard))
    }
    if (req != null) bars.push(bar('req', req, track, ceil, ceilLabel, undefined))
    if (bars.length === 0) continue
    groups.push({ res, label: LABEL[res], track, unitRef: ceil ?? track, bars, unconstrained: ceil == null })
  }
  return groups
}

// nodeRequestSum totals the requests of every pod scheduled on a node (matched by host name), across
// the cluster-wide capacity feed — the Node's "Req" fill, the same Σrequest the Nodes capacity view
// draws. Cluster-wide because a node hosts pods from every namespace, so its true reservation can only
// be read from all of them. Returns undefined when no scheduled pod sets a request for either resource.
export function nodeRequestSum(nodeName: string, capacityNodes: KNode[]): Resources | undefined {
  let cpu: number | undefined
  let mem: number | undefined
  for (const n of capacityNodes) {
    if (n.kind !== 'Pod' || n.host !== nodeName) continue
    const c = n.requests?.cpuMilli
    const m = n.requests?.memBytes
    if (c != null) cpu = (cpu ?? 0) + c
    if (m != null) mem = (mem ?? 0) + m
  }
  if (cpu == null && mem == null) return undefined
  return { cpuMilli: cpu, memBytes: mem }
}

// hostNodeCapacity finds a pod's host node in the cluster-wide capacity feed and returns its physical
// capacity (falling back to allocatable) — the track an unconstrained pod's bars gauge against.
export function hostNodeCapacity(hostName: string | undefined, capacityNodes: KNode[]): Resources | undefined {
  if (!hostName) return undefined
  const node = capacityNodes.find((n) => n.kind === 'Node' && n.name === hostName)
  return node?.capacityRes ?? node?.allocatable
}
