import { createMemo, createSignal, For, Show, createEffect } from 'solid-js'
import { layoutGraph, type Point } from '../layout'
import { healthColor } from '../health'
import type { EdgeType, KEdge, KNode } from '../types'

interface Props {
  nodes: KNode[]
  edges: KEdge[]
  selectedId: string | null
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

// truncate keeps node labels inside the fixed-width card; the full name is shown via a tooltip.
function truncate(s: string, max = 24): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export default function Topology(props: Props) {
  const layout = createMemo(() => layoutGraph(props.nodes, props.edges))

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
        <div class="topology-empty">No resources to display in this namespace.</div>
      </Show>
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
                  classList={{ selected: n.id === props.selectedId }}
                  transform={`translate(${n.x - n.width / 2},${n.y - n.height / 2})`}
                  onClick={() => props.onSelect(n.id)}
                >
                  <title>{`${n.kind} ${n.name}${n.status ? ` (${n.status})` : ''}`}</title>
                  <rect class="node-bg" width={n.width} height={n.height} rx="8" />
                  <rect class="node-stripe" width="5" height={n.height} rx="2.5" fill={healthColor(n.health)} />
                  <text class="node-kind" x="16" y="22">
                    {n.kind}
                  </text>
                  <text class="node-name" x="16" y="40">
                    {truncate(n.name)}
                  </text>
                  <Show when={n.status}>
                    <text class="node-status" x={n.width - 12} y="22" text-anchor="end" fill={healthColor(n.health)}>
                      {n.status}
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
