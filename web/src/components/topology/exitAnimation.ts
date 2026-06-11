import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { PositionedNode } from '../../layout'
import type { GroupBy } from '../../types'

// Departing-node tracking for the topology canvas, lifted from Topology.tsx. Must be called during
// component setup (it registers effects + onCleanup on the calling owner).
export function createExitAnimation(src: {
  layoutNodes: () => PositionedNode[]
  groupBy: () => GroupBy | undefined
}) {
  // Exit animation (cycle 160): when a node drops out of props.nodes, keep its last-known position
  // rendered with a fading-out class for 320ms so the operator sees it leave rather than vanish.
  // We snapshot the prior layout each time createEffect runs and diff against the new one.
  const [exiting, setExiting] = createSignal<PositionedNode[]>([])
  let prevPositioned: PositionedNode[] = []
  const exitTimers = new Map<string, number>()
  createEffect(() => {
    const cur = src.layoutNodes()
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

  // Render the cards from a RECONCILED store keyed by id, NOT straight off layout(). layout() is a pure
  // recompute that rebuilds every PositionedNode object each run, so a <For each={layout().nodes}> keyed
  // by object reference tore down and recreated EVERY card on any structural (add/remove) patch — the
  // canvas "flicker" the operator saw (measured: a single pod scaling rebuilt all 45 cards). reconcile
  // with key:'id' preserves each surviving card's object identity across recomputes, so <For> keeps its
  // DOM and Solid surgically patches only the changed fields (x/y/health/…) on the cards that actually
  // moved. Empty in the Nodes group-by — its own bar renderer draws there, not these cards.
  const [renderNodes, setRenderNodes] = createStore<PositionedNode[]>([])
  createEffect(() => {
    const next = src.groupBy() === 'nodes' ? [] : [...src.layoutNodes(), ...exiting()]
    setRenderNodes(reconcile(next, { key: 'id' }))
  })

  return { exitingIds, renderNodes }
}
