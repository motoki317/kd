import type { EdgeType, KEdge, RelCategory } from './types'

// A relationship category groups one or more graph EdgeTypes under a label an operator recognises,
// so the toolbar offers "Network" rather than the raw "routes"/"selects" edge taxonomy. Toggling a
// category re-projects the graph (changes which edges exist → which nodes are connected vs
// orphaned), reproducing what the old per-view server Filter did — but now composable: several
// categories can be active at once (ownership + network arrows together), which the fixed views
// never allowed.
export interface RelCategoryDef {
  id: RelCategory
  label: string
  hint: string
  edges: EdgeType[]
}

// Order = display order of the toggle buttons. Ownership first (the default, the backbone), then
// the connectivity dimensions. `usesServiceAccount` rides with RBAC and `scheduledOn` with
// Scheduling — both were edge types the old views under-used; here they get a home.
export const REL_CATEGORIES: RelCategoryDef[] = [
  { id: 'ownership', label: 'Ownership', hint: 'Parent→child workload tree (ownerReferences + CRD refs)', edges: ['ownerReference', 'refers'] },
  { id: 'network', label: 'Network', hint: 'Ingress→Service→Pod traffic flow', edges: ['routes', 'selects'] },
  { id: 'volumes', label: 'Volumes', hint: 'Pods and the ConfigMaps/Secrets/PVCs they mount', edges: ['mounts'] },
  { id: 'rbac', label: 'RBAC', hint: 'Bindings → Roles and the ServiceAccounts they grant', edges: ['binds', 'usesServiceAccount'] },
  { id: 'scheduling', label: 'Scheduling', hint: 'Pods → the Node they run on', edges: ['scheduledOn'] },
]

const BY_ID = new Map(REL_CATEGORIES.map((c) => [c.id, c]))

// Edges rendered with from/to swapped before layout, so the referenced provider reads as the
// parent (leftmost column) — matching the owner→owned direction of the rest of the tree. `refers`
// is stored referrer→referenced (Workflow→WorkflowTemplate) but the template is the conceptual
// parent. This reproduces the old server-side viewSpecs[ViewOwnership].reverseEdges; only `refers`
// reverses — `ownerReference` is already owner→owned.
export const REVERSE_EDGES = new Set<EdgeType>(['refers'])

// activeEdgeTypes returns the union of every selected category's edge types — the set of edge
// types that should be drawn (and therefore drive connectivity) for the current relationship
// filter.
export function activeEdgeTypes(active: ReadonlySet<RelCategory>): Set<EdgeType> {
  const out = new Set<EdgeType>()
  for (const id of active) for (const e of BY_ID.get(id)?.edges ?? []) out.add(e)
  return out
}

// projectEdges keeps only the edges whose type is enabled by the active relationship categories,
// reversing the referenced-as-parent ones. An empty selection yields no edges (every node orphans
// — a legitimate "just the resources, no relationships" state). This is the client-side
// replacement for the server's per-view edge projection.
export function projectEdges(edges: KEdge[], active: ReadonlySet<RelCategory>): KEdge[] {
  const types = activeEdgeTypes(active)
  const out: KEdge[] = []
  for (const e of edges) {
    if (!types.has(e.type)) continue
    out.push(REVERSE_EDGES.has(e.type) ? { ...e, from: e.to, to: e.from } : e)
  }
  return out
}

// relCategoriesPresent reports which categories have at least one edge in the graph, so the toolbar
// can show only the relationship toggles that would actually do something — mirroring how the kind
// chips derive from the kinds actually present.
export function relCategoriesPresent(edges: KEdge[]): Set<RelCategory> {
  const present = new Set<EdgeType>(edges.map((e) => e.type))
  const out = new Set<RelCategory>()
  for (const c of REL_CATEGORIES) if (c.edges.some((e) => present.has(e))) out.add(c.id)
  return out
}
