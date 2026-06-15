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
  // secondary categories are the specialized lenses (RBAC, Disruption, Monitoring) an operator reaches
  // for less often than the core topology (Ownership/Network/Volumes). The toolbar folds them behind a
  // "+N more" expander so the relationship row stays scannable; an ACTIVE secondary still shows inline.
  secondary?: boolean
}

// Order = display order of the toggle buttons. Ownership first (the default, the backbone), then
// the connectivity dimensions. `usesServiceAccount` rides with RBAC. `scheduledOn` (pod→node) is
// deliberately NOT surfaced as a relationship: the pod↔node story has a far richer dedicated home
// in the Nodes group-by (capacity tracks per host), so re-drawing it here as a relationship tree
// only rebuilt that same hierarchy as a tall, redundant column rooted at 2 Node hubs. The category
// keeps its `scheduling` id (URL/localStorage compatibility) but is now PDB-only — relabelled
// "Disruption" to name what actually remains.
export const REL_CATEGORIES: RelCategoryDef[] = [
  { id: 'ownership', label: 'Ownership', hint: 'Parent→child workload tree (ownerReferences + CRD refs)', edges: ['ownerReference', 'refers'] },
  { id: 'network', label: 'Network', hint: 'Ingress→Service→Pod traffic + the NetworkPolicies that govern pods', edges: ['routes', 'selects', 'governs'] },
  { id: 'volumes', label: 'Volumes', hint: 'Pods and the ConfigMaps/Secrets/PVCs they mount', edges: ['mounts'] },
  { id: 'rbac', label: 'RBAC', hint: 'Bindings → Roles and the ServiceAccounts they grant', edges: ['binds', 'usesServiceAccount'], secondary: true },
  { id: 'scheduling', label: 'Disruption', hint: 'PodDisruptionBudgets → the pods they guard (pod↔node lives in the Nodes view)', edges: ['guards'], secondary: true },
  { id: 'monitoring', label: 'Monitoring', hint: 'ServiceMonitors/VMServiceScrapes → the Services they scrape', edges: ['scrapes'], secondary: true },
]

const BY_ID = new Map(REL_CATEGORIES.map((c) => [c.id, c]))

const REL_IDS = new Set<string>(REL_CATEGORIES.map((c) => c.id))
// The `scheduling` id survives its "Disruption" relabel for URL/localStorage stability — but anyone
// hand-editing a shared URL guesses from the VISIBLE label, and an unknown id is silently dropped
// (the PDBs then read as plain orphans, with nothing saying why). Accept the label as an alias on
// the read side; the app keeps writing the stable id.
const REL_ALIASES: Record<string, RelCategory> = { disruption: 'scheduling' }

// Parse a comma-separated relationship list (URL or localStorage). Returns null when the source is
// absent (so the next source / the default applies); an explicit empty string round-trips to the
// empty set, letting "all relationships off" persist rather than snapping back to the default.
export function parseRels(raw: string | null): Set<RelCategory> | null {
  if (raw === null) return null
  return new Set(
    raw
      .split(',')
      .map((x) => REL_ALIASES[x.toLowerCase()] ?? x.toLowerCase())
      .filter((x): x is RelCategory => REL_IDS.has(x)),
  )
}

// Edges rendered with from/to swapped before layout, so the referenced provider reads as the
// parent (leftmost column) — matching the owner→owned direction of the rest of the tree. `refers`
// is stored referrer→referenced (Workflow→WorkflowTemplate) but the template is the conceptual
// parent. This reproduces the old server-side viewSpecs[ViewOwnership].reverseEdges; only `refers`
// reverses — `ownerReference` is already owner→owned.
const REVERSE_EDGES = new Set<EdgeType>(['refers'])

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
