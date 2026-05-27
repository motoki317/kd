import { createMemo, createSignal, For, Show, createEffect, on } from 'solid-js'
import { layoutGraph, type Point } from '../layout'
import { edgeKey } from '../graphState'
import { healthColor } from '../health'
import { middleTruncate, relativeName } from '../names'
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
  const label = (n: KNode) => middleTruncate(relativeName(n.name, ownerName().get(n.id)))

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

  // Search dims everything whose name/kind doesn't match the query, so a resource is findable in a
  // dense namespace without losing its place in the tree. Null when the box is empty. The query is
  // owned by the parent so it resets on namespace/view change.
  const query = () => props.search
  const setQuery = (q: string) => props.onSearch(q)
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return null
    const m = new Set<string>()
    for (const n of layout().nodes) {
      if (n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q)) m.add(n.id)
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
        <input
          placeholder="Search resources…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
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
                <path
                  classList={{ faded: edgeFaded(e), adjacent: edgeAdjacent(e) }}
                  d={edgePath(e.points)}
                  fill="none"
                  stroke="var(--edge-color)"
                  stroke-width={1.5}
                  stroke-dasharray={DASHED[e.type] ? '5 4' : undefined}
                  marker-end="url(#arrow)"
                />
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
                  <title>{`${n.kind} ${n.name}${n.status ? ` (${n.status})` : ''}`}</title>
                  <rect class="node-bg" width={n.width} height={n.height} rx="8" />
                  {/* Stripe is inset 8px on every side (the CSS shifts it by 8,8), so its height
                      must subtract both the top and bottom inset or it overflows the card bottom. */}
                  <rect class="node-stripe" width="5" height={n.height - 16} rx="2.5" fill={healthColor(n.health)} />
                  <text class="node-kind" x="16" y="22">
                    {n.kind}
                  </text>
                  <text class="node-name" x="16" y="40">
                    {label(n)}
                  </text>
                  <Show when={n.status}>
                    <text class="node-status" x={n.width - 12} y="22" text-anchor="end" fill={healthColor(n.health)}>
                      {n.status}
                    </text>
                  </Show>
                  <Show when={(n.restarts ?? 0) > 0}>
                    <text class="node-restarts" x={n.width - 12} y="40" text-anchor="end">
                      ↻{n.restarts}
                    </text>
                  </Show>
                </g>
              )}
            </For>
          </g>
        </g>
      </svg>
      <button class="topology-fit" onClick={resetView} title="Fit to view">
        Fit
      </button>
    </div>
  )
}
