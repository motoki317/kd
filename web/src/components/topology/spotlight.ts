import { createMemo } from 'solid-js'
import { edgeKey, spotlightSubtree } from '../../graphState'
import { isNodeFaded } from '../../fade'
import { orderedForNav } from '../../nav'
import { nodeMatches } from '../../search'
import type { PositionedNode } from '../../layout'
import type { Health, KEdge, KNode } from '../../types'

// The fade/highlight composition for the topology canvas, lifted from Topology.tsx: selection
// spotlight (related), live search (matches), kind filter, and the node/edge fade + edge accent
// derived from them. A factory over the component's source accessors so the reactive graph is
// exactly what the inline code built. The composition ORDER is load-bearing — selection first
// (a selected node never fades), then kind filter, then search ∩ health ∩ related (see isNodeFaded).
export function createSpotlight(src: {
  // The FULL raw graph node set (props.nodes) — the ghost-selection check and nav ordering walk it.
  nodes: () => KNode[]
  // The laid-out node set minus hidden orphans — what search counts ("what you see is what you search").
  visibleNodes: () => KNode[]
  // The relFilter-projected edge set (NOT the full streamed set) — the spotlight matches what's drawn.
  displayEdges: () => KEdge[]
  // The current layout's positioned nodes (collapse pills included) — feeds the per-edge id lookup.
  layoutNodes: () => PositionedNode[]
  selectedId: () => string | null
  query: () => string
  kindFilter: () => Set<string> | null | undefined
  healthFilter: () => Health | null | undefined
}) {
  // When a node is selected, walk its connected component (edges treated as undirected) so the
  // entire relationship tree containing the selection stays lit while everything else fades out —
  // ArgoCD-style focus on "this resource and what relates to it". Cycle 157 promoted this from
  // immediate-neighbors to full-component because the auto-fit targets the same set:
  // clicking a Pod should frame Deployment+ReplicaSet+Pod, not just the parent edge.
  // Walk only the DISPLAYED relationships (displayEdges, the relFilter projection) — NOT the full edge
  // set. Following relationships the operator hasn't enabled lit (and framed) nodes they can't even
  // see — e.g. a Pod dragging in its mounted ConfigMaps when Volumes is off, so the selection-fit
  // zoomed way out. The spotlight now matches what's on screen. (BFS in spotlightSubtree, graphState.ts.)
  const related = createMemo(() => {
    const id = src.selectedId()
    if (!id) return null
    // A ghost selection (the inspected resource was deleted; the drawer shows its terminal banner)
    // has no card on canvas — a spotlight with no subject would just fade EVERYTHING. No spotlight.
    if (!src.nodes().some((n) => n.id === id)) return null
    return spotlightSubtree(id, src.displayEdges())
  })

  // Search dims everything that doesn't match the query (by name, kind, label, or image), so a
  // resource is findable in a dense namespace without losing its place in the tree. Null when the
  // box is empty. The query is owned by the parent so it resets on namespace/view change.
  const matches = createMemo(() => {
    const q = src.query().trim()
    if (!q) return null
    // Count over the FULL node set, not layout().nodes — a folded collapse pill removes matching
    // nodes from the layout, so counting only what's on canvas undercounts (search "workflow" on a
    // namespace whose 144 Workflows are mostly folded read "38" while the honest total is 158). The
    // matchOrdered Enter-cycle steps through this full set and auto-expands the fold hiding each
    // target (see the selection auto-expand effect), so every counted match is actually reachable;
    // and this readout now agrees with the bottom-overlay filterMatchCount. Intersect with the kind
    // filter so faded-out kinds don't count. Read src.kindFilter directly (not activeKinds(),
    // declared later → TDZ).
    const kf = src.kindFilter()
    const kindOk = (kind: string) => !kf || kf.size === 0 || kf.has(kind)
    const m = new Set<string>()
    // Over visibleNodes (not the full node set): a hidden orphan isn't on the canvas, so search must not
    // count or Enter-cycle to it — "what you see is what you search". Still the full set minus orphans,
    // so folded-but-present matches keep counting (the folded-undercount fix holds).
    for (const n of src.visibleNodes()) {
      if (kindOk(n.kind) && nodeMatches(n, q)) m.add(n.id)
    }
    return m
  })
  // Ordered list of matches in the same severity-first order used for Enter cycling (cycle 284).
  // Memoized so the "X of N" indicator and the Enter handler agree on positions.
  const matchOrdered = createMemo(() => {
    const m = matches()
    if (!m || m.size === 0) return []
    return orderedForNav(src.nodes().filter((n) => m.has(n.id)))
  })
  // 1-based position of the current selection within matchOrdered, or 0 if the selection is not a
  // match. Drives the "3 of 7 matches" indicator that complements Enter-cycling (cycle 285).
  const matchPos = createMemo(() => {
    const ordered = matchOrdered()
    if (ordered.length === 0) return 0
    const idx = ordered.findIndex((n) => n.id === src.selectedId())
    return idx < 0 ? 0 : idx + 1
  })

  // Active kind filter (cycle 203): an empty/null set means "show all kinds"; otherwise only the
  // listed kinds stay lit. Re-derived so an empty set still reads as "no filter active".
  const activeKinds = createMemo(() => {
    const s = src.kindFilter()
    return s && s.size > 0 ? s : null
  })
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
  const nodeFaded = (n: { id: string; health: string; kind: string }) =>
    isNodeFaded(n, {
      selectedId: src.selectedId(),
      kindOk: nodeKindOk,
      matchIds: matches(),
      healthFilter: src.healthFilter(),
      relatedIds: related()?.nodes ?? null,
    })

  // One id→node map per layout, so the per-edge lookups below (the kind-fade test and each edge's
  // hover title) are O(1) instead of a linear find apiece — they run for every edge on every render,
  // so the old finds were O(edges×nodes) on each SSE patch / selection change.
  const nodeById = createMemo(() => {
    const m = new Map<string, PositionedNode>()
    for (const n of src.layoutNodes()) m.set(n.id, n)
    return m
  })
  const edgeFaded = (e: KEdge) => {
    const m = matches()
    if (m) return !(m.has(e.from) && m.has(e.to))
    if (src.healthFilter()) return true
    if (activeKinds()) {
      // Light the edge only when both endpoints pass the kind filter — keeps the active subset's
      // connectivity readable instead of leaving dangling lines that go nowhere.
      const a = nodeById().get(e.from)
      const b = nodeById().get(e.to)
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
    if (matches() || src.healthFilter() || activeKinds()) return false
    const id = src.selectedId()
    return !!id && (e.from === id || e.to === id)
  }

  return { related, matches, matchOrdered, matchPos, activeKinds, nodeKindOk, nodeFaded, nodeById, edgeFaded, edgeAdjacent }
}
