import { createMemo, createSignal, For, Show, createEffect, on, onCleanup } from 'solid-js'
import { layoutGraph, type Point } from '../layout'
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
  search: string
  onSearch: (q: string) => void
  onSelect: (id: string) => void
}

// Edges other than ownership are drawn dashed so the parent-child backbone stays visually
// dominant (the primary relationship operators scan for first).
const DASHED: Partial<Record<EdgeType, boolean>> = {
  selects: true,
  routes: true,
  mounts: true,
  usesServiceAccount: true,
  binds: true,
  scheduledOn: true,
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
}

function edgeTitle(e: KEdge, nodes: KNode[]): string {
  const fromN = nodes.find((n) => n.id === e.from)
  const toN = nodes.find((n) => n.id === e.to)
  const fromS = fromN ? `${fromN.kind} ${fromN.name}` : e.from
  const toS = toN ? `${toN.kind} ${toN.name}` : e.to
  return `${fromS} ${EDGE_LABELS[e.type]} ${toS}`
}

export default function Topology(props: Props) {
  const layout = createMemo(() => layoutGraph(props.nodes, props.edges))

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

  // When a node is selected, compute its neighbors and incident edges so the rest of the graph can
  // fade out — focusing attention on what actually relates to the selection (ArgoCD-style). Null
  // when nothing is selected, so the whole graph renders at full strength.
  const related = createMemo(() => {
    const id = props.selectedId
    if (!id) return null
    const nodes = new Set<string>([id])
    const edges = new Set<string>()
    for (const e of layout().edges) {
      if (e.from === id || e.to === id) {
        nodes.add(e.from)
        nodes.add(e.to)
        edges.add(edgeKey(e))
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

  // Fit the graph into view whenever its size changes (namespace/view switch, big deltas).
  let lastFitKey = ''
  createEffect(() => {
    const l = layout()
    const key = `${l.width}x${l.height}x${l.nodes.length}`
    if (!svg || l.width === 0 || key === lastFitKey) return
    lastFitKey = key
    const rect = svg.getBoundingClientRect()
    const s = Math.min(rect.width / l.width, rect.height / l.height, 1.4) * 0.92
    setScale(s)
    setTx((rect.width - l.width * s) / 2)
    setTy((rect.height - l.height * s) / 2)
  })

  // Bring the selection into view when it changes (e.g. via owner navigation or a search match in a
  // large graph) — but only if it's off-screen, so a normal in-view click doesn't jolt the canvas.
  createEffect(
    on(
      () => props.selectedId,
      (id) => {
        if (!id || !svg) return
        const n = layout().nodes.find((m) => m.id === id)
        if (!n) return
        const rect = svg.getBoundingClientRect()
        const sx = tx() + n.x * scale()
        const sy = ty() + n.y * scale()
        const margin = 60
        if (sx < margin || sx > rect.width - margin || sy < margin || sy > rect.height - margin) {
          setTx(rect.width / 2 - n.x * scale())
          setTy(rect.height / 2 - n.y * scale())
        }
      },
    ),
  )

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const rect = svg!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const s = Math.min(Math.max(scale() * factor, 0.15), 3)
    // Zoom toward the cursor: keep the graph point under the cursor fixed.
    setTx(mx - ((mx - tx()) / scale()) * s)
    setTy(my - ((my - ty()) / scale()) * s)
    setScale(s)
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
    pointerDown = false
    dragging = false
    try {
      svg?.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
  }

  function resetView() {
    lastFitKey = '' // force the fit effect to recompute
    setScale(scale() === 1 ? 1.0001 : 1) // nudge to retrigger if needed
    const l = layout()
    if (!svg || l.width === 0) return
    const rect = svg.getBoundingClientRect()
    const s = Math.min(rect.width / l.width, rect.height / l.height, 1.4) * 0.92
    setScale(s)
    setTx((rect.width - l.width * s) / 2)
    setTy((rect.height - l.height * s) / 2)
  }

  return (
    <div class="topology">
      <Show when={props.nodes.length === 0}>
        <div class="topology-empty">
          {props.connected ? `Nothing to show in the ${props.viewLabel} view.` : 'Connecting…'}
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
        </defs>
        <g transform={`translate(${tx()},${ty()}) scale(${scale()})`}>
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
            <For each={layout().nodes}>
              {(n) => (
                <g
                  class="node"
                  classList={{
                    selected: n.id === props.selectedId,
                    faded: nodeFaded(n),
                    [`h-${n.health.toLowerCase()}`]: true,
                  }}
                  transform={`translate(${n.x - n.width / 2},${n.y - n.height / 2})`}
                  onClick={() => props.onSelect(n.id)}
                >
                  {/* Hover tooltip: a compact "everything on the card + a little more" view, so
                      a tightly-truncated card in a zoomed-out graph still reveals the full name,
                      age, host (pods), and restart count without selecting it. */}
                  <title>{cardTitle(n, now())}</title>
                  <rect class="node-bg" width={n.width} height={n.height} rx="9" />
                  {/* Icon-forward card (cycle 126): a 28×28 kind silhouette anchors the left column
                      and a small uppercase kind label sits under it; the right column lays name,
                      status and the restart/age badge on their own rows so nothing competes for
                      width. Health is carried by the .node-bg border + tint (see CSS), so a colored
                      stripe is redundant and was removed to reclaim left padding for the icon. */}
                  <g class="node-icon node-icon-large" transform="translate(10,6) scale(2)">
                    {kindIcon(n.kind)}
                  </g>
                  <text class="node-kind" x="24" y="64" text-anchor="middle">
                    {kindShortLabel(n.kind)}
                  </text>
                  <text class="node-name" x="46" y="38">
                    {label(n)}
                  </text>
                  <Show when={n.status}>
                    <text class="node-status" x={n.width - 12} y="20" text-anchor="end" fill={healthColor(n.health)}>
                      {cardStatus(n.status!)}
                    </text>
                  </Show>
                  <Show when={rightBadge(n)}>
                    <text class="node-restarts" x={n.width - 12} y="58" text-anchor="end">
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
            fallback={<>{props.nodes.length} resources</>}
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
