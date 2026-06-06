// The drawer's CPU/memory resource bars. Each bar gauges LIVE USAGE (metrics-server) against ONE bound,
// and the bound IS the bar's full length (its ceiling) — a Pod shows a "Lim" bar (ceiling = limit) and a
// "Req" bar (ceiling = request); a Node shows "Cap" (capacity) and "Alloc" (allocatable). When usage
// overshoots a bar's ceiling the fill WRAPS into a new "lap" drawn in an escalating colour (blue → yellow
// → orange → red), so "using 1.4× my request" or "spilling past allocatable" reads at a glance — the
// failure modes a flat clamped bar hides. The fill is always usage; the two bars differ only in which
// bound they measure it against (so the Req bar, with the smaller ceiling, wraps first).
import type { KNode, Resources, ResourceUsage } from './types'
import type { CapResource } from './capacityLayout'

const RES: CapResource[] = ['cpu', 'memory']
const LABEL: Record<CapResource, string> = { cpu: 'CPU', memory: 'Mem' }

// Lap colours: lap 0 (0–100% of the ceiling) is the neutral accent; each further lap escalates
// yellow → orange → red, clamped at red for anything ≥3× over. Indexes a CSS `.lap-N` class.
export const MAX_LAP = 3

const pick = (r: Resources | ResourceUsage | undefined, res: CapResource): number | undefined =>
  !r ? undefined : res === 'cpu' ? r.cpuMilli : r.memBytes

export interface ResBarModel {
  key: string // 'lim' | 'req' | 'cap' | 'alloc' | 'node'
  label: string // the per-bar sublabel ("Lim" / "Req" / "Cap" / "Alloc" / "Node")
  ceil?: number // the bound = the bar's full length; undefined only for the unconstrained placeholder
  usage?: number // live usage (the fill); undefined when metrics are unavailable → an empty bar
  laps: number // completed full laps = floor(usage/ceil); the base layer's colour is lap (laps-1)
  frac: number // the current lap's progress in [0, 1) — the foreground fill width
  over: boolean // usage exceeds the ceiling (ratio > 1) — at least one wrap
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
  capacity?: Resources // total physical capacity → the "Cap" bar's ceiling
  allocatable?: Resources // schedulable → the "Alloc" bar's ceiling
  // Pod / workload bounds:
  request?: Resources // own or summed request → the "Req" bar's ceiling
  limit?: Resources // own or summed limit → the "Lim" bar's ceiling
  hostCapacity?: Resources // host node capacity — the fallback ceiling for an unconstrained pod
}

// makeBar gauges usage against one ceiling, computing the lap (how many times the usage has wrapped the
// ceiling) and the current lap's partial fill. Returns null when the ceiling isn't a positive number.
function makeBar(key: string, label: string, ceil: number | undefined, usage: number | undefined): ResBarModel | null {
  if (ceil == null || ceil <= 0) return null
  const ratio = usage != null ? usage / ceil : 0
  const laps = Math.floor(ratio)
  return { key, label, ceil, usage, laps, frac: ratio - laps, over: ratio > 1 }
}

export function drawerResourceBars(input: ResBarInputs): ResGroupModel[] {
  const groups: ResGroupModel[] = []
  for (const res of RES) {
    const use = pick(input.usage, res)
    let bars: ResBarModel[]
    let unitRef: number | undefined
    if (input.isNode) {
      // A node has no limit/request — its bounds are the physical capacity and the schedulable
      // allocatable. Usage past allocatable (into kubelet/system-reserved) wraps the Alloc bar first.
      const cap = pick(input.capacity, res)
      const alloc = pick(input.allocatable, res)
      bars = [makeBar('cap', 'Cap', cap, use), makeBar('alloc', 'Alloc', alloc, use)].filter((b): b is ResBarModel => b !== null)
      unitRef = cap ?? alloc
    } else {
      // Lim first (the larger ceiling), Req below — mirroring the capacity view's larger-bound-on-top
      // stack. Each present bound becomes a bar; an unconstrained pod falls back to its node's capacity.
      const lim = pick(input.limit, res)
      const req = pick(input.request, res)
      const hostCap = pick(input.hostCapacity, res)
      bars = [makeBar('lim', 'Lim', lim, use), makeBar('req', 'Req', req, use)].filter((b): b is ResBarModel => b !== null)
      if (bars.length === 0) {
        const fb = makeBar('node', 'Node', hostCap, use)
        if (fb) bars = [fb]
      }
      unitRef = lim ?? req ?? hostCap
    }
    if (bars.length > 0) {
      groups.push({ res, label: LABEL[res], unitRef: unitRef ?? bars[0].ceil ?? 1, bars })
      continue
    }
    // No bound to gauge against. If there's still a usage reading, show it on a dashed "ungauged" track
    // (so it can't be misread as maxed); with neither bound nor usage, the resource is omitted entirely.
    if (use != null) {
      groups.push({ res, label: LABEL[res], unitRef: use || 1, bars: [{ key: 'none', label: 'Use', usage: use, laps: 0, frac: 0, over: false, unconstrained: true }] })
    }
  }
  return groups
}

// hostNodeCapacity finds a pod's host node in the cluster-wide capacity feed and returns its physical
// capacity (falling back to allocatable) — the ceiling an unconstrained pod's bar gauges usage against.
export function hostNodeCapacity(hostName: string | undefined, capacityNodes: KNode[]): Resources | undefined {
  if (!hostName) return undefined
  const node = capacityNodes.find((n) => n.kind === 'Node' && n.name === hostName)
  return node?.capacityRes ?? node?.allocatable
}
