// Pure builders for the capacity (Nodes) view's hover-tooltip payload. Extracted from Topology.tsx so
// the normalization logic — which fields a segment / fold / overhead slice contributes — is testable in
// isolation and the view component stays focused on rendering + reactivity. The renderer passes the
// active resource (cpu|memory) so these stay free of Solid signals.
import { formatQuantity, type CapAggregate, type CapRow, type CapSeg } from './capacityLayout'
import type { CapResource } from './resource'

// CapTipData is the normalized hover-tooltip payload for the capacity bars — built from either a single
// pod segment, a folded aggregate, or the node-usage backdrop, so the tooltip renders one shape.
// `hint` is a dim trailing action line ("Click to expand…") the VIEW composes — it depends on row
// expansion state these pure builders deliberately don't know about.
export type CapTipData = { title: string; sub?: string; value: string; hint?: string }

// A single pod segment → its name + the one amount it contributes on the bar being hovered (its usage on
// the Use bar, its request on the Req bar). The bars already print "use / cap" and "req / cap" at their
// right end, so the tooltip carries ONLY that single number, not the full use/req/limit triple.
// The Use bar's risk overlays (near-limit notch, burst hatch) are explained in words here — a bare
// marker/hatch makes the operator infer its meaning (explicit over implicit), and near-limit names the
// per-resource consequence (CPU throttles, memory OOM-kills). Near-limit outranks bursting: it's the
// urgent one, and a segment can be both.
export const tipFromSeg = (s: CapSeg, metric: 'use' | 'req', resource: CapResource): CapTipData => ({
  title: s.node.name,
  sub:
    metric === 'use' && s.nearLimit
      ? resource === 'cpu'
        ? 'near its CPU limit — throttling'
        : 'near its memory limit — OOM risk'
      : metric === 'use' && s.over
        ? 'using more than it requested'
        : undefined,
  value: formatQuantity(metric === 'use' ? s.use : s.req ?? 0, resource),
})

// A folded block → "N small pods" (own pods too tiny to draw) or "Other namespaces" (pods outside the
// selected namespace), with its summed amount on the hovered bar.
export const tipFromAgg = (a: CapAggregate, metric: 'use' | 'req', resource: CapResource): CapTipData => ({
  title: a.variant === 'small' ? `${a.count} small pod${a.count === 1 ? '' : 's'}` : 'Other namespaces',
  sub: a.variant === 'other' ? `${a.count} pod${a.count === 1 ? '' : 's'} outside this namespace` : undefined,
  value: formatQuantity(metric === 'use' ? a.use : a.req, resource),
})

// The faint Use-bar backdrop is the node's TOTAL usage (NodeMetrics). Overhead subtracts ALL pods on the
// node (useTotal = own + other namespaces), so what's left is purely NON-POD usage — kubelet, the
// container runtime, system daemons — NOT other namespaces' pods (those are counted out, and have their
// own folded "other namespaces" segment).
export const tipFromNodeUse = (row: CapRow, resource: CapResource): CapTipData => ({
  title: 'Overhead',
  sub: 'non-pod / system (kubelet, runtime)',
  value: formatQuantity(Math.max(0, (row.nodeUse ?? 0) - row.useTotal), resource),
})
