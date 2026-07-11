// The drawer's CPU/memory resource bars. Per resource, one bar per bound — a Pod shows a "Lim" bar
// (bound = limit) and a "Req" bar (bound = request); a Node shows "Cap" (capacity) and "Alloc"
// (allocatable). Every bar in a group is drawn on ONE shared linear scale (the SAME px-per-unit), just
// like the Nodes capacity view: the fill is LIVE USAGE (identical length on both bars), and each bar's
// TRACK LENGTH encodes its bound — the bar ENDS at its ceiling (a 256Mi limit bar is visibly shorter
// than a 281Mi request bar), rather than a tick on a fixed-width track. When usage runs past a bound the
// fill EXTENDS the track past that ceiling and the overshoot is hatched (the "over its request/limit"
// signal) — exactly the Nodes-view bullet idiom, where the bar grows past its reference on a burst.
import type { KNode, Resources, ResourceUsage } from './types'
import { resourceOf, type CapResource } from './resource'

const RES: CapResource[] = ['cpu', 'memory']
const LABEL: Record<CapResource, string> = { cpu: 'CPU', memory: 'Mem' }

export interface ResBarModel {
  key: string // 'lim' | 'req' | 'cap' | 'alloc' | 'node'
  label: string // the per-bar sublabel ("Lim" / "Req" / "Cap" / "Alloc" / "Node")
  ceil?: number // the bound this bar marks with a tick; undefined only for the unconstrained placeholder
  usage?: number // live usage (the fill); undefined when metrics are unavailable → an empty bar
  // Geometry on the group's SHARED scale, where the group max (the longest bound, or usage when it
  // bursts past every bound) maps to 1. Both in [0, 1]; equal usage ⇒ equal fillFrac across the group's
  // bars, which is what makes their lengths comparable.
  fillFrac: number // usage / groupMax — the fill width
  boundFrac?: number // ceil / groupMax — the bar's track extent (its ceiling); undefined when unconstrained
  over: boolean // usage exceeds this bar's bound — the fill EXTENDS the track past the ceiling (hatched)
  unconstrained?: boolean // no bound at all (no limit/request/host capacity) — render a dashed empty track
}

export interface ResGroupModel {
  res: CapResource
  label: string // "CPU" / "Mem"
  unitRef: number // the value formatPair keys its unit off, so a group's bars read in one unit (cores/Gi)
  bars: ResBarModel[]
}

export interface ResBarInputs {
  isNode: boolean
  usage?: ResourceUsage
  // Node bounds:
  capacity?: Resources // total physical capacity → the "Cap" bar's bound
  allocatable?: Resources // schedulable → the "Alloc" bar's bound
  // Pod / workload bounds:
  request?: Resources // own or summed request → the "Req" bar's bound
  limit?: Resources // own or summed limit → the "Lim" bar's bound
  hostCapacity?: Resources // host node capacity — the fallback bound for an unconstrained pod
}

interface Bound {
  key: string
  label: string
  val: number
}

// scaleBars places a group's bounds on one shared scale: the group max (longest bound, or usage when it
// bursts past them all) is the 1.0 extent, so every bar's fill (usage) and tick (its bound) are fractions
// of that single ruler. Equal usage therefore draws equal length on every bar — the property the bars
// lacked when each used its own bound as 100%.
function scaleBars(bounds: Bound[], use: number | undefined): ResBarModel[] {
  const groupMax = Math.max(use ?? 0, ...bounds.map((b) => b.val))
  const scale = groupMax > 0 ? 1 / groupMax : 0
  return bounds.map((b) => ({
    key: b.key,
    label: b.label,
    ceil: b.val,
    usage: use,
    fillFrac: use != null ? use * scale : 0,
    boundFrac: b.val * scale,
    over: use != null && use > b.val,
  }))
}

export function drawerResourceBars(input: ResBarInputs): ResGroupModel[] {
  const groups: ResGroupModel[] = []
  for (const res of RES) {
    const use = resourceOf(input.usage, res)
    let bounds: Bound[]
    if (input.isNode) {
      // A node has no limit/request — its bounds are the physical capacity and the schedulable
      // allocatable. Usage past allocatable (into kubelet/system-reserved) runs past the Alloc tick.
      const cap = resourceOf(input.capacity, res)
      const alloc = resourceOf(input.allocatable, res)
      bounds = [
        cap != null && cap > 0 ? { key: 'cap', label: 'Cap', val: cap } : null,
        alloc != null && alloc > 0 ? { key: 'alloc', label: 'Alloc', val: alloc } : null,
      ].filter((b): b is Bound => b !== null)
    } else {
      // Lim first (the larger bound → the longer track), Req below — mirroring the capacity view's
      // larger-bound-on-top stack. An unconstrained pod falls back to its node's capacity.
      const lim = resourceOf(input.limit, res)
      const req = resourceOf(input.request, res)
      const hostCap = resourceOf(input.hostCapacity, res)
      bounds = [
        lim != null && lim > 0 ? { key: 'lim', label: 'Lim', val: lim } : null,
        req != null && req > 0 ? { key: 'req', label: 'Req', val: req } : null,
      ].filter((b): b is Bound => b !== null)
      if (bounds.length === 0 && hostCap != null && hostCap > 0) bounds = [{ key: 'node', label: 'Node', val: hostCap }]
    }
    if (bounds.length > 0) {
      const unitRef = Math.max(...bounds.map((b) => b.val))
      groups.push({ res, label: LABEL[res], unitRef, bars: scaleBars(bounds, use) })
      continue
    }
    // No bound to gauge against. If there's still a usage reading, show it on a dashed "ungauged" track
    // (so it can't be misread as maxed); with neither bound nor usage, the resource is omitted entirely.
    if (use != null) {
      groups.push({
        res,
        label: LABEL[res],
        unitRef: use || 1,
        bars: [{ key: 'none', label: 'Use', usage: use, fillFrac: 0, over: false, unconstrained: true }],
      })
    }
  }
  return groups
}

// hostNodeCapacity finds a pod's host node in the cluster-wide capacity feed and returns its physical
// capacity (falling back to allocatable) — the bound an unconstrained pod's bar gauges usage against.
export function hostNodeCapacity(hostName: string | undefined, capacityNodes: KNode[]): Resources | undefined {
  if (!hostName) return undefined
  const node = capacityNodes.find((n) => n.kind === 'Node' && n.name === hostName)
  return node?.capacityRes ?? node?.allocatable
}
