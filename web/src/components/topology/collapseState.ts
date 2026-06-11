import { createEffect, createSignal, type Setter } from 'solid-js'
import type { PositionedNode } from '../../layout'

// Per-cluster expansion state for the "+N older" collapse (ephemeral: a Set of expanded keys,
// empty = everything collapsed, resets on reload). Keyed by the layout's stable collapse key
// ("kind:Pod", "host:<node>", …) so toggling one cluster never disturbs another.
export function createExpandedClusters() {
  const [expandedClusters, setExpandedClusters] = createSignal<ReadonlySet<string>>(new Set())
  const toggleCluster = (key: string) =>
    setExpandedClusters((s) => {
      const next = new Set(s)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  return { expandedClusters, setExpandedClusters, toggleCluster }
}

// Auto-expand the fold hiding a navigated-to selection. Enter-cycle, j/k stepping, and deep-links
// all walk the FULL node set (troubled-first), so a target is often a node folded behind a "+N more"
// pill: the drawer opens but the node isn't rendered, so there's no on-canvas .selected marker and
// the operator can't see where it lives. When the selection isn't currently visible, find the single
// pill whose fold covers it and expand just that one — revealing the node with its marker. Scoped to
// the EXACT selected node (not its related() subtree) so selecting a hub never unfolds every sibling.
export function autoExpandSelection(src: {
  selectedId: () => string | null
  layoutNodes: () => PositionedNode[]
  setExpandedClusters: Setter<ReadonlySet<string>>
}) {
  createEffect(() => {
    const id = src.selectedId()
    if (!id) return
    const nodes = src.layoutNodes()
    if (nodes.some((n) => n.id === id && !n.collapse)) return // already on canvas
    for (const n of nodes) {
      const meta = n.collapse
      if (!meta) continue
      if (meta.hidden.some((h) => h.id === id) || meta.hiddenDescendants?.some((h) => h.id === id)) {
        src.setExpandedClusters((s) => (s.has(meta.key) ? s : new Set(s).add(meta.key)))
        break
      }
    }
  })
}
