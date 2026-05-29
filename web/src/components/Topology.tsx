import { createMemo, createSignal, For, Show, createEffect, on, onCleanup, onMount } from 'solid-js'
import { hostGroups, kindGroups, layoutGraph, layoutGraphByHost, layoutGraphByKind, type Point } from '../layout'
import { edgeKey } from '../graphState'
import { healthColor, healthSeverity } from '../health'
import { orderedForNav } from '../nav'
import { cardKindLabel, cardName, cardStatus, kindShortLabel } from '../names'
import { nodeMatches } from '../search'
import { kindIcon } from '../icons'
import { relativeAge } from '../time'
import type { EdgeType, Health, KEdge, KNode } from '../types'

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
  connected: boolean
  viewLabel: string
  // viewHint is the "what this view shows" tagline, displayed in the empty state so the operator
  // knows what a view *would* show before the namespace fills out (cycle 204).
  viewHint?: string
  // onClearFilters clears every active filter at once (search + health + kinds). Optional —
  // when omitted, the chip row's individual clears stay the only way to reset.
  onClearFilters?: () => void
  // viewId is the lower-case view key — Topology switches layout strategy on 'all' to use
  // the kind-grouped variant (FR-006). All other views fall back to the default
  // connectivity-based layout.
  viewId?: import('../types').View
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
// references) joins the dashed family — it's a relationship but not the ownership backbone.
const DASHED: Partial<Record<EdgeType, boolean>> = {
  selects: true,
  routes: true,
  mounts: true,
  usesServiceAccount: true,
  binds: true,
  scheduledOn: true,
  refers: true,
}

function edgePath(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ')
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

function nodeLabel(n: KNode): string {
  const ns = n.namespace ? `${n.namespace}/` : ''
  return `${n.kind} ${ns}${n.name}`
}

function edgeTitle(e: KEdge, nodes: KNode[]): string {
  const fromN = nodes.find((n) => n.id === e.from)
  const toN = nodes.find((n) => n.id === e.to)
  const fromS = fromN ? nodeLabel(fromN) : e.from
  const toS = toN ? nodeLabel(toN) : e.to
  return `${fromS} ${EDGE_LABELS[e.type]} ${toS}`
}

export default function Topology(props: Props) {
  const layout = createMemo(() => {
    if (props.viewId === 'all') return layoutGraphByKind(props.nodes, props.edges)
    // Nodes view: each host becomes a labeled container with the Node card + its pods inside.
    // scheduledOn edges are implied by containment, so the layout doesn't draw them — cuts the
    // visual noise of N identical lines to the same Node card (cycle 205).
    if (props.viewId === 'nodes') return layoutGraphByHost(props.nodes, props.edges)
    // Volumes view: left-to-right so "Pod mounts ConfigMap/Secret/PVC" reads as a left→right
    // dependency flow rather than a top-down ownership tree (cycle 206). Same renderer, just
    // a different Dagre rankdir per connected component.
    if (props.viewId === 'volumes') return layoutGraph(props.nodes, props.edges, 'LR')
    // Network view (cycle 207): Ingress → Service → Pod is a traffic flow, naturally read
    // left-to-right (external → routing → workload). LR rankdir keeps the visual metaphor
    // aligned with how an operator already thinks about ingress traffic.
    if (props.viewId === 'network') return layoutGraph(props.nodes, props.edges, 'LR')
    // RBAC view (cycle 207): RoleBinding → Role is a "binds" arrow; subjects are listed inside
    // the binding card. LR keeps "binding → role" reading the way the relationship does.
    if (props.viewId === 'rbac') return layoutGraph(props.nodes, props.edges, 'LR')
    // Ownership view (cycle 310): left-to-right like the other relationship views. A card is far
    // wider than it is tall, so a parent's children read better stacked in a vertical column to the
    // right (LR) than strung across a horizontal rank (TB), which wasted width and forced more
    // zoom-out. High-fanout hubs (ReplicaSet→pods, Node→pods) still grid-wrap — the wrap is now
    // orientation-aware (see layout.ts placeLeavesLR), so a 30-replica Deployment stays compact
    // instead of becoming a 30-tall single-file column.
    return layoutGraph(props.nodes, props.edges, 'LR')
  })
  // In the All view we draw a faint kind-label band above each kind box so the operator can
  // scan "this section is all Pods, that's all Services" without inferring it from card kinds.
  const groups = createMemo(() => (props.viewId === 'all' ? kindGroups(layout()) : []))
  // Nodes view: per-host group bounding boxes for the host-container bg rect + header label.
  const hosts = createMemo(() => (props.viewId === 'nodes' ? hostGroups(layout()) : []))
  // Pod count per host, used in the host-group header chip — derived once to keep the SVG
  // markup clean (the alternative is an inline expression that has to re-derive the orphan
  // bucket condition every render). The orphan host bucket counts pods that have either no
  // host string or a host with no matching Node card in the current graph.
  const podsPerHost = createMemo<Record<string, number>>(() => {
    const c: Record<string, number> = {}
    const nodeNames = new Set(props.nodes.filter((n) => n.kind === 'Node').map((n) => n.name))
    for (const n of props.nodes) {
      if (n.kind !== 'Pod') continue
      const key = n.host && nodeNames.has(n.host) ? n.host : '__orphan__'
      c[key] = (c[key] ?? 0) + 1
    }
    return c
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
    const removed = prevPositioned.filter((n) => !curIds.has(n.id) && !exitTimers.has(n.id))
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

  // Map each node to its owner's name, so children render relative to their parent in the tree.
  const ownerName = createMemo(() => {
    const nameById = new Map(props.nodes.map((n) => [n.id, n.name]))
    const m = new Map<string, string>()
    for (const e of props.edges) {
      if (e.type === 'ownerReference' && nameById.has(e.from)) m.set(e.to, nameById.get(e.from)!)
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

  // When a node is selected, walk its full connected component (edges treated as undirected) so
  // the entire ownership/relationship tree containing the selection stays lit while everything
  // else fades out — ArgoCD-style focus on "this resource and what relates to it". Cycle 157
  // promoted this from immediate-neighbors to full-component because the auto-fit (below) targets
  // the same set: clicking a Pod should frame Deployment+ReplicaSet+Pod, not just the parent edge.
  const related = createMemo(() => {
    const id = props.selectedId
    if (!id) return null
    const nodes = new Set<string>([id])
    const edges = new Set<string>()
    const queue = [id]
    // Walk the unrouted props.edges (the streamed view's full edge set), not layout().edges —
    // layouts like Nodes view drop edges from rendering (containment carries them), but
    // selecting a pod should still light its Node and siblings (cycle 226 fix).
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const e of props.edges) {
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
    for (const n of layout().nodes) {
      const s = stats.get(n.kind)
      if (!s) {
        stats.set(n.kind, { count: 1, worst: n.health !== 'Healthy' ? n.health : null })
        continue
      }
      s.count++
      if (n.health !== 'Healthy' && (s.worst === null || healthSeverity[n.health] > healthSeverity[s.worst])) {
        s.worst = n.health
      }
    }
    return stats
  })
  const kindChips = createMemo(() =>
    [...kindStats().entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([k, s]) => ({ kind: k, count: s.count, worst: s.worst })),
  )
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
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY)
    const padding = 60
    const s = Math.min((rect.width - padding * 2) / w, (rect.height - padding * 2) / h, maxScale)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    return { scale: s, tx: rect.width / 2 - cx * s, ty: rect.height / 2 - cy * s }
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

  // Fit-all on namespace/view switch (big shape changes). Tracks a key so an SSE patch that
  // changes node positions slightly doesn't re-fit and yank the viewport away from where the user
  // panned. First mount is a snap (no animation); subsequent fits glide.
  let lastFitKey = ''
  let firstFit = true
  createEffect(() => {
    const l = layout()
    const key = `${l.width}x${l.height}x${l.nodes.length}`
    if (!svg || l.width === 0 || key === lastFitKey) return
    lastFitKey = key
    if (props.selectedId) return // selection-fit takes precedence; don't double-animate
    const target = computeFitFor(0, 0, l.width, l.height, 1.4)
    target.scale *= 0.92
    if (firstFit) {
      firstFit = false
      setScale(target.scale)
      setTx(target.tx)
      setTy(target.ty)
    } else {
      animateTo(target)
    }
  })

  // Track SVG size so resizes re-center the canvas (cycle 294). Drawer open/close and window
  // resizes both squeeze/grow the SVG; without this the existing pan stays at old coords and the
  // graph drifts off-screen. Only re-fits when there's no user-driven pan in progress AND there's
  // no selection — selection-fit already handles that case. Debounce via rAF so a continuous
  // resize (window drag) doesn't fight the animation. Guarded for jsdom (no ResizeObserver).
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
        const target = computeFitFor(0, 0, l.width, l.height, 1.4)
        target.scale *= 0.92
        // Snap, not animate: a resize is a viewport change, not a user-initiated transition, so
        // sliding would feel sluggish during a window drag.
        setScale(target.scale)
        setTx(target.tx)
        setTy(target.ty)
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
  // Selection cleared → glide back to fit-all so the dashboard re-orients without a jolt.
  createEffect(
    on(
      () => props.selectedId,
      (id) => {
        if (!svg) return
        const l = layout()
        if (l.width === 0) return
        if (!id) {
          animateTo({ ...computeFitFor(0, 0, l.width, l.height, 1.4), }) // glide back to fit-all
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
      if ((el as Element).classList?.contains('node')) return
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
      if ((el as Element).classList?.contains('node')) return
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
              Nothing to show in the {props.viewLabel} view.
            </Show>
          </div>
          {/* When the canvas is empty but the stream is live, surface the view's "what this view
              shows" hint so the operator learns the view's purpose instead of bouncing between
              views to deduce it. Hidden while connecting (the line above carries the message). */}
          <Show when={props.connected && props.viewHint}>
            <div class="topology-empty-hint">{props.viewHint}</div>
          </Show>
        </div>
      </Show>
      <div class="topology-search">
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
        {/* Kind filter chips (cycle 203): one chip per kind present in the current view. Click
            toggles the kind in/out of the active set; multi-select composes with search and the
            legend health filter. Hidden when only one kind is present (no filter would do
            anything). Each chip carries the same monochrome silhouette as its cards, so the
            chip row reads as a compact legend of "what kinds are here". */}
        <Show when={kindChips().length > 1 && props.onKindFilter}>
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
          {/* Separate arrowhead for 'refers' edges so the head color matches the violet body
              instead of inheriting the grey --edge-color. */}
          <marker id="arrow-refers" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-refers)" />
          </marker>
        </defs>
        <g transform={`translate(${tx()},${ty()}) scale(${scale()})`}>
          {/* Nodes view: each host's container rect + "host: <name>" header, drawn under the
              cards so the cards sit on top. Mirrors the kind-groups treatment in All view —
              backdrop + label + tiny server-rack icon — so the two grouped views share a visual
              language. */}
          <Show when={hosts().length > 0}>
            <g class="host-groups">
              <For each={hosts()}>
                {(h) => (
                  <g class="host-group">
                    <rect
                      class="host-group-bg"
                      x={h.x - 10}
                      y={h.y - 6}
                      width={h.width + 20}
                      height={h.height + 16}
                      rx="8"
                    />
                    {/* Small server-rack glyph echoes the [cluster] icon in the sidebar — the
                        operator recognizes it as "this is a host" without reading the label. */}
                    <svg class="host-group-icon" x={h.x - 1} y={h.y + 1} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                      <rect x="1" y="2.5" width="10" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
                      <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.2" />
                    </svg>
                    <text class="host-group-label" x={h.x + 16} y={h.y + 14}>
                      {h.label}
                      {/* Pod count at a glance: lighter weight + tabular nums, separated by a
                          middle-dot so a long host name + count still reads as one label. */}
                      <tspan class="host-group-count">
                        {' '}· {(podsPerHost()[h.host] ?? 0) === 0
                          ? 'no pods'
                          : `${podsPerHost()[h.host]} pod${podsPerHost()[h.host] === 1 ? '' : 's'}`}
                      </tspan>
                    </text>
                  </g>
                )}
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
          <g class="edges">
            <For each={layout().edges}>
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
                    stroke={e.type === 'refers' ? 'var(--edge-refers)' : 'var(--edge-color)'}
                    stroke-width={e.type === 'ownerReference' ? 1.8 : 1.2}
                    stroke-dasharray={DASHED[e.type] ? '5 4' : undefined}
                    marker-end={e.type === 'refers' ? 'url(#arrow-refers)' : 'url(#arrow)'}
                  />
                </g>
              )}
            </For>
          </g>
          <g class="nodes">
            {/* Render layout().nodes + exiting() so removed cards keep their last-known position
                while fading out — operators see "what left" rather than a card vanishing. */}
            <For each={[...layout().nodes, ...exiting()]}>
              {(n) => (
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
                {/* Per-view summary (cycle 231): All shows kind count, Nodes shows hosts +
                    pods, Volumes shows pods + mounts, Network shows ingress/service/pod
                    counts. Each summary surfaces the dimension the view actually exposes —
                    "is this view dense?" without parsing the canvas. */}
                <Show when={props.viewId === 'all' && groups().length > 1}>
                  {' '}· {groups().length} kinds
                </Show>
                <Show when={props.viewId === 'nodes' && hosts().length > 0}>
                  {' '}· {hosts().length} host{hosts().length === 1 ? '' : 's'}
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
    </div>
  )
}
