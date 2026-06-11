// Shared layout vocabulary: geometry constants, positioned-node/edge types, and the natural-name
// ordering every layout module sorts with.

import type { KEdge, KNode } from '../types'

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 60

// byName orders resources by name with numeric awareness, so an ordinal suffix sorts numerically
// (web-2 before web-10, not lexically after it) and a StatefulSet's pods read 0,1,2,… rather than the
// lexical 0,1,10,2. Used everywhere same-kind resources are listed, grid-packed, or folded.
export const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true })

// Target width:height of the packed block, so fit-to-view fills both axes instead of a thin band.
export const TARGET_ASPECT = 1.7
export const COMPONENT_GAP = 46

// A hub with at least this many leaf-neighbors (a Node hosting pods, a ReplicaSet with many
// replicas) gets its leaves grid-wrapped instead of strung across one Dagre rank.
export const FANOUT_MIN = 5
export const LEAF_GAP_X = 18
export const LEAF_GAP_Y = 16
export const HUB_GAP = 36 // vertical gap between a hub card and its grid of leaves
// A hub's leaves are grouped per kind into separate blocks (Services together, Secrets together, …),
// each a vertical column so its "+N older" pill sits at the bottom, vertically aligned under the
// kind's cards. LEAF_COL_MAX caps a column's height so an expanded kind (many cards) wraps into more
// columns instead of one absurdly tall stack; collapsed blocks (≤ COLLAPSE_VISIBLE+1) never hit it.
// BLOCK_GAP separates adjacent per-kind blocks with room for each block's grouping frame.
export const LEAF_COL_MAX = 8
export const BLOCK_GAP = 30

// EDGE_STUB is the minimum straight run an orthogonal edge takes off a box before it may turn, so a
// link always reads as leaving the parent's RIGHT edge and entering the child's LEFT edge (LR) even
// when the two cards nearly share a column. See orthRoute.
export const EDGE_STUB = 16

// LR depth-column layout (placeColumns): COLUMN_GAP is the horizontal gap between adjacent depth
// columns; COL_V_GAP is the minimum vertical gap between two stacked units (cards or grid blocks)
// within one column.
export const COLUMN_GAP = 80
export const COL_V_GAP = 18

export interface Point {
  x: number
  y: number
}

// A positioned box, enough geometry to anchor an orthogonal edge on one of its four sides.
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// COLLAPSE_KIND marks a synthetic "+N older" pill — a PositionedNode that stands in for the older
// same-kind resources hidden behind a collapse, not a real cluster object. Topology renders these
// specially and excludes them from kind stats / search / nav.
export const COLLAPSE_KIND = '__collapse__'

// CollapseMeta rides on the synthetic pill so Topology can expand it (key), attribute its box to the
// real kind (groupKind), and count how many hidden nodes match the active filter (hidden).
export interface CollapseMeta {
  key: string // stable expansion key, prefixed by container type: "kind:Pod" / "host:<node>"
  groupKind: string // the real kind being collapsed, for kindGroups attribution + the pill label
  hidden: KNode[] // the nodes this fold covers — actually hidden when collapsed, shown when expanded
  // True once this cluster is expanded: the pill stays as a "show fewer" re-collapse toggle (the
  // older cards are now drawn), so a single pill drives both directions (FR: expand AND collapse).
  expanded: boolean
  // Descendant nodes folded away ALONGSIDE the hidden siblings (a folded Workflow drags its Pods
  // with it). Of a different kind than groupKind, so they're tracked separately from `hidden`: the
  // "+N more" label counts siblings only, but the kind chips fold these back too so a different
  // kind's count stays honest while collapsed. Empty for same-kind leaf folds.
  hiddenDescendants?: KNode[]
}

export interface PositionedNode extends KNode {
  // x, y are the node center (Dagre's convention), in graph coordinates.
  x: number
  y: number
  width: number
  height: number
  // Present iff this is a synthetic "+N older" pill rather than a real resource card.
  collapse?: CollapseMeta
  // Connectivity-view collapse membership: a visible card tagged with the collapse key of the
  // hub/kind cluster it belongs to, so Topology can frame the fold (siblings + pill) with one
  // grouping border. Only set for foldable hub-leaf clusters; pills carry the key via `collapse`.
  collapseGroup?: string
}

export interface PositionedEdge extends KEdge {
  points: Point[]
}

export interface Layout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  width: number
  height: number
}

export interface Component {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  width: number
  height: number
}

// KIND_HEADER_HEIGHT reserves vertical space at the top of each kind box for the kind icon + label
// rendered by the Topology (a 12px icon at top, then a text row). 30px gives comfortable padding.
export const KIND_HEADER_HEIGHT = 30
