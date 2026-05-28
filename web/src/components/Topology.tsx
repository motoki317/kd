import { createMemo, createSignal, For, Show, createEffect, on, onCleanup } from 'solid-js'
import { kindGroups, layoutGraph, layoutGraphByKind, type Point } from '../layout'
import { edgeKey } from '../graphState'
import { healthColor } from '../health'
import { cardName, cardStatus, kindShortLabel } from '../names'
import { nodeMatches } from '../search'
import { kindIcon } from '../icons'
import { relativeAge } from '../time'
import type { EdgeType, KEdge, KNode } from '../types'

interface Props {
  nodes: KNode[]
  edges: KEdge[]
  selectedId: string | null
  healthFilter?: import('../types').Health | null
  connected: boolean
  viewLabel: string
  // viewId is the lower-case view key — Topology switches layout strategy on 'all' to use
  // the kind-grouped variant (FR-006). All other views fall back to the default
  // connectivity-based layout.
  viewId?: import('../types').View
  search: string
  onSearch: (q: string) => void
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
  const layout = createMemo(() =>
    props.viewId === 'all'
      ? layoutGraphByKind(props.nodes, props.edges)
      : layoutGraph(props.nodes, props.edges),
  )
  // In the All view we draw a faint kind-label band above each kind box so the operator can
  // scan "this section is all Pods, that's all Services" without inferring it from card kinds.
  const groups = createMemo(() => (props.viewId === 'all' ? kindGroups(layout()) : []))

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
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const e of layout().edges) {
        const k = edgeKey(e)
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
    const m = new Set<string>()
    for (const n of layout().nodes) {
      if (nodeMatches(n, q)) m.add(n.id)
    }
    return m
  })

  // Fade precedence: search query > legend health filter > selection neighbors; only a bare
  // selection lights its edges accent.
  const nodeFaded = (n: { id: string; health: string }) => {
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
    const r = related()
    return r ? !r.edges.has(edgeKey(e)) : false
  }
  const edgeAdjacent = (e: KEdge) => !matches() && !props.healthFilter && (related()?.edges.has(edgeKey(e)) ?? false)

  const [scale, setScale] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  let svg: SVGSVGElement | undefined
  let pointerDown = false
  let dragging = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0

  // Smoothly animate viewport (tx/ty/scale) to a target over ~360ms with easeOutCubic.
  // Replaces the prior "snap-instantly" updates so namespace/view switches and selection focus
  // changes glide instead of jumping — easier for a human to track what just changed.
  let animFrame = 0
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
  onCleanup(() => cancelAnimationFrame(animFrame))

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
        const xs = inSet.flatMap((n) => [n.x - n.width / 2, n.x + n.width / 2])
        const ys = inSet.flatMap((n) => [n.y - n.height / 2, n.y + n.height / 2])
        const target = computeFitFor(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1.6)
        animateTo(target)
      },
      { defer: true },
    ),
  )

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
      setTx(tx() - e.deltaX)
      setTy(ty() - e.deltaY)
    }
  }

  // Pan only after the pointer moves past a small threshold, so a plain click still reaches a
  // node's onClick (capturing the pointer on press would redirect the click to the SVG).
  function onPointerDown(e: PointerEvent) {
    pointerDown = true
    dragging = false
    startX = lastX = e.clientX
    startY = lastY = e.clientY
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
    }
    lastX = e.clientX
    lastY = e.clientY
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
    // Cycle 161: a click on the topology background (not on a card and not a pan) dismisses the
    // open drawer. Walk up from the click target — if any ancestor has the .node class, it was a
    // card click (its own onClick will run); otherwise treat as a background click.
    if (wasDragging || !props.onDeselect || !props.selectedId) return
    let el: Element | null = e.target as Element | null
    while (el && el !== svg) {
      if ((el as Element).classList?.contains('node')) return
      el = el.parentElement
    }
    props.onDeselect()
  }

  function resetView() {
    const l = layout()
    if (!svg || l.width === 0) return
    const target = computeFitFor(0, 0, l.width, l.height, 1.4)
    target.scale *= 0.92
    animateTo(target)
  }

  return (
    <div class="topology">
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
            {props.connected ? `Nothing to show in the ${props.viewLabel} view.` : 'Connecting…'}
          </div>
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
            placeholder="Search resources…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          <Show when={query()}>
            <button class="topology-search-clear" onClick={() => setQuery('')} title="Clear (Esc)">
              ×
            </button>
          </Show>
        </div>
        <Show when={matches()}>
          <span class="topology-matches" classList={{ none: matches()!.size === 0 }}>
            {matches()!.size === 0 ? 'no matches' : `${matches()!.size} match${matches()!.size === 1 ? '' : 'es'}`}
          </span>
        </Show>
      </div>
      <svg
        ref={svg}
        class="topology-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
          {/* All view: a faint kind label sits above each kind group, so the eye can sweep
              "Pods here, Services there" without inferring it from card text. Underlay only —
              no interactivity; cards above remain selectable normally. */}
          <Show when={groups().length > 0}>
            <g class="kind-groups">
              <For each={groups()}>
                {(g) => (
                  <g class="kind-group">
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
                <g>
                  {/* <title> on the path makes hover reveal the relationship type. Wrap in <g>
                      so a future hover affordance (highlight on hover, click-to-select endpoints)
                      can hang off the same element without churning this tree. */}
                  <title>{edgeTitle(e, props.nodes)}</title>
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
                    exiting: exitingIds().has(n.id),
                    [`h-${n.health.toLowerCase()}`]: true,
                  }}
                  /* CSS transform (not the SVG attribute) so browsers can transition position
                     changes — when SSE patches shift the Dagre layout, cards glide to their new
                     spots instead of teleporting. See .node { transition: transform … } in CSS. */
                  style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                  onClick={() => props.onSelect(n.id)}
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
                  {/* Tightened icon+kind unit (cycle 158): icon at y=5, kind label at y=43 sits
                      directly under the icon's bottom (y=33) with a 3px gap — was a 30px chasm.
                      Card height dropped 72→60 to drop the dead space below the kind label too. */}
                  <g class="node-icon node-icon-large" transform="translate(10,5) scale(2)">
                    {kindIcon(n.kind)}
                  </g>
                  <text class="node-kind" x="24" y="43" text-anchor="middle">
                    {kindShortLabel(n.kind)}
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
      {/* Bottom-left count overlay: at-a-glance namespace size, plus the search/health filter
          subset when one is active ("4 of 23"). Hidden when the canvas is empty (the empty-state
          message there already covers it). */}
      <Show when={props.nodes.length > 0}>
        <div class="topology-count">
          <Show
            when={matches() || props.healthFilter}
            fallback={
              <>
                {props.nodes.length} resources
                {/* In the All view, append "· K kinds" so the operator can see the breadth
                    of what's loaded at a glance — useful when CRDs bring dozens of new kinds. */}
                <Show when={props.viewId === 'all' && groups().length > 1}>
                  {' '}· {groups().length} kinds
                </Show>
              </>
            }
          >
            {(matches()?.size ?? props.nodes.filter((n) => n.health === props.healthFilter).length)} of {props.nodes.length}
          </Show>
        </div>
      </Show>
      <button class="topology-fit" onClick={resetView} title="Fit to view">
        {/* Tiny "fit corners" glyph: four L-corners around an implied frame so the button reads
            as "frame the canvas" even before the eye lands on the word. */}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M 1 4 L 1 1 L 4 1 M 8 1 L 11 1 L 11 4 M 11 8 L 11 11 L 8 11 M 4 11 L 1 11 L 1 8" />
        </svg>
        Fit
      </button>
    </div>
  )
}
