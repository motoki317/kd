import type { Health } from './types'

// FadeContext is the set of active dimming inputs for the topology canvas, all resolved to plain
// values so isNodeFaded stays pure (the component computes these from its reactive memos).
export interface FadeContext {
  // null/undefined both mean "no selection" (the props carry null; callers may pass undefined).
  selectedId?: string | null
  // kindOk(kind) is false when a kind filter is active and this kind isn't in it.
  kindOk: (kind: string) => boolean
  // matchIds is the set of search-matched node ids, or null when the search box is empty.
  matchIds: ReadonlySet<string> | null
  // healthFilter, when set, lights only nodes of that health (the legend triage filter).
  healthFilter?: Health | '' | null
  // relatedIds is the selected node's spotlight subtree, or null when nothing is selected.
  relatedIds: ReadonlySet<string> | null
}

// isNodeFaded encodes the topology canvas's fade PRECEDENCE — a node is dimmed unless it's the
// current focus. The ORDER is load-bearing (a new filter must slot into the right rung), highest
// priority first:
//   1. the selected node itself NEVER fades — the operator's focus stays visible even if a filter
//      would otherwise exclude it;
//   2. kind filter — a node of an unselected kind always fades, so kinds COMPOSE with (rather than
//      override) whatever else is active;
//   3. search query — while searching, only matches stay lit;
//   4. health filter — while triaging by health, only that health stays lit;
//   5. selection neighbours — with a selection, only its related subtree stays lit.
// With no selection/search/filter active, nothing fades.
export function isNodeFaded(node: { id: string; health: string; kind: string }, ctx: FadeContext): boolean {
  if (node.id === ctx.selectedId) return false
  if (!ctx.kindOk(node.kind)) return true
  if (ctx.matchIds) return !ctx.matchIds.has(node.id)
  if (ctx.healthFilter) return node.health !== ctx.healthFilter
  return ctx.relatedIds ? !ctx.relatedIds.has(node.id) : false
}
