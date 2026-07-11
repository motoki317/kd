// Hub-leaf folding: detect high-fanout parents (hubs), grid-wrap their degree-1 leaves into
// per-kind blocks, and fold each crowded kind behind its own "+N more" pill.

import type { EdgeType, KEdge, KNode } from '../types'
import {
  BLOCK_GAP,
  byName,
  COLLAPSE_KIND,
  type CollapseMeta,
  FANOUT_MIN,
  LEAF_COL_MAX,
  LEAF_GAP_X,
  LEAF_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
} from './core'
import { pillId, pillNode, splitForFold } from './collapse'

// blockDims lays a per-kind block's m cells column-major into a vertical-first grid: rows fill down
// to LEAF_COL_MAX before a second column starts, so a collapsed block (m ≤ COLLAPSE_VISIBLE+1) is one
// tall column with the pill at the bottom, and an expanded block wraps rather than running off-screen.
export function blockDims(m: number): { cols: number; rows: number; w: number; h: number } {
  const rows = Math.min(m, LEAF_COL_MAX)
  const cols = Math.ceil(m / rows)
  return {
    cols,
    rows,
    w: cols * NODE_WIDTH + (cols - 1) * LEAF_GAP_X,
    h: rows * NODE_HEIGHT + (rows - 1) * LEAF_GAP_Y,
  }
}

// A LeafBlock is one kind's cards (+ its optional "+N older" pill) under a hub, laid as its own
// column block. frameKey is set (to the per-kind collapse key) only when the kind folds (has a pill),
// so the grouping border appears exactly when the show-more affordance does — unfolded kinds stay bare.
export interface LeafBlock {
  kind: string
  frameKey?: string
  cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }>
  cols: number
  rows: number
  w: number
  h: number
}

export interface Hub {
  id: string
  // Per-kind blocks. All sit at the SAME depth (one rank to the hub's right in LR / below it in TB)
  // because they are all direct children of the hub — depth must not vary by kind. They stack along
  // the cross-flow axis (down the column in LR), each a vertical run so same-kind cards group and the
  // pill lands at the bottom of its run.
  blocks: LeafBlock[]
  // One entry per "+N older" pill folded out of this hub's leaves: the pill id and the edge type to
  // bundle from the hub to it (all hidden same-kind siblings shared the hub via this relationship).
  pills: { id: string; type: EdgeType }[]
}

// hubArea is the reserved size for a hub's whole leaf cluster. Blocks stack along the cross axis at a
// single depth: in LR that is downward (height = sum of block heights, width = the widest block); in
// TB it is rightward (width = sum, height = the tallest block). Keeping every block at one depth is
// what puts all same-depth children on the same level.
export function hubArea(blocks: LeafBlock[], rankdir: 'TB' | 'LR'): { w: number; h: number } {
  const sum = (sel: (b: LeafBlock) => number) => blocks.reduce((s, b) => s + sel(b), 0) + Math.max(0, blocks.length - 1) * BLOCK_GAP
  const max = (sel: (b: LeafBlock) => number) => blocks.reduce((m, b) => Math.max(m, sel(b)), 0)
  return rankdir === 'LR' ? { w: max((b) => b.w), h: sum((b) => b.h) } : { w: sum((b) => b.w), h: max((b) => b.h) }
}

// collapseHubLeaves groups a hub's degree-1 leaves per kind into separate blocks (Services together,
// Secrets together, …) and folds each kind independently: the first + last cards of a kind stay and
// its hidden middle folds behind that kind's own "+N more" pill (D5). A kind's hidden leaves
// vanish from the component — their only edge was to the hub — replaced by one bundled hub→pill edge
// (D6) typed by the relationship they shared with the hub. Each multi-card block carries a per-kind
// frameKey so Topology frames the kinds separately.
function collapseHubLeaves(
  hubId: string,
  leaves: KNode[],
  edges: KEdge[],
  expanded: ReadonlySet<string>,
  prioritize?: (n: KNode) => boolean,
): { blocks: LeafBlock[]; pills: { id: string; type: EdgeType }[] } {
  const byKind = new Map<string, KNode[]>()
  for (const l of leaves) {
    if (!byKind.has(l.kind)) byKind.set(l.kind, [])
    byKind.get(l.kind)!.push(l)
  }
  const blocks: LeafBlock[] = []
  const pills: { id: string; type: EdgeType }[] = []
  // Stable kind order so a hub's blocks keep their left-to-right slots across SSE patches.
  for (const [kind, list] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const key = `sib:${hubId}:${kind}`
    const isExpanded = expanded.has(key)
    const split = splitForFold(list, isExpanded, byName, prioritize)
    const cells: Array<KNode & { collapse?: CollapseMeta; collapseGroup?: string }> = [...split.visible]
    if (split.hidden.length) {
      const meta: CollapseMeta = { key, groupKind: kind, hidden: split.hidden, expanded: isExpanded }
      const id = pillId(key) // the bundled hub→pill edge below must target the same id pillNode mints
      // Splice the pill into its slot in the column — between the first and last cards while collapsed,
      // at the bottom once expanded — so the kind reads in one stable natural order whichever way.
      cells.splice(split.pillIndex, 0, { ...pillNode(key, split.hidden.length), collapse: meta })
      // Bundle the hub's edges to the hidden siblings into one hub→pill edge — but only while
      // collapsed. Expanded, the siblings are drawn as real leaves with their own hub edges, so the
      // pill is a bare re-collapse toggle with no edge.
      if (!isExpanded) {
        const hid = new Set(split.hidden.map((h) => h.id))
        const e = edges.find((x) => (x.from === hubId && hid.has(x.to)) || (x.to === hubId && hid.has(x.from)))
        pills.push({ id, type: e ? e.type : 'ownerReference' })
      }
    }
    // Frame a block only when its kind actually folds (i.e. it has a "+ show N more" pill), so the
    // grouping border and the show-more affordance appear together — a kind small enough to show in
    // full needs no border. Tag each cell with the per-kind frame key so connGroups can box it.
    const frameKey = split.hidden.length ? key : undefined
    const tagged = frameKey ? cells.map((c) => ({ ...c, collapseGroup: frameKey })) : cells
    blocks.push({ kind, frameKey, cells: tagged, ...blockDims(tagged.length) })
  }
  return { blocks, pills }
}

// findHubs detects nodes whose many degree-1 CHILDREN should be grid-wrapped. A leaf is wrapped
// beside (LR) / under (TB) its hub. Only fan-OUT children are wrapped — a fan-IN hub's many parents
// stay in the Dagre skeleton so they align in their own depth column rather than folding into a
// confusing partial frame (see the per-hub note below).
export function findHubs(nodes: KNode[], edges: KEdge[], expanded: ReadonlySet<string>, prioritize?: (n: KNode) => boolean): { hubs: Hub[]; wrapped: Set<string> } {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outdeg = new Map<string, number>()
  for (const e of edges) outdeg.set(e.from, (outdeg.get(e.from) ?? 0) + 1)

  // A wrappable fan-out leaf is a SINK — it owns no children (out-degree 0). It may still have MORE
  // than one PARENT: an Argo Application is owned by an ApplicationSet yet also refers to an AppProject,
  // so keying off total degree (the old degree===1 test) left every such multi-parent leaf unwrapped —
  // the argocd "long ungrouped column" report. Each leaf is claimed by ONE primary hub so it is wrapped
  // exactly once: an ownerReference parent wins over a looser refers parent, ties broken by id for
  // determinism. Secondary parents keep their honest edges to whatever stays visible. Only the child
  // (fan-out) side is wrapped — a shared target's many PARENTS stay in the skeleton (see the note below).
  const ownerPrio = (e: KEdge) => (e.type === 'ownerReference' ? 0 : 1)
  const parentsOf = new Map<string, KEdge[]>()
  for (const e of edges) {
    const leaf = byId.get(e.to)
    if (!leaf || leaf.kind === COLLAPSE_KIND) continue // missing or a pre-folded pill is not a wrappable leaf
    // Fold ownership: a leaf already framed by foldSiblingSubtrees (its sibling group reached here
    // because a sibling owns a subtree) is OFF-LIMITS — re-folding it would mint a second pill on the
    // same `sib:<hub>:<kind>` key. Skip it; the sibling fold already gave it a pill + frame.
    if ((leaf as { collapseGroup?: string }).collapseGroup) continue
    if ((outdeg.get(e.to) ?? 0) !== 0) continue // a node with children of its own is not a leaf
    const list = parentsOf.get(e.to)
    if (list) list.push(e)
    else parentsOf.set(e.to, [e])
  }
  const childrenOf = new Map<string, KNode[]>()
  for (const [leafId, parentEdges] of parentsOf) {
    const primary = parentEdges.reduce((best, e) =>
      ownerPrio(e) < ownerPrio(best) || (ownerPrio(e) === ownerPrio(best) && e.from < best.from) ? e : best,
    )
    const list = childrenOf.get(primary.from) ?? []
    list.push(byId.get(leafId)!)
    childrenOf.set(primary.from, list)
  }

  const hubs: Hub[] = []
  const wrapped = new Set<string>()
  for (const id of childrenOf.keys()) {
    const children = childrenOf.get(id) ?? []
    // Wrap only fan-OUT children (the hub is their shared parent). Fan-IN parents are deliberately
    // NOT wrapped: folding a shared target's many degree-1 PARENTS (e.g. the dozen Pods that all
    // mount one Secret in the Volumes view) split the Pod kind into a framed mid-column subset with
    // its unrelated siblings stranded above and below — a confusing partial frame in the parent
    // column. Left in the skeleton, those parents instead align cleanly in the leftmost depth column
    // (placeColumns) with one honest edge each, which is what the operator expects.
    if (children.length < FANOUT_MIN) continue
    const leaves = [...children].sort(byName)
    // Group this hub's leaves per kind and fold each crowded kind into its own "+N older" pill
    // (D5/D6). All kind blocks sit at one depth (stacked down the column in LR), so a multi-kind CRD
    // owner's Services / Secrets / … all read as direct children on the same level.
    const collapsed = collapseHubLeaves(id, leaves, edges, expanded, prioritize)
    hubs.push({
      id,
      blocks: collapsed.blocks,
      pills: collapsed.pills,
    })
    // Every ORIGINAL leaf is owned by the hub (excluded from the Dagre skeleton); hidden ones simply
    // never get placed, and their hub edge is replaced by the bundled hub→pill edge below.
    for (const l of leaves) wrapped.add(l.id)
  }
  return { hubs, wrapped }
}
