// Pure helpers for drawing graph edges as SVG: the orthogonal path geometry (with rounded elbows),
// the dashed-style flag per edge type, and the human-readable hover tooltip. Extracted from
// Topology.tsx so the non-trivial elbow-rounding math and the edge-label taxonomy are unit-testable
// in isolation and the component stays focused on reactivity + rendering.
import { COLLAPSE_KIND, type Point } from './layout'
import type { EdgeType, KEdge, KNode } from './types'

// Elbow rounding radius for orthogonal edges — soft ArgoCD-style corners.
const EDGE_CORNER = 7

// lerpTo returns the point `d` units from `from` toward `to` (clamped to the segment, 0 if coincident).
function lerpTo(from: Point, to: Point, d: number): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y)
  if (len === 0) return { x: from.x, y: from.y }
  const t = Math.min(1, d / len)
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
}

// edgePath renders an orthogonal point list as an SVG path with rounded elbows: each interior vertex
// becomes a short quadratic-bezier corner, its radius clamped to half the shorter adjacent segment so
// stubby segments don't overshoot. A 2-point (straight) edge falls through to a plain line — and the
// final segment stays axis-aligned, so marker-end keeps pointing squarely into the target's edge.
export function edgePath(points: Point[]): string {
  if (points.length < 3) return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ')
  let d = `M ${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], cur = points[i], next = points[i + 1]
    const r = Math.min(EDGE_CORNER, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2, Math.hypot(next.x - cur.x, next.y - cur.y) / 2)
    const a = lerpTo(cur, prev, r)
    const b = lerpTo(cur, next, r)
    d += ` L ${a.x},${a.y} Q ${cur.x},${cur.y} ${b.x},${b.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x},${last.y}`
  return d
}

// DASHED marks the non-ownership edge types: the dashed stroke says "this isn't a parent→child owns
// relationship"; the tooltip (edgeTitle) says which kind of non-ownership it is.
export const DASHED: Partial<Record<EdgeType, boolean>> = {
  selects: true,
  routes: true,
  mounts: true,
  usesServiceAccount: true,
  binds: true,
  scheduledOn: true,
  refers: true,
  guards: true,
}

// Human-readable label for an edge type, so operators don't need to know the graph package's edge
// taxonomy by heart.
export const EDGE_LABELS: Record<EdgeType, string> = {
  ownerReference: 'owns',
  scheduledOn: 'runs on',
  selects: 'selects',
  routes: 'routes to',
  mounts: 'mounts',
  usesServiceAccount: 'runs as',
  binds: 'binds',
  refers: 'refers to',
  guards: 'guards',
}

// The human verbs for every non-ownership (dashed) edge type, derived from DASHED so the help
// overlay's edge legend can list them without hand-maintaining a parallel copy that drifts (it had
// silently dropped "runs as"/usesServiceAccount). Insertion order of DASHED gives a stable reading
// order. Ownership is the solid backbone and is shown on its own legend row, so it's excluded here.
export const nonOwnershipEdgeLabels = (): string[] =>
  (Object.keys(DASHED) as EdgeType[]).map((t) => EDGE_LABELS[t])

function nodeLabel(n: KNode): string {
  const ns = n.namespace ? `${n.namespace}/` : ''
  return `${n.kind} ${ns}${n.name}`
}

// edgeTitle builds the SVG <title> hover text for an edge: "<from> <verb> <to>".
export function edgeTitle(e: KEdge, nodes: KNode[]): string {
  const fromN = nodes.find((n) => n.id === e.from)
  const toN = nodes.find((n) => n.id === e.to)
  const fromS = fromN ? nodeLabel(fromN) : e.from
  // A bundled hub→pill edge points at a synthetic "+N older" pill (not in nodes); read it as the
  // aggregate it is rather than leaking the sentinel id into the tooltip.
  const toS = e.to.startsWith(`${COLLAPSE_KIND}:`) ? 'folded resources' : toN ? nodeLabel(toN) : e.to
  return `${fromS} ${EDGE_LABELS[e.type]} ${toS}`
}
