import { createMemo, createSignal, For, Show, createEffect, on, onCleanup, onMount } from 'solid-js'
import { COLLAPSE_KIND, connGroups, formatQuantity, kindGroups, layoutGraph, layoutGraphByCapacity, layoutGraphByKind, type CapAggregate, type CapResource, type CapRow, type CapSeg, type CapacityLayout, type CollapseMeta, type Point } from '../layout'
import { edgeKey } from '../graphState'
import { HEALTH_ORDER, healthColor, healthSeverity } from '../health'
import { orderedForNav } from '../nav'
import { cardKindLabel, cardName, cardStatus, kindShortLabel } from '../names'
import { nodeMatches } from '../search'
import { kindIcon } from '../icons'
import { relativeAge } from '../time'
import { projectEdges, REL_CATEGORIES, relCategoriesPresent } from '../relationships'
import type { Capacity, EdgeType, GroupBy, Health, KEdge, KNode, RelCategory } from '../types'

const EMPTY_RELS: ReadonlySet<RelCategory> = new Set()

// The group-by options, exported so App's keyboard shortcuts (1–3) and help overlay stay in sync
// with the segmented control rendered in the toolbar. Order = number-key order.
export const GROUP_OPTIONS: { id: GroupBy; label: string; hint: string }[] = [
  { id: 'relationship', label: 'Relationship', hint: 'Lay resources out along the relationships you enable' },
  { id: 'nodes', label: 'Nodes', hint: 'Group pods into the node they run on' },
  { id: 'kind', label: 'Kind', hint: 'Group every resource into per-kind boxes' },
]

interface Props {
  nodes: KNode[]
  edges: KEdge[]
  selectedId: string | null
  healthFilter?: import('../types').Health | null
  // Multi-select set of kinds to spotlight (cycle 203). Empty / null means "show all"; a
  // non-empty set fades every node whose kind isn't in it. The parent owns the set so it
  // survives namespace/view transitions when desired (currently cleared on view change).
  kindFilter?: Set<string> | null
  // Toggle (or "solo" with Shift) a kind in the filter. `solo` clears the existing set and sets
  // the filter to exactly this kind — paired with the chip's onClick passing e.shiftKey.
  onKindFilter?: (k: string, solo?: boolean) => void
  // Spotlight a health state, or clear it (null). Drives the health-filter pills that now live in
  // this toolbar — moved out of the global topbar so every "filter the resources in front of me"
  // control sits in one block beside the search and kind chips.
  onHealthFilter?: (h: Health | null) => void
  connected: boolean
  // groupBy selects the layout strategy: 'kind' → per-kind boxes, 'nodes' → host containers,
  // 'relationship' (default) → relationship depth-column tree. Replaces the old viewId. The
  // segmented control that sets it lives in this toolbar (onGroupBy); App owns the signal.
  groupBy?: import('../types').GroupBy
  onGroupBy?: (g: import('../types').GroupBy) => void
  // relFilter is the set of relationship categories whose edges are drawn (and which therefore
  // drive connectivity). The toolbar's relationship chips toggle it via onRelFilter.
  relFilter?: ReadonlySet<RelCategory>
  onRelFilter?: (c: RelCategory, solo?: boolean) => void
  // onClearFilters clears every active filter at once (search + health + kinds). Optional —
  // when omitted, the chip row's individual clears stay the only way to reset.
  onClearFilters?: () => void
  // scope identifies the current cluster+namespace, so the auto-fit re-frames only on a real
  // context/namespace switch — not when an SSE patch or a collapse expand/refold changes the node
  // set within the same scope (which must preserve the operator's current pan/zoom).
  scope?: string
  // capacity is the cluster-wide Node+Pod feed (with live usage) the Nodes group-by draws — every
  // namespace's pods on each node, so the view is the same in cluster and namespace scope and the
  // client just dims pods outside `namespace`. Null before the first `capacity` event.
  capacity?: Capacity | null
  // namespace is the selected namespace (or the cluster sentinel). The capacity view renders this
  // namespace's pods bright and dims the rest; the cluster sentinel treats every pod as own.
  namespace?: string
  search: string
  onSearch: (q: string) => void
  // Lets the app focus the topology search from a global key (Cmd/Ctrl+K) — like Sidebar's
  // filterRef but for the resource search instead of the namespace filter.
  searchRef?: (el: HTMLInputElement) => void
  onSelect: (id: string) => void
  // Background click dismisses the open drawer (cycle 161). Optional — parent decides whether
  // the click-out behavior is wired (Topology tests pass no-op handlers).
  onDeselect?: () => void
}

// Edges other than ownership are drawn dashed so the parent-child backbone stays visually
// dominant (the primary relationship operators scan for first). EdgeRefers (CR-defined
// references) is rendered identically to the other non-ownership edges — same grey, same dash,
// same arrowhead — because "refers to" is semantically just another non-ownership relationship;
// only the hover tooltip names the specific kind. (Colour/shape distinction was dropped: it
// cluttered a dense canvas and the categories read the same to operators.)
const DASHED: Partial<Record<EdgeType, boolean>> = {
  selects: true,
  routes: true,
  mounts: true,
  usesServiceAccount: true,
  binds: true,
  scheduledOn: true,
  refers: true,
}

const EDGE_CORNER = 7 // elbow rounding radius for orthogonal edges — soft ArgoCD-style corners

// Floor for the auto-fit scale. Below this, cards shrink past legibility (names fade out at the
// 0.45 labels-hidden threshold), so a resource-dense view that can't fit at this scale opens
// zoomed to the floor on its first resources instead of fitting everything into an unreadable speck.
const MIN_FIT_SCALE = 0.55

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
function edgePath(points: Point[]): string {
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

// cardTitle builds the SVG <title> tooltip for a node — the small thing native browsers show on
// hover after ~700ms. It mirrors the card's visible facts (kind, full name, status) plus the
// detail the card runs out of room for at small zoom (age, host, restarts), so an operator can
// inspect a node without selecting it.
function cardTitle(n: KNode, now: Date): string {
  const lines = [`${n.kind} ${n.name}`]
  if (n.status) lines.push(n.status)
  const meta: string[] = []
  if (n.createdAt) meta.push(`${relativeAge(n.createdAt, now)} old`)
  if (n.host) meta.push(`on ${n.host}`)
  if ((n.restarts ?? 0) > 0) meta.push(`↻ ${n.restarts} restarts`)
  if (meta.length > 0) lines.push(meta.join(' · '))
  return lines.join('\n')
}

// Human-readable label for an edge type. The dashed style says "non-ownership"; the tooltip says
// which kind of non-ownership it is (selects, mounts a volume, routes traffic, …), so operators
// don't need to know the graph package's edge taxonomy by heart.
const EDGE_LABELS: Record<EdgeType, string> = {
  ownerReference: 'owns',
  scheduledOn: 'runs on',
  selects: 'selects',
  routes: 'routes to',
  mounts: 'mounts',
  usesServiceAccount: 'runs as',
  binds: 'binds',
  refers: 'refers to',
}

// CapTipData is the normalized hover-tooltip payload for the capacity bars — built from either a
// single pod segment or the folded "other namespaces" aggregate, so the tooltip renders one shape.
type CapTipData = { title: string; sub: string; use: number; req?: number; lim?: number; over: boolean; near: boolean }

function nodeLabel(n: KNode): string {
  const ns = n.namespace ? `${n.namespace}/` : ''
  return `${n.kind} ${ns}${n.name}`
}

function edgeTitle(e: KEdge, nodes: KNode[]): string {
  const fromN = nodes.find((n) => n.id === e.from)
  const toN = nodes.find((n) => n.id === e.to)
  const fromS = fromN ? nodeLabel(fromN) : e.from
  // A bundled hub→pill edge points at a synthetic "+N older" pill (not in nodes); read it as the
  // aggregate it is rather than leaking the sentinel id into the tooltip.
  const toS = e.to.startsWith(`${COLLAPSE_KIND}:`) ? 'folded resources' : toN ? nodeLabel(toN) : e.to
  return `${fromS} ${EDGE_LABELS[e.type]} ${toS}`
}

export default function Topology(props: Props) {
  // Per-cluster expansion state for the "+N older" collapse (ephemeral: a Set of expanded keys,
  // empty = everything collapsed, resets on reload). Keyed by the layout's stable collapse key
  // ("kind:Pod", "host:<node>", …) so toggling one cluster never disturbs another.
  const [expandedClusters, setExpandedClusters] = createSignal<ReadonlySet<string>>(new Set())
  const toggleCluster = (key: string) =>
    setExpandedClusters((s) => {
      const next = new Set(s)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // Capacity view (Nodes group-by) control, persisted to localStorage so the operator's choice of
  // resource survives reloads (mirrors the kd:* persistence of group-by/relationships). capResource
  // picks which single resource sizes the bars. The bars are always the explicit Req + Use stacked
  // form (the overlay/Use-only mode was retired after live review — the user chose Req+Use).
  const readPref = <T extends string>(key: string, fallback: T, allowed: T[]): T => {
    const v = (typeof localStorage !== 'undefined' && localStorage.getItem(key)) as T | null
    return v && allowed.includes(v) ? v : fallback
  }
  const [capResource, setCapResourceSig] = createSignal<CapResource>(readPref('kd:capRes', 'cpu', ['cpu', 'memory']))
  const setCapResource = (r: CapResource) => {
    setCapResourceSig(r)
    try { localStorage.setItem('kd:capRes', r) } catch { /* private mode */ }
  }
  // Rich hover tooltip for the capacity bars (item: Grafana-style panels). Holds normalized tooltip
  // data + the pointer position; an HTML overlay (not an SVG <title>) follows the cursor so the bar's
  // name/usage/request/limit read instantly instead of after the browser's ~700ms title delay. The
  // bullets/segments no longer print these numbers inline (too cluttered) — the tooltip carries them.
  const [capTip, setCapTip] = createSignal<{ d: CapTipData; x: number; y: number } | null>(null)
  const tipFromSeg = (s: CapSeg): CapTipData => ({
    title: s.node.name,
    sub: `Pod${s.node.namespace ? ` · ${s.node.namespace}` : ''}`,
    use: s.use,
    req: s.req,
    lim: s.lim,
    over: s.over,
    near: s.nearLimit,
  })
  const tipFromAgg = (a: CapAggregate): CapTipData =>
    a.variant === 'small'
      ? {
          title: `${a.count} small pod${a.count === 1 ? '' : 's'}`,
          sub: 'too small to show individually — expand to see each',
          use: a.use,
          req: a.req || undefined,
          over: false,
          near: false,
        }
      : {
          title: 'Other namespaces',
          sub: `${a.count} pod${a.count === 1 ? '' : 's'} outside this namespace`,
          use: a.use,
          req: a.req || undefined,
          over: false,
          near: false,
        }
  const showTip = (d: CapTipData, e: PointerEvent) => setCapTip({ d, x: e.clientX, y: e.clientY })

  // Project the full streamed edge set onto the active relationship categories (reversing the
  // referenced-as-parent ones) — the client-side replacement for the old server per-view Filter.
  // Drives the LAYOUT and the selection-spotlight/fit (related()), so clicking a node only lights
  // and frames what's actually drawn. ownerName() still scans the full props.edges — name
  // shortening is a readability aid independent of which relationships are toggled on.
  const displayEdges = createMemo(() => projectEdges(props.edges, props.relFilter ?? EMPTY_RELS))

  const layout = createMemo(() => {
    const edges = displayEdges()
    // Kind grouping: every resource in a per-kind box; the projected edges still draw on top
    // (suppressed until selection — see renderedEdges) so the cross-kind matrix stays readable.
    if (props.groupBy === 'kind') return layoutGraphByKind(props.nodes, edges, expandedClusters())
    // Nodes grouping: the capacity & usage visualization — node tracks (length ∝ allocatable) with
    // pods as usage-sized segments, reserved-vs-actual bars, expandable to per-pod bullets. Driven by
    // the live metrics-server usage feed (props.usage) + the active resource/mode toggles.
    if (props.groupBy === 'nodes')
      return layoutGraphByCapacity(props.capacity?.nodes ?? [], props.capacity?.usage?.items, capResource(), props.namespace ?? '', expandedClusters())
    // Relationship grouping (default): left-to-right depth columns following the displayed
    // relationship edges. A card is far wider than it is tall, so a parent's children read better
    // stacked in a vertical column to the right (LR). Nodes untouched by any displayed edge fall
    // out as per-kind orphan blocks (layoutGraph folds them), so the canvas stays a complete
    // namespace inventory regardless of which relationships are active.
    return layoutGraph(props.nodes, edges, 'LR', expandedClusters())
  })
  // Kind grouping draws a faint kind-label band above each kind box so the operator can scan
  // "this section is all Pods, that's all Services" without inferring it from card kinds.
  const groups = createMemo(() => (props.groupBy === 'kind' ? kindGroups(layout()) : []))
  // Nodes grouping: the capacity layout's per-node row model (tracks, segments, bullets). Empty for
  // every other group-by. Cast is safe — layout() returns a CapacityLayout exactly when groupBy is
  // 'nodes' (the dispatch above), and CapacityLayout is a Layout superset.
  const capRows = createMemo<CapRow[]>(() => (props.groupBy === 'nodes' ? (layout() as CapacityLayout).rows : []))
  const capInfo = createMemo(() => layout() as CapacityLayout)
  // In the Nodes (capacity) view, "frame the selection" means frame the whole node ROW the selected
  // pod (or node) lives in — not its related() subtree, whose edges come from the namespace graph,
  // not this cluster-wide feed. Returns the row's box in center convention, or null when the id
  // isn't on any row. (item: selecting a pod fits to the node it runs on.)
  const capRowBoxFor = (id: string | null) => {
    if (props.groupBy !== 'nodes' || !id) return null
    const row = capRows().find((r) => r.node?.id === id || r.allPodIds.includes(id))
    if (!row) return null
    return { x: row.x + row.width / 2, y: row.y + row.height / 2, width: row.width, height: row.height }
  }
  // Relationship grouping has no kind/host container, so a fold's siblings + pill get a dedicated
  // grouping frame. Kind/Nodes already box by kind/host — a second frame there would double-border,
  // so connGroups is empty for those.
  const connFrames = createMemo(() =>
    props.groupBy !== 'kind' && props.groupBy !== 'nodes' ? connGroups(layout()) : [],
  )
  // Hint shown under the empty-state message, describing the current lens (grouping +
  // relationships) so an empty canvas still tells the operator what they're looking through.
  const emptyHint = () => {
    if (props.groupBy === 'nodes') return 'Pods grouped by the node they run on'
    if (props.groupBy === 'kind') return 'Every resource grouped by kind'
    const rels = [...(props.relFilter ?? EMPTY_RELS)]
    if (rels.length === 0) return 'No relationships selected — toggle one in the toolbar above'
    const labels = REL_CATEGORIES.filter((c) => rels.includes(c.id)).map((c) => c.label)
    return `Showing ${labels.join(', ')} relationships`
  }
  // Relationship toggle chips: one per category actually present in the graph (mirroring how the
  // kind chips derive from kinds present), each badged with how many of its edges exist.
  const relChips = createMemo(() => {
    const present = relCategoriesPresent(props.edges)
    return REL_CATEGORIES.filter((c) => present.has(c.id)).map((c) => {
      const types = new Set(c.edges)
      return { ...c, count: props.edges.filter((e) => types.has(e.type)).length }
    })
  })
  // Exit animation (cycle 160): when a node drops out of props.nodes, keep its last-known position
  // rendered with a fading-out class for 320ms so the operator sees it leave rather than vanish.
  // We snapshot the prior layout each time createEffect runs and diff against the new one.
  const [exiting, setExiting] = createSignal<import('../layout').PositionedNode[]>([])
  let prevPositioned: import('../layout').PositionedNode[] = []
  const exitTimers = new Map<string, number>()
  createEffect(() => {
    const cur = layout().nodes
    const curIds = new Set(cur.map((n) => n.id))
    // Collapse pills are synthetic — never play an exit animation when one folds away on expand.
    const removed = prevPositioned.filter((n) => !curIds.has(n.id) && !exitTimers.has(n.id) && !n.collapse)
    if (removed.length > 0) {
      setExiting((prev) => [...prev, ...removed])
      for (const n of removed) {
        const t = window.setTimeout(() => {
          setExiting((prev) => prev.filter((p) => p.id !== n.id))
          exitTimers.delete(n.id)
        }, 320)
        exitTimers.set(n.id, t)
      }
    }
    prevPositioned = cur
  })
  onCleanup(() => {
    for (const t of exitTimers.values()) clearTimeout(t)
  })
  const exitingIds = createMemo(() => new Set(exiting().map((n) => n.id)))

  // Map each node to the longest PREFIX-PARENT name, so a child renders relative to its parent in the
  // tree. We scan every edge (not just ownerReference) and keep the longest source name that is a
  // '-'-bounded prefix of the child's name — so generated children of ANY kind shorten the same way:
  // Pods under a ReplicaSet, but also CRD instances under their owner/parent (e.g. Workflows named
  // "<template>-<id>" under their WorkflowTemplate via a refers edge). The prefix test is the guard: an
  // edge whose source name is not an actual ancestor prefix (a Service that selects a Pod) never strips,
  // and the longest match wins so the closest ancestor (ReplicaSet over Deployment) is used.
  const ownerName = createMemo(() => {
    const nameById = new Map(props.nodes.map((n) => [n.id, n.name]))
    const m = new Map<string, string>()
    for (const e of props.edges) {
      const parent = nameById.get(e.from)
      const child = nameById.get(e.to)
      if (parent === undefined || child === undefined) continue
      if (child.length <= parent.length + 1 || !child.startsWith(parent + '-')) continue
      const cur = m.get(e.to)
      if (cur === undefined || parent.length > cur.length) m.set(e.to, parent)
    }
    return m
  })

  // Re-evaluate age on a slow ticker so cards age in place without a reload. 30s matches the
  // resolution of the smallest unit relativeAge can shift across ("5s"→"6s") cheaply enough.
  const [now, setNow] = createSignal(new Date())
  const tick = setInterval(() => setNow(new Date()), 30_000)
  onCleanup(() => clearInterval(tick))
  const ageOf = (n: KNode) => (n.createdAt ? relativeAge(n.createdAt, now()) : '')
  // Right-side badge on the name line: combine restart count (when present) and age (when known).
  // Operators read either as a "needs a look" signal — a high restart count or a freshly-restarted
  // pod 30s old is just as interesting as a 90-day-old workload.
  const rightBadge = (n: KNode) => {
    const r = n.restarts ?? 0
    const age = ageOf(n)
    if (r > 0 && age) return `↻${r} · ${age}`
    if (r > 0) return `↻${r}`
    return age
  }
  const label = (n: KNode) => cardName(n.name, ownerName().get(n.id))

  // When a node is selected, walk its connected component (edges treated as undirected) so the
  // entire relationship tree containing the selection stays lit while everything else fades out —
  // ArgoCD-style focus on "this resource and what relates to it". Cycle 157 promoted this from
  // immediate-neighbors to full-component because the auto-fit (below) targets the same set:
  // clicking a Pod should frame Deployment+ReplicaSet+Pod, not just the parent edge.
  const related = createMemo(() => {
    const id = props.selectedId
    if (!id) return null
    const nodes = new Set<string>([id])
    const edges = new Set<string>()
    const queue = [id]
    // Walk only the DISPLAYED relationships (displayEdges, the relFilter projection) — NOT the full
    // edge set. Following relationships the operator hasn't enabled lit (and framed) nodes they
    // can't even see — e.g. a Pod dragging in its Node via scheduledOn when Scheduling is off, so
    // the selection-fit zoomed way out to include it. The spotlight now matches what's on screen.
    const relEdges = displayEdges()
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const e of relEdges) {
        const k = `${e.from}|${e.to}|${e.type}`
        if (edges.has(k)) continue
        if (e.from === cur || e.to === cur) {
          edges.add(k)
          const next = e.from === cur ? e.to : e.from
          if (!nodes.has(next)) {
            nodes.add(next)
            queue.push(next)
          }
        }
      }
    }
    return { nodes, edges }
  })

  // Search dims everything that doesn't match the query (by name, kind, label, or image), so a
  // resource is findable in a dense namespace without losing its place in the tree. Null when the
  // box is empty. The query is owned by the parent so it resets on namespace/view change.
  const query = () => props.search
  const setQuery = (q: string) => props.onSearch(q)
  const matches = createMemo(() => {
    const q = query().trim()
    if (!q) return null
    // Intersect with the active kind filter so the "X of N" count and Enter-cycle (which both read
    // matches()) only ever count cards that are actually LIT — not ones faded out by the kind chips
    // (cycle 314). Read props.kindFilter directly rather than the activeKinds() memo: this memo is
    // created eagerly above that one, so referencing it would hit the TDZ.
    const kf = props.kindFilter
    const kindOk = (kind: string) => !kf || kf.size === 0 || kf.has(kind)
    const m = new Set<string>()
    for (const n of layout().nodes) {
      if (n.collapse) continue // synthetic pill, not a searchable resource
      if (kindOk(n.kind) && nodeMatches(n, q)) m.add(n.id)
    }
    return m
  })
  // Ordered list of matches in the same severity-first order used for Enter cycling (cycle 284).
  // Memoized so the "X of N" indicator and the Enter handler agree on positions.
  const matchOrdered = createMemo(() => {
    const m = matches()
    if (!m || m.size === 0) return []
    return orderedForNav(props.nodes.filter((n) => m.has(n.id)))
  })
  // 1-based position of the current selection within matchOrdered, or 0 if the selection is not a
  // match. Drives the "3 of 7 matches" indicator that complements Enter-cycling (cycle 285).
  const matchPos = createMemo(() => {
    const ordered = matchOrdered()
    if (ordered.length === 0) return 0
    const idx = ordered.findIndex((n) => n.id === props.selectedId)
    return idx < 0 ? 0 : idx + 1
  })

  // Active kind filter (cycle 203): an empty/null set means "show all kinds"; otherwise only the
  // listed kinds stay lit. Re-derived so an empty set still reads as "no filter active".
  const activeKinds = createMemo(() => {
    const s = props.kindFilter
    return s && s.size > 0 ? s : null
  })
  // Counts + worst-health per kind in the current view. Chips order by count (most-common first,
  // typically Pod) — predictable so the row doesn't reshuffle when a single resource flips state.
  // The per-kind worst health (cycle 289) drives a small severity dot on the chip so the operator
  // spots WHICH kinds carry trouble without scanning the canvas; preserves the stable order while
  // still surfacing the answer to "where do I look first".
  const kindStats = createMemo(() => {
    const stats = new Map<string, { count: number; worst: Health | null }>()
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
    for (const n of layout().nodes) {
      // A pill is synthetic. While COLLAPSED, fold the nodes it hides back into the count so the
      // kind chip reflects the true total (visible + collapsed), not just what's drawn. While
      // EXPANDED, those nodes are present as real cards and counted below — folding them back too
      // would double-count — so the expanded pill contributes nothing.
      if (n.collapse) {
        if (!n.collapse.expanded) {
          for (const h of n.collapse.hidden) add(h)
          // A sibling-subtree fold also hides a different kind (a folded Workflow's Pods); count
          // those back too so e.g. the Pod chip stays honest while the Workflow group is collapsed.
          for (const h of n.collapse.hiddenDescendants ?? []) add(h)
        }
        continue
      }
      add(n)
    }
    return stats
  })
  const kindChips = createMemo(() =>
    [...kindStats().entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([k, s]) => ({ kind: k, count: s.count, worst: s.worst })),
  )
  // Health distribution across the view's resources — the data behind the toolbar's health-filter
  // pills and the proportion stripe. Counts props.nodes directly: those are the raw graph nodes
  // (no synthetic collapse pills — pills are layout-only), and a collapsed cluster only hides LIVE
  // resources that are still in props.nodes, so the totals are the true per-health counts.
  const healthStats = createMemo(() => {
    const c = {} as Record<Health, number>
    for (const n of props.nodes) c[n.health] = (c[n.health] ?? 0) + 1
    return c
  })
  // Only surface states actually present (stable HEALTH_ORDER), so the row reads as a quiet "all
  // healthy" when nothing's wrong rather than a line of zeros.
  const shownHealth = createMemo(() => HEALTH_ORDER.filter((h) => healthStats()[h]))
  // Nodes that pass the kind filter — used both for fading and to short-circuit the related/search
  // intersection. Kinds compose with search and healthFilter (intersection: a node must match all).
  const nodeKindOk = (kind: string) => {
    const a = activeKinds()
    return !a || a.has(kind)
  }

  // Fade precedence: search query > legend health filter > kind filter > selection neighbors;
  // only a bare selection lights its edges accent. When a kind filter is active alongside another
  // filter, both must accept the node — so kinds compose rather than overriding. The selected
  // node never fades, even if a filter would exclude it: the operator's focus stays visible
  // instead of ghosting out behind the spotlight (cycle 224).
  const nodeFaded = (n: { id: string; health: string; kind: string }) => {
    if (n.id === props.selectedId) return false
    if (!nodeKindOk(n.kind)) return true
    const m = matches()
    if (m) return !m.has(n.id)
    if (props.healthFilter) return n.health !== props.healthFilter
    const r = related()
    return r ? !r.nodes.has(n.id) : false
  }
  // Capacity-view spotlight: hovering a pod segment/bullet (not just clicking it) spotlights it and
  // fades the rest, like a Grafana panel — faster than click-to-select for reading the bars. capHover
  // holds the hovered element's key: a pod id, or a `small:<host>` / `other:<host>` aggregate marker.
  // When something is hovered it wins; with nothing hovered we fall back to the standard
  // selection/search/filter fade (nodeFaded), so a selected pod stays spotlit after the cursor leaves.
  const [capHover, setCapHover] = createSignal<string | null>(null)
  const capSegFaded = (n: { id: string; health: string; kind: string }) => {
    const h = capHover()
    if (h) return n.id !== h
    return nodeFaded(n)
  }
  // An aggregate block stands for many pods and is never the single spotlighted pod, so it fades
  // whenever a specific element is in focus — a hovered sibling, or a selected/searched/filtered pod.
  // (Fixes the bug where the bright accent block stayed lit while every individual segment faded.)
  const capAggFaded = (marker: string) => {
    const h = capHover()
    if (h) return marker !== h
    return !!props.selectedId || !!matches() || !!props.healthFilter
  }
  // A collapsed pill counts how many of its hidden nodes the operator is currently searching/filtering
  // for, so the badge ("● N match") signals a fold is hiding a result without revealing it (FR-006/D7).
  // Only an EXPLICIT query counts — a live search or the health legend filter. Selection is navigation,
  // not a query: selecting a resource lights its whole related subtree (related()), and a fold inside
  // that subtree would otherwise report every hidden sibling as a "match" even with an empty search box
  // — which reads as a phantom search hit. So the badge stays away unless the operator actually typed a
  // search or picked a health filter.
  const collapseMatchCount = (meta: CollapseMeta): number => {
    const q = query().trim()
    const hit = (n: KNode): boolean => {
      if (q) return nodeKindOk(n.kind) && nodeMatches(n, q)
      if (props.healthFilter) return n.health === props.healthFilter
      return false
    }
    return meta.hidden.reduce((c, n) => c + (hit(n) ? 1 : 0), 0)
  }
  const edgeFaded = (e: KEdge) => {
    const m = matches()
    if (m) return !(m.has(e.from) && m.has(e.to))
    if (props.healthFilter) return true
    if (activeKinds()) {
      // Light the edge only when both endpoints pass the kind filter — keeps the active subset's
      // connectivity readable instead of leaving dangling lines that go nowhere.
      const a = layout().nodes.find((n) => n.id === e.from)
      const b = layout().nodes.find((n) => n.id === e.to)
      return !(a && b && nodeKindOk(a.kind) && nodeKindOk(b.kind))
    }
    const r = related()
    return r ? !r.edges.has(edgeKey(e)) : false
  }
  // All-view arrows: the cross-kind backbone lines fan across the whole kind matrix and read as
  // noise when you are just scanning which kinds exist — so hide them until a resource is selected,
  // when they become the useful "what connects to THIS" highlight. Every other view keeps its edges
  // always (their layouts route edges meaningfully along the backbone).
  const renderedEdges = createMemo(() => (props.groupBy === 'kind' && !props.selectedId ? [] : layout().edges))
  // Accent only the edges DIRECTLY touching the selected node (one hop in or out) — not every edge
  // in its connected component (cycle 309). The whole subtree still stays lit (nodeFaded keeps the
  // component visible and edgeFaded leaves its edges in normal style); the accent is reserved for
  // "what connects straight to the thing I clicked", so a Pod selection highlights only its own
  // owner→pod link rather than lighting up the Deployment→RS→all-siblings backbone too.
  const edgeAdjacent = (e: KEdge) => {
    if (matches() || props.healthFilter || activeKinds()) return false
    const id = props.selectedId
    return !!id && (e.from === id || e.to === id)
  }

  const [scale, setScale] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  // Endpoints of the edge currently under the pointer (cycle 330/R4): in a dense graph an edge's two
  // cards can be far apart or buried, so hovering the edge halos both ends to answer "what does this
  // connect?" without selecting. Null when no edge is hovered.
  const [hoverEnds, setHoverEnds] = createSignal<{ from: string; to: string } | null>(null)
  const edgeEndpoint = (id: string) => {
    const h = hoverEnds()
    return !!h && (h.from === id || h.to === id)
  }
  let svg: SVGSVGElement | undefined
  // The full-width control bar overlays the top of the canvas; the fit reads its live height so it
  // can centre the graph in the VISIBLE area below the bar instead of behind it.
  let toolbarEl: HTMLDivElement | undefined
  let pointerDown = false
  let dragging = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  // Pointer velocity (px/ms), EMA-smoothed across recent moves, for the flick-to-coast momentum on
  // drag release (cycle 339/R10).
  let vx = 0
  let vy = 0
  let lastMoveT = 0

  // Smoothly animate viewport (tx/ty/scale) to a target over ~360ms with easeOutCubic.
  // Replaces the prior "snap-instantly" updates so namespace/view switches and selection focus
  // changes glide instead of jumping — easier for a human to track what just changed.
  let animFrame = 0
  let selFitFrame = 0 // rAF handle for the deferred selection-fit (cycle 307)
  let cardClickTimer: ReturnType<typeof setTimeout> | undefined // deferred deselect, cancelled by dblclick (cycle 315)
  function animateTo(target: { scale: number; tx: number; ty: number }, duration = 360) {
    cancelAnimationFrame(animFrame)
    const s0 = scale(), tx0 = tx(), ty0 = ty()
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration)
      const e = 1 - Math.pow(1 - t, 3)
      setScale(s0 + (target.scale - s0) * e)
      setTx(tx0 + (target.tx - tx0) * e)
      setTy(ty0 + (target.ty - ty0) * e)
      if (t < 1) animFrame = requestAnimationFrame(tick)
    }
    animFrame = requestAnimationFrame(tick)
  }
  onCleanup(() => {
    cancelAnimationFrame(animFrame)
    cancelAnimationFrame(selFitFrame)
    clearTimeout(cardClickTimer)
  })

  // computeFitFor: scale + translate that frames the given bounds into the SVG viewport with the
  // given padding. Caps max scale so single-card selections don't zoom in to absurd sizes.
  function computeFitFor(minX: number, minY: number, maxX: number, maxY: number, maxScale: number) {
    const rect = svg!.getBoundingClientRect()
    // The control bar overlays the top strip of the canvas, so frame the graph into the area BELOW
    // it: shrink the usable height by the bar's height and push the vertical centre down by the same,
    // otherwise the topmost cards land behind the bar (the user's "resources hidden by the panel").
    const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
    const availH = Math.max(1, rect.height - topInset)
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY)
    const padding = 60
    const s = Math.min((rect.width - padding * 2) / w, Math.max(1, availH - padding * 2) / h, maxScale)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    return { scale: s, tx: rect.width / 2 - cx * s, ty: topInset + availH / 2 - cy * s }
  }

  // selectionMaxScale lets a small selection zoom in close while a big subtree stays moderate. The
  // fixed 1.6 cap (cycle 319 superseded) under-zoomed a lone card — fitting one 220×60 card could
  // legitimately go to ~4x but capped at 1.6 it stayed small and lost in whitespace. The 1000/√area
  // curve yields ~2.5 for a single card and tapers to the 1.4 floor as the framed area grows (big
  // subtrees are viewport-limited below the cap anyway, so the floor never shrinks them).
  function selectionMaxScale(w: number, h: number): number {
    return Math.max(1.4, Math.min(2.5, 1000 / Math.sqrt(Math.max(1, w * h))))
  }

  // boundingBox + fitNodeSet (cycle 336/R9): the "spread every card's x±w/2, y±h/2 and take min/max"
  // pattern was copy-pasted at four fit sites (selection-fit effect, resetView's selection / lit
  // branches), and the full computeFitFor(...selectionMaxScale(...)) expression was byte-identical
  // twice. Extracted so the coordinate math lives once — a future change (e.g. fit padding) is a
  // one-line edit instead of four. maxScale is a constant for fit-all or selectionMaxScale for a
  // selection (it needs the box dims, hence the function form).
  function boundingBox(nodes: { x: number; y: number; width: number; height: number }[]) {
    const xs = nodes.flatMap((n) => [n.x - n.width / 2, n.x + n.width / 2])
    const ys = nodes.flatMap((n) => [n.y - n.height / 2, n.y + n.height / 2])
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
  }
  function fitNodeSet(
    nodes: { x: number; y: number; width: number; height: number }[],
    maxScale: number | ((w: number, h: number) => number),
  ) {
    const bb = boundingBox(nodes)
    const ms = typeof maxScale === 'function' ? maxScale(bb.width, bb.height) : maxScale
    return computeFitFor(bb.minX, bb.minY, bb.maxX, bb.maxY, ms)
  }

  // Fit-all on a real scope switch (context/namespace) OR a client-side restructure (grouping /
  // relationship-filter change) — but NOT on node-count churn (a collapse expand or an SSE
  // add/remove must preserve the operator's pan/zoom). `pendingFit` defers the fit until the
  // layout actually has geometry (the first SSE frame can arrive after a flip, while width is
  // still 0). First mount is a snap (no animation); later switches glide.
  let fitScope = 'init'
  let layoutKey = 'init'
  let pendingFit = true
  let firstFit = true
  // freshData closes a race that exists ONLY for real scope switches: App closes the old SSE and
  // setGraph(emptyState()) on a ctx/ns change, so the new namespace's nodes stream in async — for
  // one beat layout() is computed from the OLD nodes (a giant transient box). width === 0 is the
  // reliable "the new scope's data is incoming" marker; we refuse to fit until we've seen that
  // reset, skipping the stale pre-reset layout. A grouping/relationship change is DIFFERENT — it
  // re-projects the SAME, already-present graph (no resubscribe, no empty frame), so it must fit
  // immediately and must NOT arm the freshData wait, or the fit would never fire.
  let freshData = true
  const relKey = () => [...(props.relFilter ?? EMPTY_RELS)].sort().join(',')
  createEffect(() => {
    const l = layout()
    const scope = props.scope ?? ''
    const lk = `${props.groupBy ?? ''}|${relKey()}`
    if (scope !== fitScope) {
      fitScope = scope
      layoutKey = lk
      pendingFit = true
      freshData = false // real scope switch: wait for the graph reset before trusting geometry
    } else if (lk !== layoutKey) {
      layoutKey = lk
      pendingFit = true
      freshData = true // client-only restructure: data already present, fit the next frame
    }
    if (!svg) return
    if (l.width === 0) {
      freshData = true // the graph was cleared for the incoming scope; the next non-empty is real
      return
    }
    if (!pendingFit || !freshData) return
    if (props.selectedId) {
      pendingFit = false // selection-fit owns this scope's first frame; don't also fit-all
      return
    }
    pendingFit = false
    const target = computeFitFor(0, 0, l.width, l.height, 1.4)
    target.scale *= 0.92 // a little breathing room when the whole graph already fits comfortably
    if (target.scale < MIN_FIT_SCALE) {
      // Too many resources to fit readably: rather than shrink the whole graph to an unreadable
      // speck, clamp to a legible floor (a hard minimum, applied AFTER the breathing room so it's
      // never undercut) and open on the top-left — the first resources. Center the axis that still
      // fits at the floor; anchor the overflowing axis to its start. The operator zooms out from
      // there for the whole picture (the fit button / `f` still frames everything on demand).
      const rect = svg.getBoundingClientRect()
      const pad = 60
      // Anchor below the control bar, not behind it: inset the top by the bar height so the first
      // resources open just under the bar rather than hidden under it.
      const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
      const availH = Math.max(1, rect.height - topInset)
      const contentW = l.width * MIN_FIT_SCALE
      const contentH = l.height * MIN_FIT_SCALE
      target.scale = MIN_FIT_SCALE
      target.tx = contentW + pad * 2 <= rect.width ? (rect.width - contentW) / 2 : pad
      target.ty = contentH + pad * 2 <= availH ? topInset + (availH - contentH) / 2 : topInset + pad
    }
    if (firstFit) {
      firstFit = false
      setScale(target.scale)
      setTx(target.tx)
      setTy(target.ty)
    } else {
      animateTo(target)
    }
  })

  // Track SVG size so resizes keep the graph on-screen (cycle 294). Drawer open/close and window
  // resizes both squeeze/grow the SVG; without this the existing pan stays at old coords and the
  // graph can drift off-screen. Closing the drawer is the dominant trigger, and the operator's zoom
  // must survive it (see the deselect branch above) — so preserve the current scale and only
  // re-clamp the translate into the resized viewport, rather than re-fitting to fit-all and throwing
  // the zoom away. `f` / double-click still fit on demand. Selection owns the shrink case (drawer
  // opening). Debounce via rAF so a continuous resize (window drag) doesn't fight the animation.
  // Guarded for jsdom (no ResizeObserver).
  onMount(() => {
    if (!svg || typeof ResizeObserver === 'undefined') return
    let rafId = 0
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        if (!svg) return
        const l = layout()
        if (l.width === 0) return
        if (props.selectedId) return // selection-fit owns this case
        // Snap, not animate: a resize is a viewport change, not a user-initiated transition.
        const c = clampTranslate(tx(), ty())
        setTx(c.tx)
        setTy(c.ty)
      })
    })
    ro.observe(svg)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
      ro.disconnect()
    })
  })

  // When the selection changes, smoothly frame the selected resource's full subtree (computed by
  // related()) — answers the user's "zoom to selected + related" without requiring a manual Fit.
  // Selection cleared → keep the current pan/zoom untouched. Clicking the canvas to close the drawer
  // is the operator's way of saying "show me the next resource", so re-fitting to fit-all here just
  // throws the viewport away and forces them to re-zoom (`f` / double-click still fit on demand).
  createEffect(
    on(
      () => props.selectedId,
      (id) => {
        if (!svg) return
        const l = layout()
        if (l.width === 0) return
        if (!id) return
        // Nodes view: frame the node row the selection sits in (see capRowBoxFor).
        const capBox = capRowBoxFor(id)
        if (capBox) {
          cancelAnimationFrame(selFitFrame)
          selFitFrame = requestAnimationFrame(() => animateTo(fitNodeSet([capBox], 1.4)))
          return
        }
        const r = related()
        if (!r) return
        const inSet = l.nodes.filter((n) => r.nodes.has(n.id))
        if (inSet.length === 0) return
        // Defer the fit one frame so the just-opened drawer has taken its flex width and the SVG
        // has shrunk to the still-visible canvas before computeFitFor reads getBoundingClientRect.
        // The drawer is a flex sibling created after Topology, so on the *first* selection this
        // effect would otherwise measure the full pre-drawer width and frame the subtree off-center,
        // half-hidden under the drawer — while every later selection (drawer already open) measured
        // correctly. The rAF lets Solid finish committing the drawer DOM and the browser reflow the
        // SVG, so the very first click frames against the visible canvas too (cycle 307).
        cancelAnimationFrame(selFitFrame)
        selFitFrame = requestAnimationFrame(() => {
          animateTo(fitNodeSet(inSet, selectionMaxScale))
        })
      },
      { defer: true },
    ),
  )

  // clampTranslate keeps at least a margin of the laid-out graph on-screen, so a pan can't fling the
  // whole canvas into the void (where the only recovery was the Fit button). The graph spans screen
  // x in [tx, tx + width*scale]; we require its far edge to stay ≥ margin inside the viewport on
  // each side. A graph smaller than the viewport is unaffected (the bounds never invert). (cycle 316)
  function clampTranslate(txv: number, tyv: number): { tx: number; ty: number } {
    const l = layout()
    if (!svg || l.width === 0) return { tx: txv, ty: tyv }
    const rect = svg.getBoundingClientRect()
    const margin = 60
    const w = l.width * scale(), h = l.height * scale()
    return {
      tx: Math.min(Math.max(txv, margin - w), rect.width - margin),
      ty: Math.min(Math.max(tyv, margin - h), rect.height - margin),
    }
  }

  // Wheel handling distinguishes three gestures, matching the conventions Mac users expect (see
  // github.com/arto-app/Arto renderer/src/base-viewer-controller.ts for the same exp() smoothing):
  //   1. Trackpad pinch — arrives as a wheel event with ctrlKey=true synthesized by macOS.
  //   2. Cmd+scroll — explicit zoom intent on either pointer type.
  //   3. Regular wheel with deltaMode=LINE/PAGE — a classic mouse wheel; users expect zoom.
  //   4. Regular wheel with deltaMode=PIXEL — trackpad 2-finger scroll; users expect PAN.
  // Zoom factor uses Math.exp(-Δ * k) so a single mouse-wheel click and a flurry of trackpad
  // events both land at sensible cumulative zoom. k tuned smaller than Arto's 0.01 because kd's
  // canvas is denser and a 1.1x factor per click was overshooting.
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const deltaScale = e.deltaMode === 0 ? 1 : e.deltaMode === 1 ? 10 : 20
    const isPinch = e.ctrlKey || e.metaKey
    const isMouseWheel = e.deltaMode !== 0 // LINE/PAGE deltas come from classic mice
    if (isPinch || isMouseWheel) {
      // Zoom toward the cursor, keeping the graph point under it fixed.
      const k = isPinch ? 0.012 : 0.006 // pinch is small-step; mouse wheel ticks are coarser
      const factor = Math.exp(-e.deltaY * deltaScale * k)
      const rect = svg!.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const s = Math.min(Math.max(scale() * factor, 0.15), 3)
      setTx(mx - ((mx - tx()) / scale()) * s)
      setTy(my - ((my - ty()) / scale()) * s)
      setScale(s)
    } else {
      // Trackpad 2-finger scroll: pan in both axes. Both deltas are in pixel units already.
      // Clamp live so a flick can't scroll the graph entirely off-canvas.
      const c = clampTranslate(tx() - e.deltaX, ty() - e.deltaY)
      setTx(c.tx)
      setTy(c.ty)
    }
  }

  // Pan only after the pointer moves past a small threshold, so a plain click still reaches a
  // node's onClick (capturing the pointer on press would redirect the click to the SVG).
  function onPointerDown(e: PointerEvent) {
    pointerDown = true
    dragging = false
    startX = lastX = e.clientX
    startY = lastY = e.clientY
    vx = vy = 0
    lastMoveT = performance.now()
    cancelAnimationFrame(animFrame) // grabbing the canvas stops any in-flight coast
  }
  function onPointerMove(e: PointerEvent) {
    if (!pointerDown) return
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
      dragging = true
      try {
        svg?.setPointerCapture(e.pointerId)
      } catch {
        /* pointer may already be gone */
      }
    }
    if (dragging) {
      setTx(tx() + (e.clientX - lastX))
      setTy(ty() + (e.clientY - lastY))
      // EMA-smooth the instantaneous velocity so one jittery sample doesn't dominate the flick.
      const now = performance.now()
      const dt = Math.max(1, now - lastMoveT)
      vx = 0.6 * vx + 0.4 * ((e.clientX - lastX) / dt)
      vy = 0.6 * vy + 0.4 * ((e.clientY - lastY) / dt)
      lastMoveT = now
    }
    lastX = e.clientX
    lastY = e.clientY
  }
  // Coast the canvas after a flick, decaying velocity until it's negligible (cycle 339/R10). Gives the
  // pan a physical "throw it and let it settle" feel instead of stopping dead. clampTranslate still
  // arrests each axis at the layout edge, so momentum can't fling the graph out of view.
  function startMomentum() {
    // Cap the launch speed so an extreme flick can't fling the canvas across the screen — coasting
    // should feel like a throw, not a loss of control.
    vx = Math.max(-2.5, Math.min(2.5, vx))
    vy = Math.max(-2.5, Math.min(2.5, vy))
    let lastT = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(40, now - lastT)
      lastT = now
      const decay = Math.exp(-dt * 0.008) // ~halve the speed every ~85ms → settles in well under a second
      vx *= decay
      vy *= decay
      const nx = tx() + vx * dt
      const ny = ty() + vy * dt
      const c = clampTranslate(nx, ny)
      setTx(c.tx)
      setTy(c.ty)
      if (c.tx !== nx) vx = 0 // hit the horizontal edge — stop that axis
      if (c.ty !== ny) vy = 0
      if (Math.hypot(vx, vy) > 0.015) animFrame = requestAnimationFrame(tick)
    }
    animFrame = requestAnimationFrame(tick)
  }
  function onPointerUp(e: PointerEvent) {
    const wasDragging = dragging
    pointerDown = false
    dragging = false
    try {
      svg?.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    // After a drag: a fast release coasts (momentum, cycle 339/R10); a slow one just glides back into
    // bounds if it ended past the edge (cycle 316). 0.4 px/ms ≈ 400 px/s — above a deliberate flick,
    // below an ordinary reposition, so a careful drag still stops exactly where released.
    if (wasDragging) {
      if (Math.hypot(vx, vy) > 0.4) {
        startMomentum()
        return
      }
      const c = clampTranslate(tx(), ty())
      if (c.tx !== tx() || c.ty !== ty()) animateTo({ scale: scale(), tx: c.tx, ty: c.ty }, 200)
      return
    }
    // Cycle 161: a click on the topology background (not on a card and not a pan) dismisses the
    // open drawer. Walk up from the click target — if any ancestor has the .node class, it was a
    // card click (its own onClick will run); otherwise treat as a background click.
    if (!props.onDeselect || !props.selectedId) return
    let el: Element | null = e.target as Element | null
    while (el && el !== svg) {
      // A card (.node) OR a collapse pill (.collapse-pill) is an interactive target with its own
      // onClick — treat it as a hit, not background. Without the pill check, clicking "show more"
      // while a resource is selected also ran this background branch and deselected it, closing the
      // drawer out from under the operator who only meant to expand the cluster.
      if ((el as Element).classList?.contains('node') || (el as Element).classList?.contains('collapse-pill')) return
      el = el.parentElement
    }
    props.onDeselect()
  }

  // Double-clicking empty canvas re-fits the view. A common gesture in graph editors; cheaper to
  // discover than the 'f' shortcut for new operators. Card hit-test walks ancestors the same way
  // onPointerUp does, so a stray double-click on a node title runs the node's own behavior.
  function onBackgroundDblClick(e: MouseEvent) {
    let el: Element | null = e.target as Element | null
    while (el && el !== svg) {
      // A card (.node) OR a collapse pill (.collapse-pill) is an interactive target with its own
      // onClick — treat it as a hit, not background. Without the pill check, clicking "show more"
      // while a resource is selected also ran this background branch and deselected it, closing the
      // drawer out from under the operator who only meant to expand the cluster.
      if ((el as Element).classList?.contains('node') || (el as Element).classList?.contains('collapse-pill')) return
      el = el.parentElement
    }
    resetView()
  }

  function resetView() {
    const l = layout()
    if (!svg || l.width === 0) return
    // Cycle 293: when a selection is active, 'f' re-frames the selection's connected subtree
    // (same set the click-into-selection effect targets). Otherwise it falls back to the
    // filter-aware fit-all from cycle 214. Without this, the operator who manually panned
    // away from their selected subtree would lose it on 'f' — they'd have to click the
    // selection again to recover the frame.
    if (props.selectedId) {
      // Nodes view: 'f' re-frames the selected pod's node row (matching the click-into-selection fit).
      const capBox = capRowBoxFor(props.selectedId)
      if (capBox) {
        animateTo(fitNodeSet([capBox], 1.4))
        return
      }
      const r = related()
      const inSet = r ? l.nodes.filter((n) => r.nodes.has(n.id)) : []
      if (inSet.length > 0) {
        animateTo(fitNodeSet(inSet, selectionMaxScale))
        return
      }
    }
    // When any filter is active, frame just the lit subset — otherwise "Fit" gives you a
    // viewport of mostly-faded cards with the actual interesting nodes shrunk down. With no
    // filter the full layout is the right frame (cycle 214).
    const lit = matches() || props.healthFilter || activeKinds()
      ? l.nodes.filter((n) => !nodeFaded(n))
      : l.nodes
    if (lit.length === 0) {
      // Filter excluded everything — fall back to the full layout so Fit isn't a dead button.
      const target = computeFitFor(0, 0, l.width, l.height, 1.4)
      target.scale *= 0.92
      animateTo(target)
      return
    }
    const target = fitNodeSet(lit, 1.4)
    target.scale *= 0.92
    animateTo(target)
  }

  // Keyboard zoom (cycle 329/R3): scale by a factor while keeping the viewport-center world point
  // fixed — same pivot math as the wheel handler, just anchored at the middle instead of the cursor.
  // Gives keyboard/trackpad-less operators (and Vim-style users) fine zoom control to pair with 'f'.
  // Applied instantly (not via animateTo) so successive presses accumulate: animateTo reads the
  // mid-flight scale() signal, so a burst of presses would all target the same value and lose steps.
  function zoomByAtCenter(factor: number) {
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const cx = rect.width / 2, cy = rect.height / 2
    const s0 = scale()
    const s = Math.min(Math.max(s0 * factor, 0.15), 3)
    if (s === s0) return
    cancelAnimationFrame(animFrame) // stop any in-flight fit/glide from fighting the keyboard zoom
    setTx(cx - ((cx - tx()) / s0) * s)
    setTy(cy - ((cy - ty()) / s0) * s)
    setScale(s)
  }

  // Keyboard shortcuts: 'f' fits the canvas (cycle 229); '='/'+' zoom in, '-' zoom out, '0' resets to
  // 1× (all centered). Plain keys, no modifier — Cmd/Ctrl variants are left to the browser's own zoom.
  // Ignored when typing in an input or when a non-Shift modifier is held (Shift passes so '+' works).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f') {
        e.preventDefault()
        resetView()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomByAtCenter(1.2)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomByAtCenter(1 / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        zoomByAtCenter(1 / scale()) // land exactly on 1× without moving the center
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    // Below ~0.45 zoom the fixed-size card text renders at a few unreadable pixels, so it's just
    // noise over the overview. labels-hidden fades the text out, leaving a clean map of health-tinted,
    // icon-only cards; hover/click still reveal the detail. The icon + card color carry kind + health
    // at any zoom (cycle 325).
    <div class="topology" classList={{ 'labels-hidden': scale() < 0.45 }}>
      {/* Health-distribution stripe: a thin bar pinned to the top edge of the canvas, one segment
          per present state sized in proportion — the "what's this namespace doing?" read at a
          glance (a sliver of red on a sea of green). Spans the FULL width of the main view (a
          fixed status bar, like the old topbar stripe), deliberately decoupled from the filter
          pills so its width never varies with how many pills are showing. */}
      <Show when={shownHealth().length > 0}>
        {/* The stripe lives inside .topology, which is the flex child that shrinks to make room
            for the detail drawer. Left alone it would narrow with the canvas; stripe-over-drawer
            extends it back across the drawer so the status bar always spans the full main view.
            The overflow:hidden on .main clips the (over-extended) tail to the main edge. */}
        <div
          class="topology-stripe"
          classList={{ 'stripe-over-drawer': !!props.selectedId }}
          aria-hidden="true"
        >
          <For each={shownHealth()}>
            {(h) => (
              <span
                style={{ flex: healthStats()[h], 'background-color': healthColor(h) }}
                title={`${h}: ${healthStats()[h]}`}
              />
            )}
          </For>
        </div>
      </Show>
      {/* Filtered-everything-out overlay (cycle 219): when a filter is active and nothing
          is lit, surface that clearly + a one-click clear button so the operator doesn't have
          to guess why the canvas looks dim. Sits above the canvas like the empty state. */}
      <Show
        when={
          props.nodes.length > 0 &&
          (matches() || props.healthFilter || activeKinds()) &&
          layout().nodes.every((n) => nodeFaded(n))
        }
      >
        <div class="topology-empty topology-filtered-out">
          <div class="topology-empty-text">No resources match the active filter.</div>
          <Show when={props.onClearFilters}>
            <button class="topology-clear" onClick={() => props.onClearFilters?.()}>
              clear all filters
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.nodes.length === 0}>
        <div class="topology-empty">
          {/* Friendly graphic: three card silhouettes staggered like a small cluster, each with a
              tiny icon-circle hint at the top-left echoing the cycle-126 icon-forward card. */}
          <svg class="topology-empty-illo" viewBox="0 0 140 64" width="140" height="64" aria-hidden="true">
            <g>
              <rect x="6" y="22" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="14" cy="32" r="2.6" class="empty-card-icon" />
            </g>
            <g>
              <rect x="50" y="12" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="58" cy="22" r="2.6" class="empty-card-icon" />
            </g>
            <g>
              <rect x="94" y="26" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="102" cy="36" r="2.6" class="empty-card-icon" />
            </g>
          </svg>
          <div class="topology-empty-text">
            <Show when={props.connected} fallback={
              <>
                {/* Small inline spinner so "Connecting…" reads as "actively working on it" rather
                    than a frozen text state. CSS animation; respects prefers-reduced-motion. */}
                <span class="topology-empty-spinner" aria-hidden="true" />
                Connecting…
              </>
            }>
              Nothing to show in this namespace.
            </Show>
          </div>
          {/* When the canvas is empty but the stream is live, surface a hint describing the current
              grouping / relationship selection, so the operator understands the lens they're
              looking through. Hidden while connecting (the line above carries the message). */}
          <Show when={props.connected}>
            <div class="topology-empty-hint">{emptyHint()}</div>
          </Show>
        </div>
      </Show>
      {/* The canvas control bar: a full-width strip across the top of the canvas, three short rows
          — search + Group, Relationships + Health, then Kinds — instead of one facet per line, so
          it stays shallow. Each facet is an inline label hugging its controls (proximity). The
          Kinds row is a strict single line that scrolls horizontally on overflow, so the bar height
          never grows with the number of kinds. */}
      <div class="topology-toolbar" ref={toolbarEl}>
      {/* Row 1 — search + group: the resource search plus the layout selector. */}
      <div class="toolbar-row topology-search">
        {/* Wraps the input so the magnifier glyph (positional, decorative) and the clear-X button
            sit inside the field's frame instead of beside it. */}
        <div class="topology-search-field">
          <svg class="topology-search-icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle cx="6" cy="6" r="3.5" />
            <line x1="8.6" y1="8.6" x2="12" y2="12" />
          </svg>
          <input
            ref={props.searchRef}
            placeholder="Search resources…  ( ⌘K )"
            aria-label="Search resources in current view"
            // Surface the structured-form (cycle 295) on hover so an operator who pasted a
            // Kind/name and got a single hit can intuit why — also discoverable for those who
            // haven't read the help overlay.
            title="Search name · kind · status · host · IP · image · labels. Type Kind/name (e.g. po/web-abc) for a structured lookup; Enter cycles matches."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (query()) setQuery('')
                else (e.currentTarget as HTMLInputElement).blur()
              }
              else if (e.key === 'Enter') {
                // Cycle through matches: first Enter picks the most-troubled (orderedForNav).
                // Subsequent Enters step to the next match in that order; Shift+Enter steps back.
                // Wraps at both ends. With nothing matched it's a no-op.
                const ordered = matchOrdered()
                if (ordered.length === 0) return
                const cur = ordered.findIndex((n) => n.id === props.selectedId)
                const dir = e.shiftKey ? -1 : 1
                const next = cur < 0
                  ? (dir > 0 ? 0 : ordered.length - 1)
                  : (cur + dir + ordered.length) % ordered.length
                props.onSelect(ordered[next].id)
              }
            }}
          />
          <Show when={query()}>
            <button class="topology-search-clear" onClick={() => setQuery('')} title="Clear (Esc)" aria-label="Clear search">
              ×
            </button>
          </Show>
        </div>
        <Show when={matches()}>
          <span
            class="topology-matches"
            classList={{ none: matches()!.size === 0 }}
            // When the current selection is itself a match, prefix the count with its 1-based
            // position in the cycle order — so an operator pressing Enter knows "I'm at 3 of 7"
            // and can predict when the cycle wraps. Falls back to the bare count if the selection
            // is outside the match set (or no selection).
            title={
              matchPos() > 0
                ? `Match ${matchPos()} of ${matches()!.size}. Press Enter for next, Shift+Enter for previous.`
                : matches()!.size === 0
                  ? 'No resources match the current search.'
                  : `${matches()!.size} match${matches()!.size === 1 ? '' : 'es'}. Press Enter to jump to one.`
            }
          >
            <Show
              when={matches()!.size === 0}
              fallback={matchPos() > 0
                ? `${matchPos()} of ${matches()!.size}`
                : `${matches()!.size} match${matches()!.size === 1 ? '' : 'es'}`}
            >
              no matches
            </Show>
          </span>
        </Show>
        {/* Clear-all: surfaces the same operation as Escape, but discoverable without knowing
            the shortcut. Visible only when at least one filter is on, so the toolbar stays
            quiet when there's nothing to clear (cycle 216). */}
        <Show when={(matches() || props.healthFilter || activeKinds()) && props.onClearFilters}>
          <button class="topology-clear" onClick={() => props.onClearFilters?.()} title="Clear all filters (Esc)">
            clear
          </button>
        </Show>
        {/* Group facet — the layout selector. Single-select, so a connected segmented control (the
            contrast against the toggle chips signals "pick one mode"). Shares row 1 with the search
            field to keep the panel short. */}
        <Show when={props.onGroupBy}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Group</span>
            <div class="group-seg" role="group" aria-label="Group resources by">
              <For each={GROUP_OPTIONS}>
                {(g) => (
                  <button
                    classList={{ active: (props.groupBy ?? 'relationship') === g.id }}
                    aria-pressed={(props.groupBy ?? 'relationship') === g.id}
                    onClick={() => props.onGroupBy?.(g.id)}
                    title={g.hint}
                  >
                    {g.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        {/* Capacity-view facet — only in the Nodes group-by. Resource picks which single metric
            sizes the bars (CPU/memory never share one length channel). The bars are the explicit
            Req + Use stacked form; this namespace's pods render individually and the rest fold into
            one labelled "other namespaces" block, so no separate legend is needed. */}
        <Show when={props.groupBy === 'nodes'}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Resource</span>
            <div class="group-seg" role="group" aria-label="Size bars by resource">
              <For each={[{ id: 'cpu', label: 'CPU' }, { id: 'memory', label: 'Memory' }] as const}>
                {(r) => (
                  <button
                    classList={{ active: capResource() === r.id }}
                    aria-pressed={capResource() === r.id}
                    onClick={() => setCapResource(r.id)}
                    title={`Size node tracks and pod segments by ${r.label}`}
                  >
                    {r.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
        {/* Row 2 — Relationships + Health: which links are drawn, and the health spotlight. */}
        <Show when={(relChips().length > 0 && props.onRelFilter) || (shownHealth().length > 0 && props.onHealthFilter)}>
          <div class="toolbar-row">
        {/* Relationships facet — which relationship categories are drawn (and so drive
            connectivity). Composable toggles: several can be active at once. One chip per category
            present in the graph; Shift+click solos. */}
        <Show when={relChips().length > 0 && props.onRelFilter}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Relationships</span>
            <div class="topology-rels" role="toolbar" aria-label="Relationship filter">
            <For each={relChips()}>
              {(c) => (
                <button
                  class="rel-chip"
                  classList={{ active: props.relFilter?.has(c.id) ?? false }}
                  aria-pressed={props.relFilter?.has(c.id) ?? false}
                  onClick={(e) => props.onRelFilter?.(c.id, e.shiftKey)}
                  title={`${c.hint} · Click to toggle · Shift+click to solo`}
                >
                  {c.label}
                  <span class="rel-chip-count">{c.count}</span>
                </button>
              )}
            </For>
            </div>
          </div>
        </Show>
        {/* Health facet — spotlight a health state. Shares row 2 with Relationships. The
            at-a-glance proportion lives in the fixed-width stripe pinned to the top of the canvas
            (rendered below), not here — so this row never changes the stripe's width. */}
        <Show when={shownHealth().length > 0 && props.onHealthFilter}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Health</span>
            <div class="topology-health-pills" role="toolbar" aria-label="Health filter">
            <For each={shownHealth()}>
              {(h) => (
                <button
                  class="legend-item"
                  aria-pressed={props.healthFilter === h}
                  classList={{ active: props.healthFilter === h }}
                  // Active pill borrows the health hue for its border + tint, so the link to
                  // "spotlighting THIS color" stays explicit (matches the kind chips' accent).
                  style={
                    props.healthFilter === h
                      ? {
                          'border-color': healthColor(h),
                          background: `color-mix(in srgb, ${healthColor(h)} 14%, transparent)`,
                          color: 'var(--text)',
                        }
                      : undefined
                  }
                  onClick={() => props.onHealthFilter?.(props.healthFilter === h ? null : h)}
                  title={`Spotlight ${h} resources`}
                >
                  <span class="dot" style={{ background: healthColor(h) }} />
                  {h}
                  <span class="legend-count">{healthStats()[h]}</span>
                </button>
              )}
            </For>
            </div>
          </div>
        </Show>
          </div>
        </Show>
        {/* Row 3 — Kinds: the kind filter, usually the widest row, on its own line. Click toggles a
            kind in/out of the active set (multi-select, composes with search + health); Shift+click
            solos. Hidden when only one kind is present. Each chip carries the same monochrome
            silhouette as its cards, so the row reads as a legend of "what kinds are here". */}
        <Show when={kindChips().length > 1 && props.onKindFilter}>
          <div class="toolbar-row">
          <div class="toolbar-facet toolbar-facet-grow">
            <span class="toolbar-label">Kinds</span>
            <div class="topology-kinds" role="toolbar" aria-label="Kind filter">
            <For each={kindChips()}>
              {(c) => (
                <button
                  class="kind-chip"
                  classList={{ active: activeKinds()?.has(c.kind) ?? false, 'kind-pod': c.kind === 'Pod', troubled: c.worst != null }}
                  onClick={(e) => props.onKindFilter?.(c.kind, e.shiftKey)}
                  title={
                    c.worst
                      ? `Click to toggle ${c.kind} · Shift+click to solo — at least one ${c.worst}`
                      : `Click to toggle ${c.kind} · Shift+click to solo`
                  }
                  aria-pressed={activeKinds()?.has(c.kind) ?? false}
                >
                  <svg class="kind-chip-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                    {kindIcon(c.kind)}
                  </svg>
                  <span class="kind-chip-label">{kindShortLabel(c.kind)}</span>
                  {/* Tiny severity dot (cycle 289): kinds with any non-Healthy resource get a
                      colored pip in their bottom-right. Preserves the count-based chip order so
                      muscle memory survives, while still surfacing "which kinds carry trouble" at
                      a glance — answer the operator's "where do I look?" without scanning cards. */}
                  <Show when={c.worst}>
                    <span class="kind-chip-dot" style={{ background: healthColor(c.worst!) }} aria-hidden="true" />
                  </Show>
                  <span class="kind-chip-count">{c.count}</span>
                </button>
              )}
            </For>
            </div>
          </div>
          </div>
        </Show>
      </div>
      <svg
        ref={svg}
        class="topology-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDblClick={onBackgroundDblClick}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-color)" />
          </marker>
          {/* Diagonal hatch marking a pod bursting past its request, overlaid on the health-colored
              segment so "over request" reads unambiguously — distinct from the amber suspended hue. */}
          <pattern id="cap-burst-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text)" stroke-width="2" opacity="0.55" />
          </pattern>
        </defs>
        <g transform={`translate(${tx()},${ty()}) scale(${scale()})`}>
          {/* Nodes view: the capacity & usage visualization. Each node is a horizontal track
              (length ∝ allocatable) with pods drawn as usage-sized segments; reserved-vs-actual
              shows as stacked req/use bars (split) or one usage bar + a Σrequest marker (overlay).
              Expanding a node unfolds per-pod bullets with request/limit ticks + overshoot. */}
          <Show when={props.groupBy === 'nodes'}>
            <g class="cap-view">
              {/* Honesty hint: with no metrics-server, usage is unknown, so bars fall back to
                  sizing by request — say so rather than implying the requests are usage. */}
              <Show when={capRows().length > 0 && !capInfo().hasUsage}>
                <text class="cap-hint" x={30} y={14}>
                  metrics-server unavailable — bars sized by requests
                </text>
              </Show>
              <For each={capRows()}>
                {(row) => {
                  const fmt = (v: number | undefined) => formatQuantity(v, capResource())
                  const pods = row.ownCount
                  const expandable = pods > 0 || row.otherCount > 0
                  const segClasses = (s: CapSeg) => ({
                    over: s.over,
                    near: s.nearLimit,
                    faded: capSegFaded(s.node),
                    selected: s.node.id === props.selectedId,
                    [`h-${s.node.health.toLowerCase()}`]: true,
                  })
                  // The WHOLE node row is one big click target for expand/collapse (a bordered card),
                  // not a tiny caret: clicking anywhere that isn't a pod segment toggles it. Pod segments
                  // and bullets stopPropagation so selecting a pod doesn't also toggle the node.
                  const fx = row.x - 34
                  const fy = row.y - 6
                  const fw = row.width + 42
                  const fh = row.height + 12
                  return (
                    <g class="cap-row" onClick={() => expandable && toggleCluster(`host:${row.host}`)}>
                      <rect
                        class="cap-node-frame"
                        classList={{ clickable: expandable, expanded: row.expanded }}
                        x={fx}
                        y={fy}
                        width={fw}
                        height={fh}
                        rx="8"
                      />
                      {/* Node name packed into the card's top-left (no caret); CAP_HEADER_INSET=26 in
                          layout.ts reserves the matching left offset + card width so it never overflows. */}
                      <text class="cap-row-label" classList={{ clickable: expandable }} x={row.x - 26} y={row.y + 14}>
                        <tspan class="cap-row-host">{row.label}</tspan>
                        {/* Node-level totals (capacity, use, req) used to live here, crowding the name;
                            they now sit next to the Req/Use bars they describe (proximity). The header
                            keeps only the node's identity + pod count. */}
                        <tspan class="cap-row-meta">
                          {` · ${pods} pod${pods === 1 ? '' : 's'}`}
                          {row.otherCount > 0 ? ` (+${row.otherCount} other-ns)` : ''}
                        </tspan>
                        <Show when={row.overcommit}>
                          <tspan class="cap-warn"> · overcommit</tspan>
                        </Show>
                      </text>

                      {/* Requested bar: this namespace's pods sized by request, then the single folded
                          "other namespaces" block. The "Req" axis label sits in the left gutter. */}
                      <text class="cap-axis-label" x={row.x - 6} y={row.reqBarY + 9}>Req</text>
                      <rect class="cap-track req" x={row.x} y={row.reqBarY} width={row.trackW} height={12} rx="2" />
                      <For each={row.reqSegs}>
                        {(s) => (
                          <rect
                            class="cap-seg req"
                            classList={{ faded: capSegFaded(s.node), selected: s.node.id === props.selectedId, [`h-${s.node.health.toLowerCase()}`]: true }}
                            x={s.x}
                            y={s.y}
                            width={Math.max(0.5, s.width - 0.5)}
                            height={s.height}
                            onClick={(e) => { e.stopPropagation(); props.onSelect(s.node.id) }}
                            onPointerMove={(e) => { setCapHover(s.node.id); showTip(tipFromSeg(s), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          />
                        )}
                      </For>
                      <Show when={row.smallReqSeg}>
                        {(o) => (
                          <rect
                            class="cap-seg req small"
                            classList={{ faded: capAggFaded(`small:${row.host}`) }}
                            x={o().x}
                            y={o().y}
                            width={Math.max(0.5, o().width - 0.5)}
                            height={o().height}
                            onPointerMove={(e) => { setCapHover(`small:${row.host}`); showTip(tipFromAgg(o()), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          />
                        )}
                      </Show>
                      <Show when={row.otherReqSeg}>
                        {(o) => (
                          <rect
                            class="cap-seg req other"
                            classList={{ faded: capAggFaded(`other:${row.host}`) }}
                            x={o().x}
                            y={o().y}
                            width={Math.max(0.5, o().width - 0.5)}
                            height={o().height}
                            onPointerMove={(e) => { setCapHover(`other:${row.host}`); showTip(tipFromAgg(o()), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          />
                        )}
                      </Show>
                      {/* Reserved (request) total, sat right after the request bar (proximity): "req / cap". */}
                      <text class="cap-bar-value" x={row.x + Math.max(row.trackW, row.reqTotal * capInfo().scale) + 8} y={row.reqBarY + 9}>
                        <tspan class="cap-bar-value-strong">{fmt(row.reqTotal)}</tspan>
                        {row.cap !== undefined ? ` / ${fmt(row.cap)}` : ''}
                      </text>

                      {/* Usage bar: this namespace's pods sized by actual usage, then the single folded
                          "other namespaces" block. The node's TOTAL usage (all namespaces incl. system
                          overhead, from NodeMetrics) is a faint backdrop so the segments read against
                          the node's real utilization. */}
                      <text class="cap-axis-label" x={row.x - 6} y={row.trackY + 15}>Use</text>
                      <rect class="cap-track use" x={row.x} y={row.trackY} width={row.trackW} height={22} rx="2" />
                      <Show when={row.nodeUse !== undefined}>
                        <rect
                          class="cap-track-nodeuse"
                          x={row.x}
                          y={row.trackY}
                          width={Math.max(0, Math.min(row.nodeUse! * capInfo().scale, row.trackW))}
                          height={22}
                        />
                      </Show>
                      <For each={row.useSegs}>
                        {(s) => (
                          <Show when={s.width > 0}>
                            <g
                              class="cap-seg-g"
                              onClick={(e) => { e.stopPropagation(); props.onSelect(s.node.id) }}
                              onPointerMove={(e) => { setCapHover(s.node.id); showTip(tipFromSeg(s), e) }}
                              onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                            >
                              <rect
                                class="cap-seg use"
                                classList={segClasses(s)}
                                x={s.x}
                                y={s.y}
                                width={Math.max(0.5, s.width - 0.5)}
                                height={s.height}
                              />
                              {/* Bursting (usage > request): hatch overlay, color-independent. */}
                              <Show when={s.over && !capSegFaded(s.node)}>
                                <rect class="cap-burst-overlay" x={s.x} y={s.y} width={Math.max(0.5, s.width - 0.5)} height={s.height} />
                              </Show>
                            </g>
                          </Show>
                        )}
                      </For>
                      <Show when={row.smallUseSeg}>
                        {(o) => (
                          <rect
                            class="cap-seg use small"
                            classList={{ faded: capAggFaded(`small:${row.host}`) }}
                            x={o().x}
                            y={o().y}
                            width={Math.max(0.5, o().width - 0.5)}
                            height={o().height}
                            onPointerMove={(e) => { setCapHover(`small:${row.host}`); showTip(tipFromAgg(o()), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          />
                        )}
                      </Show>
                      <Show when={row.otherUseSeg}>
                        {(o) => (
                          <rect
                            class="cap-seg use other"
                            classList={{ faded: capAggFaded(`other:${row.host}`) }}
                            x={o().x}
                            y={o().y}
                            width={Math.max(0.5, o().width - 0.5)}
                            height={o().height}
                            onPointerMove={(e) => { setCapHover(`other:${row.host}`); showTip(tipFromAgg(o()), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          />
                        )}
                      </Show>
                      {/* Capacity line when requests or usage overflow the track. */}
                      <Show when={row.cap !== undefined && (row.overcommit || row.useTotal > row.cap)}>
                        <line class="cap-capline" x1={row.x + row.trackW} y1={row.trackY - 3} x2={row.x + row.trackW} y2={row.trackY + 25} />
                      </Show>
                      {/* Actual usage total, sat right after the usage bar (proximity): "use / cap". */}
                      <text class="cap-bar-value" x={row.x + Math.max(row.trackW, row.useTotal * capInfo().scale) + 8} y={row.trackY + 15}>
                        <tspan class="cap-bar-value-strong">{fmt(row.useTotal)}</tspan>
                        {row.cap !== undefined ? ` / ${fmt(row.cap)}` : ''}
                      </text>

                      {/* Per-pod bullets (expanded): the colored bar LENGTH is the usage (variable per
                          pod, on the shared per-node scale) — not a fixed track with varying fill — so
                          a small pod's bar is physically shorter. Request/limit draw as ticks; bursting
                          past request is hatched. Only the full pod NAME is printed — the numbers are
                          on hover (item: declutter), and only this namespace's pods get a row. */}
                      <For each={row.bullets}>
                        {(b) => {
                          const bs = row.bulletScale ?? 1
                          const baseline = b.width // furthest marker, capped at the per-node track (layout)
                          // Clamp every marker to the baseline: the scale is zoomed to usage+request, so a
                          // pod whose limit dwarfs its usage has its limit tick land at the track end (the
                          // cap) instead of running off-canvas — usage stays legible, the exact limit is on hover.
                          const usePx = Math.max(1, Math.min(b.use * bs, baseline))
                          const reqPx = b.req !== undefined ? Math.min(b.req * bs, baseline) : undefined
                          const limPx = b.lim !== undefined ? Math.min(b.lim * bs, baseline) : undefined
                          const withinW = b.over && reqPx !== undefined ? reqPx : usePx
                          return (
                            <g
                              class="cap-bullet"
                              classList={{ faded: capSegFaded(b.node), selected: b.node.id === props.selectedId }}
                              onClick={(e) => { e.stopPropagation(); props.onSelect(b.node.id) }}
                              onPointerMove={(e) => { setCapHover(b.node.id); showTip(tipFromSeg(b), e) }}
                              onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                            >
                              {/* Faint baseline to the pod's furthest marker, so req/limit ticks beyond
                                  the usage bar still have something to sit on. */}
                              <line class="cap-bullet-base" x1={b.x} y1={b.y + b.height / 2} x2={b.x + baseline} y2={b.y + b.height / 2} />
                              <rect
                                class="cap-bullet-fill"
                                classList={{ [`h-${b.node.health.toLowerCase()}`]: true }}
                                x={b.x}
                                y={b.y}
                                width={withinW}
                                height={b.height}
                                rx="2"
                              />
                              <Show when={b.over && reqPx !== undefined}>
                                <rect class="cap-bullet-over" x={b.x + reqPx!} y={b.y} width={Math.max(0, usePx - reqPx!)} height={b.height} />
                              </Show>
                              <Show when={reqPx !== undefined}>
                                <line class="cap-tick req" x1={b.x + reqPx!} y1={b.y - 1} x2={b.x + reqPx!} y2={b.y + b.height + 1} />
                              </Show>
                              <Show when={limPx !== undefined}>
                                <line class="cap-tick lim" x1={b.x + limPx!} y1={b.y - 1} x2={b.x + limPx!} y2={b.y + b.height + 1} />
                              </Show>
                              <text class="cap-bullet-name" x={b.x + baseline + 8} y={b.y + 14}>{b.node.name}</text>
                            </g>
                          )
                        }}
                      </For>
                      {/* Folded "other namespaces" bullet — one gray row standing in for every pod
                          outside this namespace, hoverable for its totals, not individually selectable. */}
                      <Show when={row.otherBullet}>
                        {(o) => (
                          <g
                            class="cap-bullet other"
                            classList={{ faded: capAggFaded(`other:${row.host}`) }}
                            onPointerMove={(e) => { setCapHover(`other:${row.host}`); showTip(tipFromAgg(o()), e) }}
                            onPointerLeave={() => { setCapHover(null); setCapTip(null) }}
                          >
                            <line class="cap-bullet-base" x1={o().x} y1={o().y + o().height / 2} x2={o().x + o().width} y2={o().y + o().height / 2} />
                            <rect class="cap-bullet-fill" x={o().x} y={o().y} width={o().width} height={o().height} rx="2" />
                            <text class="cap-bullet-name" x={o().x + o().width + 8} y={o().y + 14}>
                              other namespaces · {o().count} pod{o().count === 1 ? '' : 's'}
                            </text>
                          </g>
                        )}
                      </Show>
                    </g>
                  )
                }}
              </For>
            </g>
          </Show>
          {/* All view: a faint kind label sits above each kind group, so the eye can sweep
              "Pods here, Services there" without inferring it from card text. Underlay only —
              no interactivity; cards above remain selectable normally. */}
          <Show when={groups().length > 0}>
            <g class="kind-groups">
              <For each={groups()}>
                {(g) => (
                  <g
                    class="kind-group"
                    classList={{
                      'kind-pod': g.kind === 'Pod',
                      // Fade the whole kind group (label + bg + cards) when a kind filter is
                      // active and this kind isn't in it — otherwise the bg rect + label stay
                      // opaque while cards inside fade, which reads as a stale leftover.
                      faded: !!activeKinds() && !activeKinds()!.has(g.kind),
                      'kind-group-interactive': !!props.onKindFilter,
                    }}
                    // Cycle 276: clicking a kind group's bg/label solos that kind in the filter,
                    // matching Shift+click on the kind chip. Faster than scanning the chip row when
                    // the operator is already looking at the "All view" cluster they want to focus on.
                    onClick={(e) => {
                      if ((e.target as Element).closest?.('.node')) return // a card click takes priority
                      props.onKindFilter?.(g.kind, true)
                    }}
                  >
                    {/* Subtle background rect behind the whole kind group (label + cards) gives the
                        grouping a tactile container so kind boundaries read spatially, not just via
                        spacing. Drawn before the icon and label so it's the underlay. */}
                    <rect
                      class="kind-group-bg"
                      x={g.x - 10}
                      y={g.y - 6}
                      width={g.width + 20}
                      height={g.height + 16}
                      rx="8"
                    />
                    {/* A 12px kind icon at the label's y-baseline (icon is 14×14 in viewBox space;
                        translate so it centers vertically on the text baseline). */}
                    <g class="kind-group-icon" transform={`translate(${g.x}, ${g.y + 1}) scale(0.86)`}>
                      {kindIcon(g.kind)}
                    </g>
                    <text class="kind-group-label" x={g.x + 16} y={g.y + 14}>
                      {g.kind} <tspan class="kind-group-count">{props.nodes.filter((n) => n.kind === g.kind).length}</tspan>
                    </text>
                  </g>
                )}
              </For>
            </g>
          </Show>
          {/* Connectivity views: a grouping frame around each collapse cluster (visible siblings +
              pill), so a fold reads as one unit the pill folds/unfolds. Drawn under the cards as a
              dashed underlay; expanded frames get a solid-ish accent so "this block is unfolded"
              is obvious at a glance. Empty for All/Nodes (their kind/host boxes already group). */}
          <Show when={connFrames().length > 0}>
            <g class="conn-frames">
              <For each={connFrames()}>
                {(f) => (
                  <rect
                    class="conn-frame"
                    classList={{ expanded: f.expanded }}
                    x={f.x}
                    y={f.y}
                    width={f.width}
                    height={f.height}
                    rx="11"
                  />
                )}
              </For>
            </g>
          </Show>
          <g class="edges">
            <For each={renderedEdges()}>
              {(e) => (
                <g
                  // Hovering anywhere on the edge halos both endpoint cards (cycle 330/R4). The hit
                  // target is the wide transparent companion path below, since the visible 1-2px line
                  // is nearly impossible to hover in a dense graph.
                  onPointerEnter={() => setHoverEnds({ from: e.from, to: e.to })}
                  onPointerLeave={() => setHoverEnds(null)}
                >
                  {/* <title> on the path makes hover reveal the relationship type. */}
                  <title>{edgeTitle(e, props.nodes)}</title>
                  <path class="edge-hit" d={edgePath(e.points)} fill="none" stroke="transparent" stroke-width="10" />
                  <path
                    classList={{ faded: edgeFaded(e), adjacent: edgeAdjacent(e), owner: e.type === 'ownerReference' }}
                    d={edgePath(e.points)}
                    fill="none"
                    stroke="var(--edge-color)"
                    stroke-width={e.type === 'ownerReference' ? 1.8 : 1.2}
                    stroke-dasharray={DASHED[e.type] ? '5 4' : undefined}
                    marker-end="url(#arrow)"
                  />
                </g>
              )}
            </For>
          </g>
          <g class="nodes">
            {/* Render layout().nodes + exiting() so removed cards keep their last-known position
                while fading out — operators see "what left" rather than a card vanishing. The Nodes
                group-by draws its own bar visualization above (cap-view), so the card renderer is
                skipped there — its layout().nodes are segment hit-boxes, not cards. */}
            <For each={props.groupBy === 'nodes' ? [] : [...layout().nodes, ...exiting()]}>
              {(n) => (
                <Show
                  when={n.collapse}
                  fallback={
                <g
                  class="node"
                  classList={{
                    selected: n.id === props.selectedId,
                    faded: nodeFaded(n),
                    // Endpoint of the hovered edge (cycle 330/R4): a transient accent halo.
                    target: edgeEndpoint(n.id),
                    exiting: exitingIds().has(n.id),
                    [`h-${n.health.toLowerCase()}`]: true,
                    // Pod kind gets a CSS hook for the accent treatment (cycle 202): pods are the
                    // fundamental workload, so they read distinct from their controllers/services
                    // even before the operator focuses on the card.
                    'kind-pod': n.kind === 'Pod',
                  }}
                  /* CSS transform (not the SVG attribute) so browsers can transition position
                     changes — when SSE patches shift the Dagre layout, cards glide to their new
                     spots instead of teleporting. See .node { transition: transform … } in CSS. */
                  style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                  /* Cycle 298: clicking the already-selected card deselects (mirrors how the legend
                     pills and kind chips toggle on a repeat click). Cycle 315: the toggle-OFF is
                     deferred a beat so a double-click can cancel it — otherwise double-clicking a
                     card (a natural "focus this" gesture) ran select(click1)→deselect(click2) and
                     left nothing selected. Selecting stays immediate; only deselect waits. */
                  onClick={() => {
                    if (n.id === props.selectedId && props.onDeselect) {
                      clearTimeout(cardClickTimer)
                      cardClickTimer = setTimeout(() => props.onDeselect?.(), 220)
                    } else {
                      props.onSelect(n.id)
                    }
                  }}
                  onDblClick={() => {
                    // Cancel the pending deselect from this double-click's second click, and make
                    // sure the card ends up selected + framed (selection-fit runs on select).
                    clearTimeout(cardClickTimer)
                    props.onSelect(n.id)
                  }}
                >
                  {/* Hover tooltip: a compact "everything on the card + a little more" view, so
                      a tightly-truncated card in a zoomed-out graph still reveals the full name,
                      age, host (pods), and restart count without selecting it. */}
                  <title>{cardTitle(n, now())}</title>
                  <rect class="node-bg" width={n.width} height={n.height} rx="9" />
                  {/* Cycle 163: a faint white-to-transparent strip across the top of the card
                      gives the surface a subtle "glass tile" highlight (more pronounced on the
                      tinted non-healthy cards). Drawn at 1.5px below the bg's top border so it
                      tucks inside the rounded corners. */}
                  <rect class="node-glaze" x="1.5" y="1.5" width={n.width - 3} height={Math.min(20, n.height / 3)} rx="7.5" />
                  {/* Icon-forward card (cycle 126): a 28×28 kind silhouette anchors the left column
                      and a small uppercase kind label sits under it; the right column lays name,
                      status and the restart/age badge on their own rows so nothing competes for
                      width. Health is carried by the .node-bg border + tint (see CSS), so a colored
                      stripe is redundant and was removed to reclaim left padding for the icon. */}
                  {/* Optically-centered icon (cycle 306): a full-box glyph inks ~y14–34, i.e. ~2px
                      above the card's geometric center (y30). Geometric centering (cycle 305) measured
                      dead-on but *looked* bottom-heavy because the kind label hangs below with empty
                      space above — an icon with a caption beneath has to ride slightly high to read as
                      centered. The label tucks ~3px under the glyph. */}
                  <g class="node-icon node-icon-large" transform="translate(10,12) scale(2)">
                    {kindIcon(n.kind)}
                  </g>
                  <text class="node-kind" x="24" y="49" text-anchor="middle">
                    {cardKindLabel(n.kind)}
                  </text>
                  <text class="node-name" x="46" y="32">
                    {label(n)}
                  </text>
                  <Show when={n.status}>
                    <text class="node-status" x={n.width - 12} y="17" text-anchor="end" fill={healthColor(n.health)}>
                      {cardStatus(n.status!)}
                    </text>
                  </Show>
                  <Show when={rightBadge(n)}>
                    <text class="node-restarts" x={n.width - 12} y="50" text-anchor="end">
                      {rightBadge(n)}
                    </text>
                  </Show>
                </g>
                  }
                >
                  {/* Two-way collapse pill: a ghost card that folds/unfolds the extra same-kind
                      resources. Collapsed it reads "+ show N more" and expands the cluster; expanded
                      it reads "− show N fewer" and refolds it (one affordance, both directions —
                      "older" is deliberately not surfaced). A "● N match" badge appears only while
                      collapsed, when the fold hides a search or health-filter result (D7) — expanded,
                      those cards are already shown. */}
                  {(meta) => (
                    <g
                      class="collapse-pill"
                      classList={{
                        faded: !!activeKinds() && !activeKinds()!.has(meta().groupKind),
                        expanded: meta().expanded,
                      }}
                      style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                      onClick={() => toggleCluster(meta().key)}
                    >
                      <title>
                        {meta().expanded
                          ? `Show ${meta().hidden.length} fewer ${meta().groupKind}${meta().hidden.length === 1 ? '' : 's'}`
                          : `Show ${meta().hidden.length} more ${meta().groupKind}${meta().hidden.length === 1 ? '' : 's'}`}
                      </title>
                      <rect class="collapse-pill-bg" width={n.width} height={n.height} rx="9" />
                      <Show
                        when={!meta().expanded}
                        fallback={
                          <text class="collapse-pill-label" x={n.width / 2} y="35" text-anchor="middle">
                            − show {meta().hidden.length} fewer
                          </text>
                        }
                      >
                        <text
                          class="collapse-pill-label"
                          x={n.width / 2}
                          y={collapseMatchCount(meta()) > 0 ? 24 : 35}
                          text-anchor="middle"
                        >
                          + show {meta().hidden.length} more
                        </text>
                        <Show when={collapseMatchCount(meta()) > 0}>
                          <text class="collapse-pill-match" x={n.width / 2} y="46" text-anchor="middle">
                            ● {collapseMatchCount(meta())} match
                          </text>
                        </Show>
                      </Show>
                    </g>
                  )}
                </Show>
              )}
            </For>
          </g>
        </g>
      </svg>
      {/* Bottom-left count overlay: at-a-glance namespace size, plus the active-filter subset
          when one is active ("4 of 23"). Active filters compose (search ∩ health ∩ kinds), so
          the count reflects what's actually lit on the canvas. Hidden when the canvas is empty —
          the empty-state already covers the message. */}
      <Show when={props.nodes.length > 0}>
        <div class="topology-count" aria-live="polite" aria-atomic="true">
          <Show
            when={matches() || props.healthFilter || activeKinds()}
            fallback={
              <>
                {props.nodes.length} resource{props.nodes.length === 1 ? '' : 's'}
                {/* Per-grouping summary (cycle 231): Kind grouping shows the kind count, Nodes
                    grouping shows the host count — each surfaces the dimension that grouping
                    actually exposes, so "is this dense?" reads without parsing the canvas. */}
                <Show when={props.groupBy === 'kind' && groups().length > 1}>
                  {' '}· {groups().length} kinds
                </Show>
                <Show when={props.groupBy === 'nodes' && capRows().length > 0}>
                  {' '}· {capRows().length} node{capRows().length === 1 ? '' : 's'}
                </Show>
              </>
            }
          >
            {layout().nodes.filter((n) => !nodeFaded(n)).length} of {props.nodes.length}
            {/* The bare "M of N" is clear visually but ambiguous read aloud; this sr-only suffix
                gives the polite live announcement a noun as the filter narrows the canvas. */}
            <span class="sr-only"> resources shown</span>
          </Show>
        </div>
      </Show>
      {/* Hide the Fit button when there's nothing on canvas — it would just trigger a no-op against
          an empty layout, and the empty-state copy already explains what to do. */}
      <Show when={props.nodes.length > 0}>
      <button class="topology-fit" onClick={resetView} title="Fit to view (f)">
        {/* Tiny "fit corners" glyph: four L-corners around an implied frame so the button reads
            as "frame the canvas" even before the eye lands on the word. */}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M 1 4 L 1 1 L 4 1 M 8 1 L 11 1 L 11 4 M 11 8 L 11 11 L 8 11 M 4 11 L 1 11 L 1 8" />
        </svg>
        Fit
      </button>
      </Show>
      {/* Capacity-bar hover tooltip (item: Grafana-style panels). A fixed-position HTML card that
          follows the cursor while hovering a pod segment/bullet, showing the pod's full identity and
          its usage vs request vs limit at a glance. Offset from the cursor and pointer-events:none so
          it never eats the hover. */}
      <Show when={capTip()}>
        {(t) => {
          const d = () => t().d
          const fmt = (v: number | undefined) => formatQuantity(v, capResource())
          return (
            <div class="cap-tooltip" style={{ left: `${t().x + 14}px`, top: `${t().y + 14}px` }}>
              <div class="cap-tooltip-name">{d().title}</div>
              <div class="cap-tooltip-sub">{d().sub}</div>
              <div class="cap-tooltip-rows">
                <div><span>Usage</span><b>{fmt(d().use)}</b></div>
                <div><span>Request</span><b>{d().req !== undefined ? fmt(d().req) : '—'}</b></div>
                <Show when={d().lim !== undefined || (!d().over && !d().near)}>
                  <div><span>Limit</span><b>{d().lim !== undefined ? fmt(d().lim) : '—'}</b></div>
                </Show>
              </div>
              <Show when={d().over || d().near}>
                <div class="cap-tooltip-flags">
                  <Show when={d().over}><span class="cap-flag over">bursting over request</span></Show>
                  <Show when={d().near}><span class="cap-flag near">near limit</span></Show>
                </div>
              </Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
