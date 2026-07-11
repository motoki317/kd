// Same-kind collapse primitives: the head+tail fold behind a "+N more" pill, the pre-layout
// sibling-subtree rewrite, and the frame rects the renderer draws around folded groups.

import type { EdgeType, KEdge, KNode } from '../types'
import { byName, COLLAPSE_KIND, type CollapseMeta, type Layout } from './core'

// When a crowded same-kind cluster folds we keep the FIRST card and the LAST COLLAPSE_TAIL of the
// natural-sorted run and hide the MIDDLE behind the pill. Keeping a contiguous head+tail of the *same*
// order the expanded view uses means expanding only fills the gap in the middle — it never reshuffles
// the cards, so the operator's eye keeps its place. (The old fold kept the "newest N by creation time",
// so expanding swapped to name order and the whole group jumped — disorienting.) 1 + 2 keeps the lowest
// ordinal (e.g. web-0) and the two latest in view. A cluster folds only when the hidden middle has at
// least COLLAPSE_MIN_HIDDEN cards, so a lone "+1" pill never replaces a card it could have just shown.
const COLLAPSE_HEAD = 1
const COLLAPSE_TAIL = 2
export const COLLAPSE_VISIBLE = COLLAPSE_HEAD + COLLAPSE_TAIL
const COLLAPSE_MIN_HIDDEN = 2

// splitForFold sorts a same-kind cluster by natural name order (numeric-aware, so web-2 precedes
// web-10 and a StatefulSet reads 0,1,2,…) and partitions it for collapsing: the first COLLAPSE_HEAD
// and last COLLAPSE_TAIL cards stay visible, the middle hides behind the pill. `pillIndex` tells the
// caller where to splice the "+N more" pill into `visible` — between head and tail while collapsed,
// at the very end once expanded (the full run then reads in natural order followed by a trailing
// show-fewer toggle). Because head and tail keep their slots in both states, expanding only reveals
// the hidden middle — it never reshuffles the visible cards (FR: order preserved on expand/collapse).
// `cmp` overrides the order (the Nodes view sorts troubled pods first); the fold still keeps the
// head+tail of whatever order it produces. A cluster folds only when the middle has ≥ COLLAPSE_MIN_HIDDEN.
export function splitForFold(
  nodes: KNode[],
  expanded: boolean,
  cmp: (a: KNode, b: KNode) => number = byName,
  prioritize?: (n: KNode) => boolean,
): { visible: KNode[]; hidden: KNode[]; pillIndex: number } {
  const sorted = [...nodes].sort(cmp)
  if (sorted.length < COLLAPSE_VISIBLE + COLLAPSE_MIN_HIDDEN) {
    return { visible: sorted, hidden: [], pillIndex: sorted.length }
  }
  // Triage mode: when a filter marks a SUBSET of the cluster as matches (e.g. the Degraded health
  // legend), float those matches to the visible slots instead of the name-ordinal head+tail — so a
  // folded group shows its matching cards as the representatives, not arbitrary healthy ones buried
  // behind the "+N more" pill. Matches keep their natural order and stay put when the pill expands
  // (expand only reveals the folded remainder below them), preserving the no-reshuffle invariant.
  if (prioritize) {
    const matchSet = new Set(sorted.filter(prioritize).map((n) => n.id))
    if (matchSet.size > 0 && matchSet.size < sorted.length) {
      const ordered = [...sorted.filter((n) => matchSet.has(n.id)), ...sorted.filter((n) => !matchSet.has(n.id))]
      const hidden = ordered.slice(COLLAPSE_VISIBLE)
      if (expanded) return { visible: ordered, hidden, pillIndex: ordered.length }
      return { visible: ordered.slice(0, COLLAPSE_VISIBLE), hidden, pillIndex: COLLAPSE_VISIBLE }
    }
  }
  const hidden = sorted.slice(COLLAPSE_HEAD, sorted.length - COLLAPSE_TAIL)
  if (expanded) return { visible: sorted, hidden, pillIndex: sorted.length }
  const visible = [...sorted.slice(0, COLLAPSE_HEAD), ...sorted.slice(sorted.length - COLLAPSE_TAIL)]
  return { visible, hidden, pillIndex: COLLAPSE_HEAD }
}

// foldSiblingSubtrees folds a parent's crowded same-kind children into a "+N more" pill EVEN when
// those children own subtrees — the case findHubs/leaf-blocks can't handle (it only wraps degree-1
// leaves). A column of Argo Workflows under one WorkflowTemplate is the motivating case: the
// running/failed ones own Pods (so they have degree > 1) and therefore never folded, leaving the
// column cluttered no matter how many runs piled up. Here we fold across the WHOLE same-kind group,
// status-agnostic: the head+tail of the natural-sorted run stay (with their subtrees), the hidden
// middle — and its descendant subtrees — folds away behind one pill, all restored on expand.
//
// It runs as a pre-layout graph rewrite (returns reduced nodes+edges plus synthetic pill nodes) so
// the intricate column / leaf-block placement downstream is untouched: a pill is just another child
// of the hub. Pure degree-1 leaf clusters (a Node's 50 Pods) are deliberately LEFT ALONE — they fold
// more compactly through the existing leaf-block grid — so this only engages when a same-kind sibling
// group contains a non-leaf (a child with its own children). `prioritize` (the active health filter)
// floats matching siblings into the visible slots, so a triage filter shows the troubled runs as the
// group's face instead of burying them behind the pill (same contract as the Kind view, 9d4438c).
export function foldSiblingSubtrees(
  nodes: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string>,
  prioritize?: (n: KNode) => boolean,
): { nodes: KNode[]; edges: KEdge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childEdgesOf = new Map<string, KEdge[]>()
  const isParent = new Set<string>() // node has at least one child (is a non-leaf)
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const list = childEdgesOf.get(e.from)
    if (list) list.push(e)
    else childEdgesOf.set(e.from, [e])
    isParent.add(e.from)
  }
  // descendantsOf collects every node reachable downward from the given roots (excluding the roots),
  // following child edges — the subtree that folds away with a hidden sibling. BFS, cycle-guarded.
  const descendantsOf = (roots: string[]): KNode[] => {
    const seen = new Set(roots)
    const out: KNode[] = []
    const queue = [...roots]
    while (queue.length) {
      for (const e of childEdgesOf.get(queue.shift()!) ?? []) {
        if (seen.has(e.to)) continue
        seen.add(e.to)
        const n = byId.get(e.to)
        if (n) out.push(n)
        queue.push(e.to)
      }
    }
    return out
  }

  const removed = new Set<string>()
  // Visible siblings to frame together with their pill (id → collapse key), so connGroups draws the
  // SAME dashed grouping border the leaf-block fold gets — without it the pill floated unframed.
  const framed = new Map<string, string>()
  // FOLD OWNERSHIP: a node is covered by AT MOST ONE pill. `claimed` records every node this pass has
  // already folded (visible + hidden members), which closes two double-fold holes that share a root
  // cause — the same nodes reached by two fold decisions:
  //   1. A group reachable from TWO parents (Karpenter NodeClaims own a Node, so they reach here, AND
  //      are children of both a NodePool and an EC2NodeClass). Without this each parent minted its own
  //      pill over the same set under a different key; since each key removes those nodes, expanding
  //      one left the other still hiding them — two stacked pills that did nothing.
  //   2. The downstream leaf-grid fold (findHubs/collapseHubLeaves) re-folding the SAME group: it keys
  //      identically (`sib:<hub>:<kind>`), so when this pass kept a group expanded (nodes not removed),
  //      the leaf path folded its leaves again into a second pill on the same key — two "show N fewer".
  // Members this pass keeps are tagged with `collapseGroup` (below), and the leaf path skips any
  // collapseGroup-tagged leaf — so ownership, once taken here, is honored everywhere.
  const claimed = new Set<string>()
  const pills: Array<KNode & { _collapse: CollapseMeta; _pillSlot: number; collapseGroup: string }> = []
  const pillEdges: KEdge[] = []
  for (const [parentId, childEdges] of childEdgesOf) {
    const byKind = new Map<string, { node: KNode; type: EdgeType }[]>()
    for (const e of childEdges) {
      const child = byId.get(e.to)!
      const g = byKind.get(child.kind)
      if (g) g.push({ node: child, type: e.type })
      else byKind.set(child.kind, [{ node: child, type: e.type }])
    }
    for (const [kind, group] of byKind) {
      if (kind === COLLAPSE_KIND) continue
      // Only groups the leaf-block path can't fold: at least one sibling owns a subtree. Pure-leaf
      // groups keep their compact grid fold via findHubs/collapseHubLeaves.
      if (!group.some((g) => isParent.has(g.node.id))) continue
      // Skip a group whose members another parent already folded (shared-children case, see `claimed`).
      if (group.every((g) => claimed.has(g.node.id))) continue
      const key = `sib:${parentId}:${kind}`
      const isExpanded = expanded.has(key)
      const { visible, hidden, pillIndex } = splitForFold(group.map((g) => g.node), isExpanded, byName, prioritize)
      if (hidden.length < COLLAPSE_MIN_HIDDEN) continue
      for (const g of group) claimed.add(g.node.id) // own every member (visible + hidden) — fold it once

      const descendants = descendantsOf(hidden.map((n) => n.id))
      // _pillSlot is the pill's position among the visible siblings (between head and tail while
      // collapsed, at the bottom once expanded). placeColumns reads it to splice the pill into its
      // sibling column at the right row, instead of letting it float as its own __collapse__ group.
      pills.push({
        ...pillNode(key, hidden.length),
        _collapse: { key, groupKind: kind, hidden, expanded: isExpanded, hiddenDescendants: descendants },
        _pillSlot: pillIndex,
        collapseGroup: key,
      })
      pillEdges.push({ from: parentId, to: `${COLLAPSE_KIND}:${key}`, type: group[0].type })
      for (const n of visible) framed.set(n.id, key)
      if (!isExpanded) {
        for (const n of hidden) removed.add(n.id)
        for (const n of descendants) removed.add(n.id)
      }
    }
  }
  if (pills.length === 0) return { nodes, edges }

  const keptNodes = nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => (framed.has(n.id) ? ({ ...n, collapseGroup: framed.get(n.id) } as KNode) : n))
  const keptEdges = edges.filter((e) => !removed.has(e.from) && !removed.has(e.to))
  return { nodes: [...keptNodes, ...pills], edges: [...keptEdges, ...pillEdges] }
}

// pillNode is the identity of a synthetic "+N more" fold affordance — the fields every pill shares no
// matter where in the pipeline it's minted (its id format and the "+N more" label live here once).
// Callers attach the collapse meta themselves: `_collapse` for a pre-layout pill the placer lifts onto
// `collapse`, or `collapse` directly on an already-placed cell — plus any placement extras.
export function pillNode(key: string, hiddenCount: number): KNode {
  return { id: `${COLLAPSE_KIND}:${key}`, kind: COLLAPSE_KIND, name: `+${hiddenCount} more`, health: 'Healthy' }
}

// pillCell builds the synthetic KNode for a "+N older" affordance, tagged with its CollapseMeta so
// the placement loop can lift it onto the resulting PositionedNode. `host` is set for host-group
// pills so hostGroups() attributes the pill to the right container.
export function pillCell(meta: CollapseMeta, host?: string): KNode & { _collapse: CollapseMeta } {
  return { ...pillNode(meta.key, meta.hidden.length), ...(host ? { host } : {}), _collapse: meta }
}

// connGroups returns one bounding rect per per-kind leaf block (Services, Secrets, …) under a hub, so
// the renderer can frame each kind's cards separately — the cue that says "these are this parent's
// Secrets, and the pill inside folds/unfolds the crowded part". Membership is the per-kind frame key
// on each card + pill (`collapseGroup`, set by collapseHubLeaves on folded blocks only). Because each
// kind is a contiguous column block, its bbox is tight and never sprawls across another kind. A frame
// is "expanded" if its pill is expanded. Connectivity views have no kind/host container (unlike
// All/Nodes), so this is the only grouping cue there.
export function connGroups(layout: Layout): { key: string; expanded: boolean; x: number; y: number; width: number; height: number }[] {
  const groups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; expanded: boolean }>()
  for (const n of layout.nodes) {
    const key = n.collapseGroup
    if (!key) continue
    const left = n.x - n.width / 2
    const right = n.x + n.width / 2
    const top = n.y - n.height / 2
    const bottom = n.y + n.height / 2
    const cur = groups.get(key)
    if (!cur) groups.set(key, { minX: left, minY: top, maxX: right, maxY: bottom, expanded: !!n.collapse?.expanded })
    else {
      cur.minX = Math.min(cur.minX, left)
      cur.minY = Math.min(cur.minY, top)
      cur.maxX = Math.max(cur.maxX, right)
      cur.maxY = Math.max(cur.maxY, bottom)
      if (n.collapse?.expanded) cur.expanded = true
    }
  }
  // Frame padding so the border sits a few px outside the cards rather than flush against them.
  const PAD = 8
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, r]) => ({
      key,
      expanded: r.expanded,
      x: r.minX - PAD,
      y: r.minY - PAD,
      width: r.maxX - r.minX + PAD * 2,
      height: r.maxY - r.minY + PAD * 2,
    }))
}
