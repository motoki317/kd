import { createMemo, createSignal, For, Show, createEffect, on, onCleanup, onMount } from 'solid-js'
import {
  connGroups,
  kindGroups,
  layoutGraphByKind,
  layoutGraphWithOrphans,
  NODE_HEIGHT,
  NODE_WIDTH,
  type CollapseMeta,
  type OrphanLayout,
} from '../layout'
import { layoutGraphByCapacity, type CapRow, type CapacityLayout } from '../capacityLayout'
import type { CapResource } from '../resource'
import { useNow } from '../clock'
import { isDashedEdge, edgePath, edgeTitle } from '../edgeRender'
import CapacityView from './CapacityView'
import CanvasEmpty from './topology/CanvasEmpty'
import Toolbar from './topology/Toolbar'
import { createCapacityHover } from './topology/capacityHover'
import { autoExpandSelection, createExpandedClusters } from './topology/collapseState'
import { createExitAnimation } from './topology/exitAnimation'
import { createSpotlight } from './topology/spotlight'
import { HEALTH_ORDER, healthColor, healthHint, healthTextColor, worstNonHealthy } from '../health'
import { kindStats as computeKindStats } from '../kindStats'
import { orderedForNav } from '../nav'
import { cardKindLabel, cardName, cardStatus, cardTitle, pluralizeKind, prefixParentNames } from '../names'
import { nodeMatches } from '../search'
import { kindIcon } from '../icons'
import { relativeAge } from '../time'
import { projectEdges, REL_CATEGORIES, relCategoriesPresent } from '../relationships'
import { boundingBox, clampPan, fitBox, fitBoxFloored, selectionMaxScale, zoomScaleBounds } from '../viewport'
import { scrollEdges, type ScrollEdges } from '../scrollEdges'
import { CLUSTER_SCOPE } from '../api'
import type { Capacity, Health, KEdge, KNode, RelCategory } from '../types'

const EMPTY_RELS: ReadonlySet<RelCategory> = new Set()
const EMPTY_IDS: ReadonlySet<string> = new Set()

// Network edge types (routes/selects/governs) — the links over which traffic actually flows. The
// animated data-flow trace rides ONLY these, so the cybernetic motion visualizes real network data
// movement; ownership stays a static structure drawn with plain solid arrows. Sourced from the
// 'network' relationship category so it never drifts from relationships.ts.
const NETWORK_EDGE_TYPES = new Set(REL_CATEGORIES.find((c) => c.id === 'network')?.edges ?? [])

// The group-by options live with the toolbar's segmented control (topology/Toolbar.tsx); re-exported
// here so App's keyboard shortcuts (1–3), urlState, and the help overlay keep one import path.
export { GROUP_OPTIONS } from './topology/Toolbar'

interface Props {
  nodes: KNode[]
  edges: KEdge[]
  selectedId: string | null
  healthFilter?: import('../types').Health | null
  // Multi-select set of kinds to spotlight. Empty / null means "show all"; a
  // non-empty set fades every node whose kind isn't in it. The parent owns the set so it
  // survives namespace/view transitions when desired (currently cleared on view change).
  kindFilter?: Set<string> | null
  // Toggle (or "solo" with Shift) a kind in the filter. `solo` clears the existing set and sets
  // the filter to exactly this kind — paired with the chip's onClick passing e.shiftKey.
  onKindFilter?: (k: string, solo?: boolean) => void
  // Spotlight a health state, or clear it (null). Drives the health-filter pills that now live in
  // this toolbar — moved out of the global topbar so every "filter the resources in front of me"
  // control sits in one block beside the search and kind chips.
  onHealthFilter?: (h: Health | null) => void
  connected: boolean
  // True when the SSE stream has errored (distinct from the pre-snapshot 'connecting' state). With an
  // empty graph this drives the empty-state message: a failed connection must NOT show the
  // "Connecting…" spinner (which implies active progress) — it shows a static "can't reach" message
  // pointing at the retry control, so the operator knows to act rather than wait.
  offline?: boolean
  // The namespace list loaded fine but is EMPTY: the cluster answered, this account just has no
  // read access. A terminal state of its own — neither "connecting" (nothing will arrive) nor
  // "offline" (nothing failed).
  noAccess?: boolean
  // kd's bootstrap (the contexts list) was answered 401/403: the auth proxy sent no identity, or
  // policy denies this user outright. Outranks every other empty state — nothing else can load.
  authFailed?: boolean
  // The active context's cache-build error, shown under the offline empty-state headline so the
  // failure diagnoses itself (expired credentials vs unreachable API) instead of a bare "retry".
  offlineReason?: string
  // groupBy selects the layout strategy: 'kind' → per-kind boxes, 'nodes' → host containers,
  // 'relationship' (default) → relationship depth-column tree. Replaces the old viewId. The
  // segmented control that sets it lives in this toolbar (onGroupBy); App owns the signal.
  groupBy?: import('../types').GroupBy
  onGroupBy?: (g: import('../types').GroupBy) => void
  // Capacity-view resource (cpu|memory). Owned by App so it round-trips through the URL like
  // groupBy/relFilter (shareable capacity-view links); this component only reads + requests changes.
  capResource?: CapResource
  onCapResource?: (r: CapResource) => void
  // relFilter is the set of relationship categories whose edges are drawn (and which therefore
  // drive connectivity). The toolbar's relationship chips toggle it via onRelFilter.
  relFilter?: ReadonlySet<RelCategory>
  onRelFilter?: (c: RelCategory, solo?: boolean) => void
  // In the relationship grouping, an "orphaned" resource — one no DISPLAYED edge touches — is hidden
  // by default so the canvas reads as the relationship tree, not a wall of loose cards. The toolbar's
  // "Show orphaned" checkbox flips this; App owns the signal so it round-trips through URL + localStorage.
  // Degraded orphans are the standing exception (see visibleNodes / healthStats): they always count in
  // the Degraded pill and surface when that filter is active, so triage reaches them even while hidden.
  showOrphaned?: boolean
  onShowOrphaned?: (v: boolean) => void
  // onClearFilters clears every active filter at once (search + health + kinds). Optional —
  // when omitted, the chip row's individual clears stay the only way to reset.
  onClearFilters?: () => void
  // scope identifies the current cluster+namespace, so the auto-fit re-frames only on a real
  // context/namespace switch — not when an SSE patch or a collapse expand/refold changes the node
  // set within the same scope (which must preserve the operator's current pan/zoom).
  scope?: string
  // capacity is the cluster-wide Node+Pod feed (with live usage) the Nodes group-by draws — every
  // namespace's pods on each node, so the view is the same in cluster and namespace scope and the
  // client just dims pods outside `namespace`. Null before the first `capacity` event.
  capacity?: Capacity | null
  // namespace is the selected namespace (or the cluster sentinel). The capacity view renders this
  // namespace's pods bright and dims the rest; the cluster sentinel treats every pod as own.
  namespace?: string
  search: string
  onSearch: (q: string) => void
  // Lets the app focus the topology search from the global "/" key — like Sidebar's
  // filterRef but for the resource search instead of the namespace filter.
  searchRef?: (el: HTMLInputElement) => void
  onSelect: (id: string) => void
  // Background click dismisses the open drawer. Optional — parent decides whether
  // the click-out behavior is wired (Topology tests pass no-op handlers).
  onDeselect?: () => void
}

// Edges other than ownership are drawn dashed so the parent-child backbone stays visually
// dominant (the primary relationship operators scan for first). EdgeRefers (CR-defined
// references) is rendered identically to the other non-ownership edges — same grey, same dash,
// same arrowhead — because "refers to" is semantically just another non-ownership relationship;
// only the hover tooltip names the specific kind. (Colour/shape distinction was dropped: it
// cluttered a dense canvas and the categories read the same to operators.)
// Floor for the auto-fit scale. Below this, cards shrink past legibility (names fade out at the
// 0.45 labels-hidden threshold), so a resource-dense view that can't fit at this scale opens
// zoomed to the floor on its first resources instead of fitting everything into an unreadable speck.
const MIN_FIT_SCALE = 0.55

// Blueprint-grid cell sizes (px at scale 1), kept in sync with the .topology background-image in
// topology.css. The inline background-size below scales these by the live zoom so the grid pans and
// zooms WITH the cards; a single source for the multiplier keeps the two sides aligned.
const GRID_MINOR = 26
const GRID_MAJOR = 130

export default function Topology(props: Props) {
  // Per-cluster "+N more" collapse expansion state (see topology/collapseState.ts for the key scheme).
  const { expandedClusters, setExpandedClusters, toggleCluster } = createExpandedClusters()

  // Capacity view (Nodes group-by) control: which single resource sizes the bars. App owns the
  // signal (so it round-trips through the URL + localStorage like group-by/relationships, making the
  // capacity view shareable); here it's a read accessor + a change request. The bars are always the
  // explicit Req + Use stacked form (the overlay/Use-only mode was retired after live review).
  const capResource = (): CapResource => props.capResource ?? 'cpu'
  const setCapResource = (r: CapResource) => props.onCapResource?.(r)

  // Project the full streamed edge set onto the active relationship categories (reversing the
  // referenced-as-parent ones) — the client-side replacement for the old server per-view Filter.
  // Drives the LAYOUT and the selection-spotlight/fit (related()), so clicking a node only lights
  // and frames what's actually drawn. ownerName() still scans the full props.edges — name
  // shortening is a readability aid independent of which relationships are toggled on.
  const displayEdges = createMemo(() => projectEdges(props.edges, props.relFilter ?? EMPTY_RELS))

  // The relationship grouping is the default — an absent groupBy falls through to it (see the layout
  // memo's else branch), so "is this the relationship view" must treat undefined as yes, not just an
  // explicit 'relationship'. The orphan logic below keys off this so it engages on the default landing.
  const isRelGrouping = () => props.groupBy !== 'kind' && props.groupBy !== 'nodes'
  // Orphaned resources: nodes no DISPLAYED edge touches (relationship grouping only — the other views
  // group by kind/host, where "unconnected" is meaningless). Relative to the active relFilter, exactly
  // like the orphan blocks layoutGraph folds, so toggling a relationship reclassifies them in lockstep.
  const orphanIds = createMemo(() => {
    if (!isRelGrouping()) return EMPTY_IDS
    const touched = new Set<string>()
    for (const e of displayEdges()) (touched.add(e.from), touched.add(e.to))
    const s = new Set<string>()
    for (const n of props.nodes) if (!touched.has(n.id)) s.add(n.id)
    return s
  })
  // The nodes actually laid out: the full set minus hidden orphans. Orphans hide only in the
  // relationship grouping when "Show orphaned" is off — EXCEPT a Degraded orphan stays visible while the
  // Degraded health filter is active, so "show me what's broken" reaches unconnected trouble too (the
  // user's smoother-investigation ask). Drops only orphans, never folded nodes, so the collapse-pill
  // counts downstream stay honest.
  const visibleNodes = createMemo(() => {
    if (!isRelGrouping() || props.showOrphaned) return props.nodes
    const orph = orphanIds()
    if (orph.size === 0) return props.nodes
    const keepDegraded = props.healthFilter === 'Degraded'
    return props.nodes.filter((n) => !orph.has(n.id) || (keepDegraded && n.health === 'Degraded'))
  })

  const layout = createMemo(() => {
    const edges = displayEdges()
    // Kind grouping: every resource in a per-kind box; the projected edges still draw on top
    // (suppressed until selection — see renderedEdges) so the cross-kind matrix stays readable.
    // While triaging by the health legend ("show me Degraded"), bias each fold's visible
    // representatives toward matching cards so the fold's face shows the trouble, not arbitrary
    // healthy siblings. Health-filter only (a discrete click); live search stays fade-only (no
    // per-keystroke relayout — see the fade comment below). The Kind and relationship branches
    // both read healthFilter (relayout on toggle is acceptable for a click); Nodes does not.
    if (props.groupBy === 'kind') {
      const hf = props.healthFilter
      return layoutGraphByKind(props.nodes, edges, expandedClusters(), hf ? (n) => n.health === hf : undefined)
    }
    // Nodes grouping: the capacity & usage visualization — node tracks (length ∝ allocatable) with
    // pods as usage-sized segments, reserved-vs-actual bars, expandable to per-pod bullets. Driven by
    // the live metrics-server usage feed (props.capacity.usage) + the active resource toggle.
    if (props.groupBy === 'nodes')
      return layoutGraphByCapacity(props.capacity?.nodes ?? [], props.capacity?.usage?.items, capResource(), props.namespace ?? '', expandedClusters())
    // Relationship grouping (default): left-to-right depth columns following the displayed
    // relationship edges. A card is far wider than it is tall, so a parent's children read better
    // stacked in a vertical column to the right (LR). Orphans (no displayed edge) are split OUT of the
    // tree and laid out Kind-view style in a section BELOW it (layoutGraphWithOrphans), so the tree
    // reads as the relationship backbone and the loose resources read as a per-kind inventory. The
    // caller-side split keys off orphanIds; the health filter biases EVERY fold's representatives —
    // sibling-subtree pills, hub leaf grids, orphan kind-folds — like the Kind view.
    const orph = orphanIds()
    const connected = orph.size ? visibleNodes().filter((n) => !orph.has(n.id)) : visibleNodes()
    const orphans = orph.size ? visibleNodes().filter((n) => orph.has(n.id)) : []
    const hf = props.healthFilter
    return layoutGraphWithOrphans(connected, orphans, edges, expandedClusters(), hf ? (n) => n.health === hf : undefined)
  })
  // Auto-expand the single fold hiding a navigated-to selection (Enter-cycle / j-k / deep-link
  // targets are often folded behind a "+N more" pill) — see topology/collapseState.ts.
  autoExpandSelection({ selectedId: () => props.selectedId, layoutNodes: () => layout().nodes, setExpandedClusters })
  // Kind grouping draws a faint kind-label band above each kind box so the operator can scan
  // "this section is all Pods, that's all Services" without inferring it from card kinds.
  // Kind label bands. The Kind grouping bands every box; the relationship grouping bands ONLY its
  // orphan section (the trees below read by their backbone, not by kind), reusing the same per-kind box
  // visual so the loose resources look exactly like the Kind view (the user's ask). Nodes view: none.
  const groups = createMemo(() => {
    if (props.groupBy === 'kind') return kindGroups(layout())
    if (isRelGrouping()) return (layout() as OrphanLayout).orphanGroups ?? []
    return []
  })
  // The relationship grouping's orphan section gets a caption + rule marking the boundary, so the
  // kind-grouped boxes below read explicitly as "unconnected" rather than as more of the tree above.
  // Null in the Kind view (every box is a kind band there, so no single section to caption) and when
  // there are no orphans on screen. Bounds derive from the orphan kind bands.
  const orphanSection = createMemo(() => {
    if (props.groupBy === 'kind' || !isRelGrouping()) return null
    const g = groups()
    if (g.length === 0) return null
    const x = Math.min(...g.map((r) => r.x))
    const y = Math.min(...g.map((r) => r.y))
    const right = Math.max(...g.map((r) => r.x + r.width))
    return { x, y, width: right - x }
  })
  // Nodes grouping: the capacity layout's per-node row model (tracks, segments, bullets). Empty for
  // every other group-by. Cast is safe — layout() returns a CapacityLayout exactly when groupBy is
  // 'nodes' (the dispatch above), and CapacityLayout is a Layout superset.
  const capRows = createMemo<CapRow[]>(() => (props.groupBy === 'nodes' ? (layout() as CapacityLayout).rows : []))
  const capInfo = createMemo(() => layout() as CapacityLayout)
  // In the Nodes (capacity) view, "frame the selection" means frame the whole node ROW the selected
  // pod (or node) lives in — not its related() subtree, whose edges come from the namespace graph,
  // not this cluster-wide feed. Returns the row's box in center convention, or null when the id
  // isn't on any row. (item: selecting a pod fits to the node it runs on.)
  const capRowBoxFor = (id: string | null) => {
    if (props.groupBy !== 'nodes' || !id) return null
    const row = capRows().find((r) => r.node?.id === id || r.allPodIds.includes(id))
    if (!row) return null
    return { x: row.x + row.width / 2, y: row.y + row.height / 2, width: row.width, height: row.height }
  }
  // Expanding a node row reveals its per-pod bullets (much taller); collapsing folds them back (much
  // shorter). EITHER way, re-fit the viewport to that row's new box: on expand the operator sees the
  // pods they just opened, and on collapse they zoom back IN to the node instead of being stranded at
  // the zoomed-out scale the expanded row needed (the user's "zoom back to the collapsed node"). capRows()
  // is read AFTER toggling — the memo recomputes synchronously, so the box already reflects the new
  // (expanded or collapsed) geometry; the rAF lets the layout/DOM settle before fitting.
  const toggleCapRow = (host: string) => {
    toggleCluster(`host:${host}`)
    if (!svg) return
    const r = capRows().find((row) => row.host === host)
    if (!r) return
    // Expand and collapse re-fit differently. Collapse → a short row; fitCapBox centres it (zoom back IN
    // to the node). Expand → a row stacked tall with per-pod cards; centring its full height would crush
    // the width-proportional bars (see fitCapRowExpanded), so drive that fit from the width and top-anchor.
    if (expandedClusters().has(`host:${host}`)) fitCapRowExpanded(r)
    else fitCapBox({ x: r.x, y: r.y, width: r.width, height: r.height })
  }
  // Expanding a node reveals its per-pod cards, stacking the row to (potentially) thousands of px tall.
  // Fitting that whole height (the prior behaviour) crushed the WIDTH-proportional bars — the entire point
  // of this view — to noise (a 58-pod node drew 4px-tall cards). Instead drive the zoom from the row WIDTH
  // so the bars read at their true global scale; when the card stack is taller than the viewport, anchor it
  // to the TOP (cards are ordered largest-footprint-first — by max(reserved, used), so a big reserver
  // and a big live user both float up — so the heaviest pods sit up top and the operator pans down for
  // the long tail) rather than centring an unreadable whole.
  const fitCapRowExpanded = (r: { x: number; y: number; width: number; height: number }) => {
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
    const availH = Math.max(1, rect.height - topInset)
    const padding = 60
    const scale = Math.max(MIN_FIT_SCALE, Math.min(1.2, (rect.width - padding * 2) / r.width))
    const cx = r.x + r.width / 2
    const tx = rect.width / 2 - cx * scale
    const fits = r.height * scale <= availH - padding * 2
    const ty = fits
      ? topInset + availH / 2 - (r.y + r.height / 2) * scale
      : topInset + padding - r.y * scale
    cancelAnimationFrame(selFitFrame)
    selFitFrame = requestAnimationFrame(() => animateTo({ scale, tx, ty }))
  }
  // A pod-card click both SELECTS the pod (opening the drawer) and wants to zoom to that card — but the
  // selection-fit effect, reacting to the same selectedId change, would otherwise re-frame the whole node
  // row. Setting this ref before onSelect tells that effect to frame the pod card instead, just this once.
  let capPodFitBox: { x: number; y: number; width: number; height: number } | null = null
  // fitCapBox animates the viewport to frame a capacity-view box (a node row, or a single expanded pod
  // card). Takes a top-left box; selectionMaxScale lets a small pod card zoom in close while a tall
  // expanded node row stays moderate. Deferred a frame so a just-toggled layout has settled first.
  const fitCapBox = (b: { x: number; y: number; width: number; height: number }) => {
    if (!svg) return
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2, width: b.width, height: b.height }
    cancelAnimationFrame(selFitFrame)
    selFitFrame = requestAnimationFrame(() => animateTo(fitNodeSet([center], selectionMaxScale)))
  }
  // Relationship grouping has no kind/host container, so a fold's siblings + pill get a dedicated
  // grouping frame. Kind/Nodes already box by kind/host — a second frame there would double-border,
  // so connGroups is empty for those.
  const connFrames = createMemo(() =>
    props.groupBy !== 'kind' && props.groupBy !== 'nodes' ? connGroups(layout()) : [],
  )
  // Hint shown under the empty-state message, describing the current lens (grouping +
  // relationships) so an empty canvas still tells the operator what they're looking through.
  const emptyHint = () => {
    if (props.groupBy === 'nodes') return 'Pods grouped by the node they run on'
    if (props.groupBy === 'kind') return 'Every resource grouped by kind'
    const rels = [...(props.relFilter ?? EMPTY_RELS)]
    if (rels.length === 0) return 'No relationships selected — toggle one in the toolbar above'
    const labels = REL_CATEGORIES.filter((c) => rels.includes(c.id)).map((c) => c.label)
    return `Showing ${labels.join(', ')} relationships`
  }
  // Relationship toggle chips: one per category actually present in the graph (mirroring how the
  // kind chips derive from kinds present), each badged with how many of its edges exist.
  const relChips = createMemo(() => {
    const present = relCategoriesPresent(props.edges)
    return REL_CATEGORIES.filter((c) => present.has(c.id)).map((c) => {
      const types = new Set(c.edges)
      return { ...c, count: props.edges.filter((e) => types.has(e.type)).length }
    })
  })
  // Departing-node fade-out + the id-keyed reconciled card store (see topology/exitAnimation.ts).
  const { exitingIds, renderNodes } = createExitAnimation({ layoutNodes: () => layout().nodes, groupBy: () => props.groupBy })

  // Map each node to the longest PREFIX-PARENT name (prefixParentNames), so a child renders relative to
  // its parent in the tree. Walks the full edge set — see names.ts for the prefix/longest-match rules.
  const ownerName = createMemo(() => prefixParentNames(props.nodes, props.edges))

  // Age cards in place off the shared app clock (one 30s ticker for the whole UI — the drawer reads the
  // same one, so canvas and sidebar ages stay in lockstep). now() re-runs age memos when it ticks.
  const now = useNow
  const ageOf = (n: KNode) => (n.createdAt ? relativeAge(n.createdAt, now()) : '')
  // Right-side badge on the name line: combine restart count (when present) and age (when known).
  // Operators read either as a "needs a look" signal — a high restart count or a freshly-restarted
  // pod 30s old is just as interesting as a 90-day-old workload.
  const rightBadge = (n: KNode) => {
    const r = n.restarts ?? 0
    const age = ageOf(n)
    if (r > 0 && age) return `↻${r} · ${age}`
    if (r > 0) return `↻${r}`
    return age
  }
  // The parent-prefix dedup ("…-5tkrx") assumes the parent card is visibly adjacent — true only in
  // the relationship tree. In the Kind view pods from different apps share one box, so a deduped
  // name hides exactly the part that tells them apart; show the (middle-truncated) full name there.
  const label = (n: KNode) => cardName(n.name, props.groupBy === 'relationship' ? ownerName().get(n.id) : undefined)

  // Search query accessors: the query is owned by the parent so it resets on namespace/view change.
  const query = () => props.search
  const setQuery = (q: string) => props.onSearch(q)
  // The card currently under the pointer (relationship view). Feeds the spotlight as a hover PREVIEW —
  // hovering a card with the drawer closed fades to its direct neighbours, without selecting. Declared
  // before createSpotlight: its `related` memo runs eagerly on creation and reads hoverId() (TDZ).
  const [hoveredNodeId, setHoveredNodeId] = createSignal<string | null>(null)
  // Selection spotlight + search/kind-filter fade composition (see topology/spotlight.ts — the
  // fade precedence order lives there and is load-bearing).
  const { related, matches, matchOrdered, matchPos, activeKinds, nodeKindOk, nodeFaded, nodeById, edgeFaded, edgeAdjacent, edgeFlowLit } = createSpotlight({
    nodes: () => props.nodes,
    visibleNodes,
    displayEdges,
    layoutNodes: () => layout().nodes,
    selectedId: () => props.selectedId,
    query,
    kindFilter: () => props.kindFilter,
    healthFilter: () => props.healthFilter,
    hoverId: () => hoveredNodeId(),
    groupBy: () => props.groupBy,
  })
  // The Nodes (capacity) view draws ONLY cluster Nodes + this namespace's Pods, sourced from the
  // cluster-wide capacity feed (props.capacity), NOT props.nodes' full per-kind inventory. Every count
  // that describes this view — the health pills (healthStats) and the bottom overlay — reads from this
  // displayed set, so none advertises a ConfigMap/Secret/CR the capacity canvas never draws (the
  // "182 resources" over a dozen pod bars bug). Pods alone are the grouped members the count headlines.
  const capacityShown = createMemo(() => {
    const ns = props.namespace ?? ''
    const clusterScope = ns === '' || ns === CLUSTER_SCOPE
    return (props.capacity?.nodes ?? []).filter(
      (n) => n.kind === 'Node' || (n.kind === 'Pod' && (clusterScope || n.namespace === ns)),
    )
  })
  const shownPods = createMemo(() => capacityShown().filter((n) => n.kind === 'Pod'))
  // True count of resources matching the active filter intersection (search ∩ health ∩ kind), over the
  // FULL node set. The bottom-left overlay must agree with the health pill / kind chip totals (which
  // both count props.nodes), but a folded collapse pill removes matching nodes from layout().nodes —
  // so counting only what's lit on canvas undercounts (a Degraded filter on a namespace whose troubled
  // Workflows are mostly folded read "15 of 341" while the pill said 57). Count over props.nodes so the
  // overlay reports the honest match total; the badged pills already point to the folded ones. In the
  // Nodes view the population is instead the displayed pods (capacityShown) — the only members drawn.
  const filterMatchCount = createMemo(() => {
    const q = query().trim()
    const hf = props.healthFilter
    const ak = activeKinds()
    const pool = props.groupBy === 'nodes' ? shownPods() : visibleNodes()
    return pool.filter(
      (n) => (!q || nodeMatches(n, q)) && (!hf || n.health === hf) && (!ak || ak.has(n.kind)),
    ).length
  })
  // Counts + worst-health per kind in the current view. Chips order by count (most-common first,
  // typically Pod) — predictable so the row doesn't reshuffle when a single resource flips state.
  // The per-kind worst health drives a small severity dot on the chip so the operator
  // spots WHICH kinds carry trouble without scanning the canvas; preserves the stable order while
  // still surfacing the answer to "where do I look first".
  // Per-kind count + worst-health, folding a collapsed pill's hidden nodes back so chips stay honest —
  // see computeKindStats for the fold-back rule.
  const kindStats = createMemo(() => computeKindStats(layout().nodes))
  const kindChips = createMemo(() =>
    [...kindStats().entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([k, s]) => ({ kind: k, count: s.count, worst: s.worst })),
  )
  // Health distribution across the view's resources — the data behind the toolbar's health-filter
  // pills and the proportion stripe. Counts props.nodes directly: those are the raw graph nodes
  // (no synthetic collapse pills — pills are layout-only), and a collapsed cluster only hides LIVE
  // resources that are still in props.nodes, so the totals are the true per-health counts.
  // EXCEPT in the Nodes (capacity) view: that canvas draws only cluster Nodes + this namespace's
  // Pods — not props.nodes' full inventory (Deployments, Services, ConfigMaps, …). Tally health
  // over exactly the displayed set (every Node, plus own-namespace Pods from the cluster-wide
  // capacity feed) so the pills + stripe describe what's actually on screen.
  const healthStats = createMemo(() => {
    const c = {} as Record<Health, number>
    if (props.groupBy === 'nodes') {
      for (const n of capacityShown()) c[n.health] = (c[n.health] ?? 0) + 1
      return c
    }
    // When orphans are hidden, the pills count only what's on the canvas — EXCEPT Degraded, which always
    // counts every degraded resource (orphaned or not). So the Degraded pill advertises unconnected
    // trouble the operator can't otherwise see, and clicking it (visibleNodes' keepDegraded) reveals it.
    const hideOrph = isRelGrouping() && !props.showOrphaned
    for (const n of props.nodes) {
      if (hideOrph && n.health !== 'Degraded' && orphanIds().has(n.id)) continue
      c[n.health] = (c[n.health] ?? 0) + 1
    }
    return c
  })
  // Only surface states actually present (stable HEALTH_ORDER), so the row reads as a quiet "all
  // healthy" when nothing's wrong rather than a line of zeros.
  const shownHealth = createMemo(() => HEALTH_ORDER.filter((h) => healthStats()[h]))
  // Capacity-view hover spotlight + cursor-following tooltip (see topology/capacityHover.ts).
  const { capTip, setCapTip, showTip, setCapHover, capRowFaded, capSegFaded, capAggFaded } = createCapacityHover({
    capacityNodes: () => props.capacity?.nodes ?? [],
    nodeFaded,
    selectedId: () => props.selectedId,
    matches,
    healthFilter: () => props.healthFilter,
  })
  // A collapsed pill counts how many of its hidden nodes the operator is currently searching/filtering
  // for, so the badge ("● N match") signals a fold is hiding a result without revealing it (FR-006/D7).
  // Only an EXPLICIT query counts — a live search or the health legend filter. Selection is navigation,
  // not a query: selecting a resource lights its whole related subtree (related()), and a fold inside
  // that subtree would otherwise report every hidden sibling as a "match" even with an empty search box
  // — which reads as a phantom search hit. So the badge stays away unless the operator actually typed a
  // search or picked a health filter.
  const collapseMatchCount = (meta: CollapseMeta): number => {
    const q = query().trim()
    const hit = (n: KNode): boolean => {
      if (q) return nodeKindOk(n.kind) && nodeMatches(n, q)
      if (props.healthFilter) return n.health === props.healthFilter
      return false
    }
    return meta.hidden.reduce((c, n) => c + (hit(n) ? 1 : 0), 0)
  }
  // A collapsed fold can hide a non-healthy resource — e.g. the one Degraded Service the "needs
  // attention" jump drops the operator into a namespace to find. The match badge only fires when a
  // search or health-filter is already active, so a fresh, unfiltered view reads as all-green and the
  // problem stays invisible behind a neutral "+ show N more" pill. Surface the worst health the fold
  // hides, health-coloured, so a troubled fold looks different from a benign one (Contrast + explicit
  // over implicit). Returns null when every hidden node is Healthy.
  const collapseHiddenTrouble = (meta: CollapseMeta): { count: number; worst: Health } | null => {
    const worst = worstNonHealthy(meta.hidden.map((n) => n.health))
    if (!worst) return null
    const count = meta.hidden.reduce((c, n) => c + (n.health === 'Healthy' ? 0 : 1), 0)
    return { count, worst }
  }
  // Whether a collapse pill should dim. A kind filter fades a pill of an unselected kind (composing
  // like individual cards do). Additionally, while triaging by an explicit query (search or the health
  // legend), a COLLAPSED pill that hides zero matches is noise — fade it so the eye lands on the badged
  // pills that actually hold results (Contrast), exactly as non-matching cards fade. An expanded pill's
  // members are shown as real cards that fade individually, so the refold control is left alone.
  const pillFaded = (meta: CollapseMeta): boolean => {
    const ak = activeKinds()
    if (ak && !ak.has(meta.groupKind)) return true
    if (!meta.expanded && (query().trim() || props.healthFilter) && collapseMatchCount(meta) === 0) return true
    return false
  }
  // Kind grouping draws NO arrows at all: the cross-kind backbone fans across the whole matrix with
  // no meaningful routing (cards sit in per-kind boxes, not along their links), so the lines are pure
  // noise — even on selection, where they tangled across boxes rather than tracing a path. With no
  // relationships drawn, the selection spotlight is also suppressed here (related() returns null for
  // 'kind' — see spotlight.ts): fading "related" cards scattered across the boxes signals nothing the
  // operator can follow. Every other view keeps its edges (their layouts route them meaningfully).
  const renderedEdges = createMemo(() => (props.groupBy === 'kind' ? [] : layout().edges))

  const [scale, setScale] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  // Endpoints of the edge currently under the pointer: in a dense graph an edge's two
  // cards can be far apart or buried, so hovering the edge halos both ends to answer "what does this
  // connect?" without selecting. Null when no edge is hovered.
  const [hoverEnds, setHoverEnds] = createSignal<{ from: string; to: string } | null>(null)
  const edgeEndpoint = (id: string) => {
    const h = hoverEnds()
    return !!h && (h.from === id || h.to === id)
  }
  let svg: SVGSVGElement | undefined
  // The full-width control bar overlays the top of the canvas; the fit reads its live height so it
  // can centre the graph in the VISIBLE area below the bar instead of behind it.
  let toolbarEl: HTMLDivElement | undefined
  // The Kinds filter is a strict single line that scrolls horizontally when a namespace has more kinds
  // than fit. Without an edge cue the truncation reads as "that's all there is" (macOS hides the
  // scrollbar until use), so an operator misses off-screen kinds. Track which edges still have content
  // and fade them (scrollEdges + the .scroll-l/.scroll-r mask classes).
  let kindsRowEl: HTMLDivElement | undefined
  const [kindsEdges, setKindsEdges] = createSignal<ScrollEdges>({ l: false, r: false })
  const updateKindsEdges = () => {
    const el = kindsRowEl
    if (el) setKindsEdges(scrollEdges(el.scrollLeft, el.scrollWidth, el.clientWidth))
  }
  // Recompute when the chip set changes (a namespace/view switch changes how many kinds overflow). The
  // <For> commits a tick after kindChips(), so defer the DOM measure to the microtask queue.
  createEffect(() => {
    kindChips() // track
    queueMicrotask(updateKindsEdges)
  })
  let pointerDown = false
  let dragging = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  // Pointer velocity (px/ms), EMA-smoothed across recent moves, for the flick-to-coast momentum on
  // drag release.
  let vx = 0
  let vy = 0
  let lastMoveT = 0
  // Two-finger pinch zoom (touch). Phones send no wheel events, so without this the graph simply
  // could not be zoomed on a touch screen (the only zoom paths were wheel/trackpad and keyboard).
  // Tracks live touch points by pointerId; at exactly two the gesture switches from pan to zoom.
  // touch-action: none on the svg (index.css) keeps the browser from stealing these as native
  // scroll/zoom and cancelling the pointer stream.
  const pinchPts = new Map<number, { x: number; y: number }>()
  let pinchDist = 0

  // Smoothly animate viewport (tx/ty/scale) to a target over ~360ms with easeOutCubic.
  // Replaces the prior "snap-instantly" updates so namespace/view switches and selection focus
  // changes glide instead of jumping — easier for a human to track what just changed.
  let animFrame = 0
  let selFitFrame = 0 // rAF handle for the deferred selection-fit
  // A selection-fit waiting for the canvas to reach its post-drawer width. Opening the drawer mounts
  // a flex sibling that shrinks the SVG, but the mount+reflow lands an unpredictable frame or two
  // after the selectedId change (the drawer is even absent from the DOM on the first rAF) — so a
  // fixed rAF count measured the FULL pre-drawer width and framed the selection half-under the drawer
  // (the reported "zoom centres on the canvas incl. the hidden part"). Instead the selection-fit is
  // run from the SVG ResizeObserver, which fires exactly when that shrink lands (width then settled),
  // or immediately when the drawer is already open (re-selection, no resize to wait for).
  let pendingSelFit: { inSet: { x: number; y: number; width: number; height: number }[]; focus?: { x: number; y: number } } | null = null
  const runSelFit = () => {
    if (!pendingSelFit || !svg) return
    // Only fit once the canvas is actually in its drawer-open (shrunk) state. The drawer mounts a
    // frame or two after selection, and a re-selection can briefly bounce the canvas back to full
    // width — fitting against that full width would frame the selection half-under the drawer. So
    // bail while the SVG still spans its whole .main column and let the ResizeObserver re-invoke this
    // when the drawer's shrink lands. (mainW unknown → no occlusion to wait for → fit immediately.)
    const mainW = svg.closest('.main')?.clientWidth
    if (mainW != null && svg.getBoundingClientRect().width >= mainW - 1) return
    const { inSet, focus } = pendingSelFit
    pendingSelFit = null
    animateTo(fitNodeSetFloored(inSet, selectionMaxScale, focus))
  }
  let cardClickTimer: ReturnType<typeof setTimeout> | undefined // deferred deselect, cancelled by dblclick
  function animateTo(target: { scale: number; tx: number; ty: number }, duration = 360) {
    cancelAnimationFrame(animFrame)
    const s0 = scale(), tx0 = tx(), ty0 = ty()
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration)
      const e = 1 - Math.pow(1 - t, 3)
      setScale(s0 + (target.scale - s0) * e)
      setTx(tx0 + (target.tx - tx0) * e)
      setTy(ty0 + (target.ty - ty0) * e)
      if (t < 1) animFrame = requestAnimationFrame(tick)
    }
    animFrame = requestAnimationFrame(tick)
  }
  onCleanup(() => {
    cancelAnimationFrame(animFrame)
    cancelAnimationFrame(selFitFrame)
    clearTimeout(cardClickTimer)
  })

  // computeFitFor: scale + translate that frames the given bounds into the SVG viewport with the
  // given padding. Caps max scale so single-card selections don't zoom in to absurd sizes.
  // computeFitFor reads the live viewport (the SVG rect + the overlaying toolbar's height) and
  // delegates the framing geometry to the pure fitBox (viewport.ts), which the unit tests pin.
  function computeFitFor(minX: number, minY: number, maxX: number, maxY: number, maxScale: number) {
    const rect = svg!.getBoundingClientRect()
    const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
    return fitBox({ minX, minY, maxX, maxY }, { width: rect.width, height: rect.height, topInset }, maxScale)
  }

  // fitNodeSet: frames a set of cards. boundingBox + selectionMaxScale + fitBox are
  // pure (viewport.ts); this just threads the live viewport in via computeFitFor. maxScale is a
  // constant for fit-all or selectionMaxScale for a selection (it needs the box dims, hence the fn form).
  function fitNodeSet(
    nodes: { x: number; y: number; width: number; height: number }[],
    maxScale: number | ((w: number, h: number) => number),
  ) {
    const bb = boundingBox(nodes)
    const ms = typeof maxScale === 'function' ? maxScale(bb.width, bb.height) : maxScale
    return computeFitFor(bb.minX, bb.minY, bb.maxX, bb.maxY, ms)
  }

  // fitLit frames a lit node set at the standard 1.4× cap, then eases it out by ×0.92 for the same
  // breathing room the manual Fit leaves. Most callers animate straight to it; the automatic filter-fit
  // first checks the returned scale against the legibility floor before committing.
  function fitLit(lit: { x: number; y: number; width: number; height: number }[]) {
    const target = fitNodeSet(lit, 1.4)
    target.scale *= 0.92
    return target
  }

  // Floored variants of the two above: like computeFitFor/fitNodeSet but they never zoom out past
  // MIN_FIT_SCALE — instead of shrinking a huge graph to an unreadable speck they pin to the floor and
  // frame around `focus` (the selected card for a selection, the top-left corner for a plain fit-all),
  // keeping as much of the rest in view as legibility allows. The shared answer to the operator's "auto-
  // fit zooms out too far, the text becomes unreadable". The pure math lives in viewport.ts (unit-tested).
  function computeFitFloored(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    opts: { maxScale: number; focus: { x: number; y: number } },
  ) {
    const rect = svg!.getBoundingClientRect()
    const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
    return fitBoxFloored(
      { minX, minY, maxX, maxY },
      { width: rect.width, height: rect.height, topInset },
      { minScale: MIN_FIT_SCALE, ...opts },
    )
  }

  // fitNodeSetFloored frames a node set with the floor applied, centring on `focus` (the selected card's
  // centre) when the set is too big to fit legibly. focus defaults to the box centre so a caller that
  // just wants a floored-and-centred frame can omit it.
  function fitNodeSetFloored(
    nodes: { x: number; y: number; width: number; height: number }[],
    maxScale: number | ((w: number, h: number) => number),
    focus?: { x: number; y: number },
  ) {
    const bb = boundingBox(nodes)
    const ms = typeof maxScale === 'function' ? maxScale(bb.width, bb.height) : maxScale
    const f = focus ?? { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 }
    return computeFitFloored(bb.minX, bb.minY, bb.maxX, bb.maxY, { maxScale: ms, focus: f })
  }

  // Fit-all on a real scope switch (context/namespace) OR a client-side restructure (grouping /
  // relationship-filter change) — but NOT on node-count churn (a collapse expand or an SSE
  // add/remove must preserve the operator's pan/zoom). `pendingFit` defers the fit until the
  // layout actually has geometry (the first SSE frame can arrive after a flip, while width is
  // still 0). First mount is a snap (no animation); later switches glide.
  let fitScope = 'init'
  let layoutKey = 'init'
  let pendingFit = true
  let firstFit = true
  // freshData closes a race that exists ONLY for real scope switches: App closes the old SSE and
  // setGraph(emptyState()) on a ctx/ns change, so the new namespace's nodes stream in async — for
  // one beat layout() is computed from the OLD nodes (a giant transient box). width === 0 is the
  // reliable "the new scope's data is incoming" marker; we refuse to fit until we've seen that
  // reset, skipping the stale pre-reset layout. A grouping/relationship change is DIFFERENT — it
  // re-projects the SAME, already-present graph (no resubscribe, no empty frame), so it must fit
  // immediately and must NOT arm the freshData wait, or the fit would never fire.
  let freshData = true
  const relKey = () => [...(props.relFilter ?? EMPTY_RELS)].sort().join(',')
  createEffect(() => {
    const l = layout()
    const scope = props.scope ?? ''
    const lk = `${props.groupBy ?? ''}|${relKey()}|${props.showOrphaned ? 'o' : ''}`
    if (scope !== fitScope) {
      fitScope = scope
      layoutKey = lk
      pendingFit = true
      freshData = false // real scope switch: wait for the graph reset before trusting geometry
    } else if (lk !== layoutKey) {
      layoutKey = lk
      pendingFit = true
      freshData = true // client-only restructure: data already present, fit the next frame
    }
    if (!svg) return
    if (l.width === 0) {
      freshData = true // the graph was cleared for the incoming scope; the next non-empty is real
      return
    }
    if (!pendingFit || !freshData) return
    if (props.selectedId) {
      pendingFit = false // selection-fit owns this scope's first frame; don't also fit-all
      return
    }
    pendingFit = false
    // Frame the whole graph driven by the canvas WIDTH (fitBoxFloored): a tall tree fills the width and
    // overflows vertically (top-anchored, scroll down) instead of shrinking to fit the height into an
    // unreadable speck. Still never below MIN_FIT_SCALE, never above 1.4. (The 60px padding is the only
    // edge margin — no extra breathing factor here, so the width is used to maximise text size.)
    const target = computeFitFloored(0, 0, l.width, l.height, { maxScale: 1.4, focus: { x: 0, y: 0 } })
    if (firstFit) {
      firstFit = false
      setScale(target.scale)
      setTx(target.tx)
      setTy(target.ty)
    } else {
      animateTo(target)
    }
  })

  // Track SVG size so resizes keep the graph on-screen. Drawer open/close and window
  // resizes both squeeze/grow the SVG; without this the existing pan stays at old coords and the
  // graph can drift off-screen. Closing the drawer is the dominant trigger, and the operator's zoom
  // must survive it (see the deselect branch above) — so preserve the current scale and only
  // re-clamp the translate into the resized viewport, rather than re-fitting to fit-all and throwing
  // the zoom away. `f` / double-click still fit on demand. Selection owns the shrink case (drawer
  // opening). Debounce via rAF so a continuous resize (window drag) doesn't fight the animation.
  // Guarded for jsdom (no ResizeObserver).
  onMount(() => {
    if (!svg || typeof ResizeObserver === 'undefined') return
    let rafId = 0
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        updateKindsEdges() // bar width changed → re-evaluate which kind chips overflow
        if (!svg) return
        // The drawer just opened and shrank the canvas: the width is now settled, so run the
        // selection-fit that was waiting for it (frames the selection against the visible canvas,
        // not the pre-drawer width). Must precede the selectedId guard below — the fit IS the
        // selected case here.
        if (pendingSelFit) {
          runSelFit()
          return
        }
        const l = layout()
        if (l.width === 0) return
        if (props.selectedId) return // selection-fit owns this case
        // Snap, not animate: a resize is a viewport change, not a user-initiated transition.
        cancelAnimationFrame(animFrame) // its target was computed against the old viewport
        const c = clampTranslate(tx(), ty())
        setTx(c.tx)
        setTy(c.ty)
      })
    })
    ro.observe(svg)
    onCleanup(() => {
      if (rafId) cancelAnimationFrame(rafId)
      ro.disconnect()
    })
  })

  // iOS Safari ignores `touch-action: none` for PINCH: a two-finger gesture is routed to its
  // non-standard `gesture*` events and zooms the whole PAGE, so our pointer-based pinch never gets
  // to zoom the canvas (the reported "pinch zooms the page, not the graph" bug). Prevent those
  // WebKit-only gesture events on the canvas so the page stops hijacking the pinch; the pointer
  // pinch handler above then drives the canvas zoom on every platform. Scoped to the svg, NOT a
  // viewport `user-scalable=no` — the latter would also kill accessibility zoom for the drawer/
  // sidebar text. Delegated Solid handlers can't do this (touch/gesture listeners on document are
  // passive, so preventDefault is a no-op); attach natively, cancelable, on the element itself.
  onMount(() => {
    if (!svg) return
    const preventGesture = (e: Event) => e.preventDefault()
    svg.addEventListener('gesturestart', preventGesture)
    svg.addEventListener('gesturechange', preventGesture)
    onCleanup(() => {
      svg?.removeEventListener('gesturestart', preventGesture)
      svg?.removeEventListener('gesturechange', preventGesture)
    })
  })

  // When the selection changes, smoothly frame the selected resource's full subtree (computed by
  // related()) — answers the user's "zoom to selected + related" without requiring a manual Fit.
  // Selection cleared → keep the current pan/zoom untouched. Clicking the canvas to close the drawer
  // is the operator's way of saying "show me the next resource", so re-fitting to fit-all here just
  // throws the viewport away and forces them to re-zoom (`f` / double-click still fit on demand).
  createEffect(
    on(
      () => props.selectedId,
      (id) => {
        if (!svg) return
        const l = layout()
        if (l.width === 0) return
        if (!id) {
          pendingSelFit = null // deselect: drop any fit waiting on the drawer so it can't fire late
          return
        }
        // Nodes view: frame the node ROW the selection sits in — UNLESS the selection came from clicking
        // an expanded pod card, in which case zoom to that card (the user's "click a pod box to read its
        // bars"). capPodFitBox is consumed once so a later keyboard/search selection of the same kind
        // still frames the whole row. Entering here means the id IS on a row (else fall through to the
        // relationship path below).
        const capRow = props.groupBy === 'nodes' && id ? capRows().find((r) => r.node?.id === id || r.allPodIds.includes(id)) : undefined
        if (capRow) {
          const podBox = capPodFitBox
          capPodFitBox = null
          if (podBox) {
            fitCapBox(podBox)
          } else if (expandedClusters().has(`host:${capRow.host}`)) {
            // Selecting the node NAME (opening its drawer) frames the row exactly like CLICKING the row
            // does (toggleCapRow): width-driven + top-anchored when expanded, centred when collapsed.
            fitCapRowExpanded(capRow)
          } else {
            fitCapBox({ x: capRow.x, y: capRow.y, width: capRow.width, height: capRow.height })
          }
          return
        }
        const r = related()
        if (!r) return
        const inSet = l.nodes.filter((n) => r.nodes.has(n.id))
        if (inSet.length === 0) return
        // Frame the selected subtree, but never below the legible floor: a resource whose related
        // subtree spans the whole namespace would otherwise zoom out to a speck (the operator's "click
        // a large resource and it gets too small"). When floored, centre on the SELECTED card itself so
        // it stays viewable, with as much of the surrounding subtree in view as the floor allows.
        const sel = inSet.find((n) => n.id === id)
        const focus = sel ? { x: sel.x, y: sel.y } : undefined
        // Run the fit only once the canvas is at its post-drawer width (see pendingSelFit). If the
        // drawer is ALREADY open (a re-selection: the SVG is narrower than its .main column), the
        // width is settled — fit on the next frame. Otherwise the drawer is opening; the SVG
        // ResizeObserver fires when it shrinks and runs the fit then, framing the visible canvas.
        pendingSelFit = { inSet, focus }
        // Try to fit next frame: if the drawer is already open (re-selection) the canvas is already
        // shrunk and runSelFit fits immediately; on a first selection the canvas is still full width,
        // so runSelFit bails and the SVG ResizeObserver re-invokes it once the drawer's shrink lands.
        cancelAnimationFrame(selFitFrame)
        selFitFrame = requestAnimationFrame(runSelFit)
      },
      { defer: true },
    ),
  )

  // Auto-fit to the lit subset when a DISCRETE filter (health legend / kind chips) toggles, so a
  // triage action — "show me what's Degraded" — frames the matches instead of leaving the operator
  // staring at faded healthy cards while the few matches sit off-screen ("11 of 336" with nothing
  // visible). The manual Fit already frames the lit subset; this just does it on the
  // toggle so the operator doesn't have to also reach for Fit. Deliberately scoped:
  //   - Search is excluded — it is incremental per-keystroke, so fitting on every character would
  //     make the viewport jump around while typing; the manual Fit covers it.
  //   - A selection owns the viewport (its own fit effect), so skip while one is active.
  //   - CLEARING a filter does not re-fit — leave the operator where they are (Fit/'f' reframe on
  //     demand), mirroring the deselect branch that preserves pan/zoom.
  //   - READABILITY GUARD: only fit-ALL when the matches cluster tightly enough to frame at a legible
  //     scale (≥ MIN_FIT_SCALE). When matches are SCATTERED across a tall layout (e.g. 55 degraded
  //     resources spread down a 340-resource namespace), their bounding box spans the whole canvas,
  //     so fitting it zooms to an unreadable speck (~0.04×) — strictly worse than not moving. But
  //     LEAVING the view put is its own dead end: the matches sit off-screen behind faded healthy
  //     cards, and the Enter-cycle / clickable-count affordance that would reach them is search-only
  //     (absent under a health/kind filter) — so a "show me what's Degraded" triage in a big namespace
  //     stranded the operator staring at greyed-out healthy resources (found live on team-a). So
  //     instead of bailing, we frame the SINGLE most-troubled match (severity-ordered) at a legible
  //     scale: a triage filter then ALWAYS lands the operator on a real result — the worst one — from
  //     which they can drill in or pan to the rest. (The manual Fit still frames all, speck or not.)
  // This does not weaken the "preserve pan/zoom on churn" rule: it keys on the filter signature, not
  // node count, so an SSE add/remove or a collapse expand never triggers it.
  const filterKey = () =>
    `${props.healthFilter ?? ''}|${[...(props.kindFilter ?? [])].sort().join(',')}`
  createEffect(
    on(filterKey, () => {
      if (!svg || props.selectedId) return
      if (!props.healthFilter && !activeKinds()) return // cleared → keep the current view
      const l = layout()
      if (l.width === 0) return
      const lit = l.nodes.filter((n) => !nodeFaded(n))
      if (lit.length === 0) return // filter matched nothing laid out — don't fly to an empty box
      const target = fitLit(lit)
      if (target.scale < MIN_FIT_SCALE) {
        // Scattered: framing all of them is a speck. Fall back to the single worst match so the
        // operator lands on a real result instead of faded healthy cards (see the guard comment).
        const litIds = new Set(lit.map((n) => n.id))
        const worst = orderedForNav(props.nodes.filter((n) => litIds.has(n.id)))[0]
        const ln = worst && lit.find((n) => n.id === worst.id)
        if (!ln) return
        const one = fitNodeSet([ln], selectionMaxScale)
        cancelAnimationFrame(selFitFrame)
        selFitFrame = requestAnimationFrame(() => animateTo(one))
        return
      }
      cancelAnimationFrame(selFitFrame)
      selFitFrame = requestAnimationFrame(() => animateTo(target))
    }, { defer: true }),
  )

  // clampTranslate keeps an overflowing layout covering the visible frame below the toolbar and at
  // least a margin of a smaller layout visible. A prospective scale lets zoom clamp its anchored
  // translate before the scale signal changes; fits bypass this helper by design.
  type CanvasView = { width: number; height: number; topInset: number }
  function currentView(viewport?: { width: number; height: number; topInset?: number }): CanvasView {
    const rect = viewport ?? svg!.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      topInset: viewport?.topInset ?? toolbarEl?.getBoundingClientRect().height ?? 0,
    }
  }

  function clampTranslate(
    txv: number,
    tyv: number,
    scalev = scale(),
    viewport?: { width: number; height: number; topInset?: number },
  ): { tx: number; ty: number } {
    const l = layout()
    if (!svg || l.width === 0) return { tx: txv, ty: tyv }
    const view = currentView(viewport)
    return clampPan(txv, tyv, { width: l.width * scalev, height: l.height * scalev }, view)
  }

  function scaleBounds(view: CanvasView): { min: number; max: number } {
    const l = layout()
    return zoomScaleBounds(
      { width: l.width, height: l.height },
      { width: NODE_WIDTH, height: NODE_HEIGHT },
      view,
    )
  }

  // Wheel handling distinguishes three gestures, matching the conventions Mac users expect (see
  // github.com/arto-app/Arto renderer/src/base-viewer-controller.ts for the same exp() smoothing):
  //   1. Trackpad pinch — arrives as a wheel event with ctrlKey=true synthesized by macOS.
  //   2. Cmd+scroll — explicit zoom intent on either pointer type.
  //   3. Regular wheel with deltaMode=LINE/PAGE — a classic mouse wheel; users expect zoom.
  //   4. Regular wheel with deltaMode=PIXEL — trackpad 2-finger scroll; users expect PAN.
  // Zoom factor uses Math.exp(-Δ * k) so a single mouse-wheel click and a flurry of trackpad
  // events both land at sensible cumulative zoom. k tuned smaller than Arto's 0.01 because kd's
  // canvas is denser and a 1.1x factor per click was overshooting.
  function onWheel(e: WheelEvent) {
    e.preventDefault()
    cancelAnimationFrame(animFrame) // direct wheel input owns the camera from this event onward
    const deltaScale = e.deltaMode === 0 ? 1 : e.deltaMode === 1 ? 10 : 20
    const isPinch = e.ctrlKey || e.metaKey
    const isMouseWheel = e.deltaMode !== 0 // LINE/PAGE deltas come from classic mice
    if (isPinch || isMouseWheel) {
      // Zoom toward the cursor, keeping the graph point under it fixed.
      const k = isPinch ? 0.012 : 0.006 // pinch is small-step; mouse wheel ticks are coarser
      const factor = Math.exp(-e.deltaY * deltaScale * k)
      const rect = svg!.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const oldScale = scale()
      const view = currentView(rect)
      const bounds = scaleBounds(view)
      const s = Math.min(Math.max(oldScale * factor, bounds.min), bounds.max)
      const c = clampTranslate(
        mx - ((mx - tx()) / oldScale) * s,
        my - ((my - ty()) / oldScale) * s,
        s,
        view,
      )
      setTx(c.tx)
      setTy(c.ty)
      setScale(s)
    } else {
      // Trackpad 2-finger scroll: pan in both axes. Both deltas are in pixel units already.
      // Clamp live so a flick can't scroll the graph entirely off-canvas.
      const c = clampTranslate(tx() - e.deltaX, ty() - e.deltaY)
      setTx(c.tx)
      setTy(c.ty)
    }
  }

  // Pan only after the pointer moves past a small threshold, so a plain click still reaches a
  // node's onClick (capturing the pointer on press would redirect the click to the SVG).
  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinchPts.size >= 2) {
        // Second finger landed: the gesture is now a zoom, not a pan — and not a click either,
        // so the pan machinery stands down entirely. A third+ finger is tracked but ignored —
        // the zoom keeps following the first two so it can't hijack an in-flight pinch.
        if (pinchPts.size === 2) {
          const [a, b] = [...pinchPts.values()]
          pinchDist = Math.hypot(b.x - a.x, b.y - a.y)
        }
        pointerDown = false
        dragging = false
        cancelAnimationFrame(animFrame)
        return
      }
    }
    pointerDown = true
    dragging = false
    startX = lastX = e.clientX
    startY = lastY = e.clientY
    vx = vy = 0
    lastMoveT = performance.now()
    cancelAnimationFrame(animFrame) // grabbing the canvas stops any in-flight coast
  }
  function onPointerMove(e: PointerEvent) {
    if (pinchPts.has(e.pointerId)) pinchPts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinchPts.size >= 2) {
      const [a, b] = [...pinchPts.values()]
      const dist = Math.hypot(b.x - a.x, b.y - a.y)
      if (pinchDist > 0 && dist > 0) {
        // Zoom toward the fingers' midpoint, keeping the graph point between them fixed — the
        // same anchored-zoom math as the wheel path, factored by the finger-distance ratio.
        const rect = svg!.getBoundingClientRect()
        const mx = (a.x + b.x) / 2 - rect.left
        const my = (a.y + b.y) / 2 - rect.top
        const oldScale = scale()
        const view = currentView(rect)
        const bounds = scaleBounds(view)
        const s = Math.min(Math.max(oldScale * (dist / pinchDist), bounds.min), bounds.max)
        const c = clampTranslate(
          mx - ((mx - tx()) / oldScale) * s,
          my - ((my - ty()) / oldScale) * s,
          s,
          view,
        )
        setTx(c.tx)
        setTy(c.ty)
        setScale(s)
      }
      pinchDist = dist
      return
    }
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
      // EMA-smooth the instantaneous velocity so one jittery sample doesn't dominate the flick.
      const now = performance.now()
      const dt = Math.max(1, now - lastMoveT)
      vx = 0.6 * vx + 0.4 * ((e.clientX - lastX) / dt)
      vy = 0.6 * vy + 0.4 * ((e.clientY - lastY) / dt)
      lastMoveT = now
    }
    lastX = e.clientX
    lastY = e.clientY
  }
  function settlePan() {
    const c = clampTranslate(tx(), ty())
    if (c.tx !== tx() || c.ty !== ty()) animateTo({ scale: scale(), tx: c.tx, ty: c.ty }, 200)
  }

  // Coast the canvas after a flick, decaying velocity until it's negligible. Gives the pan a
  // physical "throw it and let it settle" feel instead of stopping dead. clampTranslate arrests
  // outward motion at an edge while an inward release past the edge keeps moving back into range.
  function startMomentum() {
    // Cap the launch speed so an extreme flick can't fling the canvas across the screen — coasting
    // should feel like a throw, not a loss of control.
    vx = Math.max(-2.5, Math.min(2.5, vx))
    vy = Math.max(-2.5, Math.min(2.5, vy))
    let lastT = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(40, now - lastT)
      lastT = now
      const decay = Math.exp(-dt * 0.008) // ~halve the speed every ~85ms → settles in well under a second
      vx *= decay
      vy *= decay
      const nx = tx() + vx * dt
      const ny = ty() + vy * dt
      const c = clampTranslate(nx, ny)
      setTx(c.tx)
      setTy(c.ty)
      if ((nx > c.tx && vx > 0) || (nx < c.tx && vx < 0)) vx = 0
      if ((ny > c.ty && vy > 0) || (ny < c.ty && vy < 0)) vy = 0
      if (Math.hypot(vx, vy) > 0.015) {
        animFrame = requestAnimationFrame(tick)
      } else {
        settlePan()
      }
    }
    animFrame = requestAnimationFrame(tick)
  }
  function onPointerUp(e: PointerEvent) {
    if (pinchPts.delete(e.pointerId) && pinchDist > 0) {
      // A pinch finger lifted. If one finger remains, hand it back to the pan path re-anchored at
      // its CURRENT position — without this the leftover finger's first move yanked the canvas by
      // the distance between the two fingers. No momentum: a pinch is not a flick.
      pinchDist = 0
      const rest = [...pinchPts.values()][0]
      if (rest) {
        pointerDown = true
        dragging = true
        startX = lastX = rest.x
        startY = lastY = rest.y
        vx = vy = 0
        lastMoveT = performance.now()
      }
      return
    }
    const wasDragging = dragging
    pointerDown = false
    dragging = false
    try {
      svg?.releasePointerCapture(e.pointerId)
    } catch {
      /* not captured */
    }
    // After a drag: a fast release coasts (momentum); a slow one just glides back into
    // bounds if it ended past the edge. 0.4 px/ms ≈ 400 px/s — above a deliberate flick,
    // below an ordinary reposition, so a careful drag still stops exactly where released.
    if (wasDragging) {
      if (Math.hypot(vx, vy) > 0.4) {
        startMomentum()
        return
      }
      settlePan()
      return
    }
    // A click on the topology background (not on a card and not a pan) dismisses the
    // open drawer.
    if (!props.onDeselect || !props.selectedId) return
    if (isBackgroundClick(e.target)) props.onDeselect()
  }

  // isBackgroundClick reports whether a click landed on the empty canvas — no interactive ancestor
  // up to the svg. A card (.node) or a collapse "show more" pill (.collapse-pill) has its own
  // onClick, so it counts as a hit, not background. Without the pill check, clicking "show more"
  // while a resource is selected deselected it, closing the drawer out from under the operator who
  // only meant to expand the cluster.
  function isBackgroundClick(target: EventTarget | null): boolean {
    let el = target as Element | null
    while (el && el !== svg) {
      if (el.classList?.contains('node') || el.classList?.contains('collapse-pill')) return false
      el = el.parentElement
    }
    return true
  }

  // Double-clicking empty canvas re-fits the view. A common gesture in graph editors; cheaper to
  // discover than the 'f' shortcut for new operators.
  function onBackgroundDblClick(e: MouseEvent) {
    if (isBackgroundClick(e.target)) resetView()
  }

  function resetView() {
    const l = layout()
    if (!svg || l.width === 0) return
    // When a selection is active, 'f' re-frames the selection's connected subtree
    // (same set the click-into-selection effect targets). Otherwise it falls back to the
    // filter-aware fit-all. Without this, the operator who manually panned
    // away from their selected subtree would lose it on 'f' — they'd have to click the
    // selection again to recover the frame.
    if (props.selectedId) {
      // Nodes view: 'f' re-frames the selected pod's node row (matching the click-into-selection fit).
      const capBox = capRowBoxFor(props.selectedId)
      if (capBox) {
        animateTo(fitNodeSet([capBox], 1.4))
        return
      }
      const r = related()
      const inSet = r ? l.nodes.filter((n) => r.nodes.has(n.id)) : []
      if (inSet.length > 0) {
        // Floor + centre-on-selection, mirroring the click-into-selection effect: re-framing a
        // wide subtree must not zoom past legibility either.
        const sel = inSet.find((n) => n.id === props.selectedId)
        animateTo(fitNodeSetFloored(inSet, selectionMaxScale, sel ? { x: sel.x, y: sel.y } : undefined))
        return
      }
    }
    // When any filter is active, frame just the lit subset — otherwise "Fit" gives you a
    // viewport of mostly-faded cards with the actual interesting nodes shrunk down. With no
    // filter the full layout BOX is the right frame — NOT the node boxes: in the
    // capacity view layout().nodes are small hit-targets (pod segments, node labels) while the
    // drawn content is the full-width tracks/bars, so framing the boxes zoomed Fit to 1.4x and
    // left the track running 4 viewports wide on a phone. The box also covers kind-band headers.
    const lit = matches() || props.healthFilter || activeKinds()
      ? l.nodes.filter((n) => !nodeFaded(n))
      : null
    if (!lit || lit.length === 0) {
      // No filter (or a filter that excluded everything): frame the whole drawn layout, width-driven so
      // a tall tree renders large and overflows vertically (top-anchored) rather than shrinking to a
      // speck — Fit / double-click maximise readable text against the canvas width (the operator's report).
      animateTo(computeFitFloored(0, 0, l.width, l.height, { maxScale: 1.4, focus: { x: 0, y: 0 } }))
      return
    }
    animateTo(fitLit(lit))
  }

  // Frame the current match set on demand — the click affordance on the "N matches" pill. Search
  // deliberately does NOT auto-fit while typing (per-keystroke jumps; see the filter auto-fit effect),
  // so after typing, the matches sit lit but off-screen behind faded cards with no obvious way to
  // reach them but Enter (keyboard) or Fit (whose match-scoping isn't discoverable from the count).
  // This makes the count itself the affordance: click it to fly to the matches. Unlike resetView('f')
  // it ignores any active selection and always frames the lit subset, so the count answers "where are
  // my matches?" predictably. No scale floor — an explicit gesture, like the manual Fit, may zoom to a
  // speck when matches are scattered; only the AUTOMATIC filter-fit keeps the floor.
  function frameMatches() {
    const l = layout()
    if (!svg || l.width === 0) return
    const lit = l.nodes.filter((n) => !nodeFaded(n))
    if (lit.length === 0) return
    animateTo(fitLit(lit))
  }

  // fitAll: the bottom-right Fit button. Frames everything with NO legibility floor, so a dense graph
  // zooms all the way out until every resource is on screen — the operator's "show me everything".
  // Distinct from resetView (double-click), which floors at MIN_FIT_SCALE to keep text readable and
  // re-frames the selected subtree. When a filter is active it frames just the lit subset (mirroring
  // resetView's filter-aware rule): fitting the whole faded graph would shrink the matches to specks — but
  // still WITHOUT the floor, unlike the automatic filter-fit. On a sparse, unfiltered view the floor
  // never binds, so this and double-click coincide; the difference shows only when the fit is sub-floor.
  function fitAll() {
    const l = layout()
    if (!svg || l.width === 0) return
    const lit = matches() || props.healthFilter || activeKinds() ? l.nodes.filter((n) => !nodeFaded(n)) : null
    if (lit && lit.length > 0) {
      animateTo(fitLit(lit))
      return
    }
    animateTo(computeFitFor(0, 0, l.width, l.height, 1.4))
  }

  return (
    // Below ~0.45 zoom the fixed-size card text renders at a few unreadable pixels, so it's just
    // noise over the overview. labels-hidden fades the text out, leaving a clean map of health-tinted,
    // icon-only cards; hover/click still reveal the detail. The icon + card color carry kind + health
    // at any zoom.
    <div
      class="topology"
      classList={{ 'labels-hidden': scale() < 0.45 }}
      // Track the canvas transform with the blueprint grid so it pans/zooms WITH the cards instead of
      // sitting still under them: position = the content origin in screen space (tx,ty); cell size =
      // base × scale. The five entries match the five background-image layers (minor ×2, major ×2,
      // radial sheen) in CSS order — the sheen stays fixed (0 / 100%). Minor lines fade under
      // .labels-hidden (topology.css) so a zoomed-out canvas doesn't haze into a solid field.
      style={{
        'background-position': `${tx()}px ${ty()}px, ${tx()}px ${ty()}px, ${tx()}px ${ty()}px, ${tx()}px ${ty()}px, 0 0`,
        'background-size': `${GRID_MINOR * scale()}px ${GRID_MINOR * scale()}px, ${GRID_MINOR * scale()}px ${GRID_MINOR * scale()}px, ${GRID_MAJOR * scale()}px ${GRID_MAJOR * scale()}px, ${GRID_MAJOR * scale()}px ${GRID_MAJOR * scale()}px, 100% 100%`,
      }}
    >
      {/* Health-distribution stripe: a thin bar pinned to the top edge of the canvas, one segment
          per present state sized in proportion — the "what's this namespace doing?" read at a
          glance (a sliver of red on a sea of green). Spans the FULL width of the main view (a
          fixed status bar, like the old topbar stripe), deliberately decoupled from the filter
          pills so its width never varies with how many pills are showing. */}
      <Show when={shownHealth().length > 0}>
        {/* The stripe lives inside .topology, which is the flex child that shrinks to make room
            for the detail drawer. Left alone it would narrow with the canvas; stripe-over-drawer
            extends it back across the drawer so the status bar always spans the full main view.
            The overflow:hidden on .main clips the (over-extended) tail to the main edge. */}
        <div
          class="topology-stripe"
          classList={{ 'stripe-over-drawer': !!props.selectedId }}
          aria-hidden="true"
        >
          <For each={shownHealth()}>
            {(h) => (
              <span
                style={{ flex: healthStats()[h], 'background-color': healthColor(h) }}
                title={`${h}: ${healthStats()[h]}`}
              />
            )}
          </For>
        </div>
      </Show>
      {/* Filtered-everything-out overlay: when a filter is active and nothing
          is lit, surface that clearly + a one-click clear button so the operator doesn't have
          to guess why the canvas looks dim. Sits above the canvas like the empty state. */}
      <Show
        when={
          props.nodes.length > 0 &&
          (matches() || props.healthFilter || activeKinds()) &&
          layout().nodes.every((n) => nodeFaded(n))
        }
      >
        <div class="topology-empty topology-filtered-out">
          <div class="topology-empty-text">No resources match the active filter.</div>
          <Show when={props.onClearFilters}>
            <button class="topology-clear" onClick={() => props.onClearFilters?.()}>
              clear all filters
            </button>
          </Show>
        </div>
      </Show>
      {/* Relationships-hidden hint (explicit-over-implicit): in the relationship grouping an empty
          relFilter draws every card with NO edges — visually indistinguishable from "these resources
          have no connections". Surface that the edges are hidden BY CHOICE, with a one-click restore
          of the default (ownership). Gated on relationships actually existing (relChips) so a
          genuinely edge-less namespace doesn't get a misleading "toggle one" prompt. A non-blocking
          bottom toast — the cards stay the focus and remain interactive (unlike .topology-empty). */}
      <Show
        when={
          props.groupBy === 'relationship' &&
          props.nodes.length > 0 &&
          (props.relFilter?.size ?? 0) === 0 &&
          relChips().length > 0
        }
      >
        <div class="topology-rels-hidden" role="status">
          <span>Relationships hidden — all categories are off.</span>
          <Show when={props.onRelFilter}>
            <button class="topology-clear" onClick={() => props.onRelFilter?.('ownership')}>
              show ownership
            </button>
          </Show>
        </div>
      </Show>
      {/* Everything-orphaned overlay: hiding orphans emptied the canvas (every resource is unconnected),
          which would otherwise read as a mysterious blank. Say so and offer the one-click reveal. */}
      <Show
        when={
          isRelGrouping() &&
          !props.showOrphaned &&
          props.nodes.length > 0 &&
          visibleNodes().length === 0
        }
      >
        <div class="topology-empty topology-filtered-out">
          <div class="topology-empty-text">
            {/* A freshly-created namespace holds exactly the default ServiceAccount Kubernetes adds
                automatically — for a beginner, "1 unconnected resource is hidden" reads as a riddle
                where "this namespace is empty" is the honest answer. */}
            <Show
              when={
                props.nodes.length === 1 &&
                props.nodes[0].kind === 'ServiceAccount' &&
                props.nodes[0].name === 'default'
              }
              fallback={
                <>
                  {orphanIds().size} unconnected {orphanIds().size === 1 ? 'resource is' : 'resources are'} hidden — none are connected to anything in this view.
                </>
              }
            >
              This namespace is empty — only the <code>default</code> ServiceAccount that Kubernetes adds to every namespace.
            </Show>
          </div>
          <Show when={props.onShowOrphaned}>
            <button class="topology-clear" onClick={() => props.onShowOrphaned?.(true)}>
              show orphaned
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.nodes.length === 0}>
        <CanvasEmpty
          connected={props.connected}
          offline={props.offline}
          noAccess={props.noAccess}
          authFailed={props.authFailed}
          offlineReason={props.offlineReason}
          hint={emptyHint()}
        />
      </Show>
      {/* The canvas control bar (search / Group / Relationships / Health / Kinds) — see
          topology/Toolbar.tsx. Topology keeps the toolbar element ref (the viewport fit reads its
          live height) and the kinds-row scroll-edge state (the svg ResizeObserver re-measures it). */}
      <Toolbar
        toolbarRef={(el) => (toolbarEl = el)}
        searchRef={props.searchRef}
        query={query}
        setQuery={setQuery}
        matches={matches}
        matchOrdered={matchOrdered}
        matchPos={matchPos}
        frameMatches={frameMatches}
        activeKinds={activeKinds}
        capResource={capResource}
        setCapResource={setCapResource}
        relChips={relChips}
        shownHealth={shownHealth}
        healthStats={healthStats}
        isRelGrouping={isRelGrouping}
        orphanIds={orphanIds}
        kindChips={kindChips}
        kindsEdges={kindsEdges}
        kindsRowRef={(el) => (kindsRowEl = el)}
        updateKindsEdges={updateKindsEdges}
        selectedId={props.selectedId}
        onSelect={props.onSelect}
        healthFilter={props.healthFilter}
        onHealthFilter={props.onHealthFilter}
        onClearFilters={props.onClearFilters}
        groupBy={props.groupBy}
        onGroupBy={props.onGroupBy}
        relFilter={props.relFilter}
        onRelFilter={props.onRelFilter}
        showOrphaned={props.showOrphaned}
        onShowOrphaned={props.onShowOrphaned}
        onKindFilter={props.onKindFilter}
      />
      <svg
        ref={svg}
        class="topology-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDblClick={onBackgroundDblClick}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge-color)" />
          </marker>
          {/* Diagonal hatch marking a pod bursting past its request, overlaid on the health-colored
              segment so "over request" reads unambiguously — distinct from the amber suspended hue. */}
          <pattern id="cap-burst-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text)" stroke-width="2" opacity="0.55" />
          </pattern>
        </defs>
        <g transform={`translate(${tx()},${ty()}) scale(${scale()})`}>
          {/* Nodes view: the capacity & usage visualization. Each node is a horizontal track
              (length ∝ allocatable) with pods drawn as usage-sized segments; reserved-vs-actual
              shows as two stacked bars per node — a usage bar above a requested bar.
              Expanding a node unfolds per-pod bullets with request/limit ticks + overshoot. */}
          <Show when={props.groupBy === 'nodes'}>
            {/* The bar/segment/bullet SVG lives in CapacityView; this host keeps every signal
                (layout, fade/spotlight, hover tooltip, viewport fitting) and hands down plain
                props/callbacks, so the canvas state model stays in one place. */}
            <CapacityView
              rows={capRows()}
              scale={capInfo().scale}
              hasUsage={capInfo().hasUsage}
              resource={capResource()}
              selectedId={props.selectedId}
              segFaded={capSegFaded}
              aggFaded={capAggFaded}
              rowFaded={capRowFaded}
              onSelect={props.onSelect}
              onSelectBullet={(id, box) => { capPodFitBox = box; props.onSelect(id); fitCapBox(box) }}
              onToggleRow={toggleCapRow}
              onHover={(key, tip, e) => { setCapHover(key); showTip(tip, e) }}
              onLeave={() => { setCapHover(null); setCapTip(null) }}
            />
          </Show>
          {/* Relationship view's orphan section header: a caption + rule above the kind-grouped
              unconnected resources, separating them from the relationship trees above (explicit over
              implicit — the gap alone could read as just more tree). */}
          <Show when={orphanSection()}>
            {(s) => (
              <g class="orphan-section-head" aria-hidden="true">
                <line class="orphan-section-rule" x1={s().x - 10} y1={s().y - 24} x2={s().x + Math.max(s().width + 10, 200)} y2={s().y - 24} />
                <text class="orphan-section-label" x={s().x - 10} y={s().y - 32}>Orphaned · no relationships</text>
              </g>
            )}
          </Show>
          {/* All view: a faint kind label sits above each kind group, so the eye can sweep
              "Pods here, Services there" without inferring it from card text. Underlay only —
              no interactivity; cards above remain selectable normally. */}
          <Show when={groups().length > 0}>
            <g class="kind-groups">
              <For each={groups()}>
                {(g) => (
                  <g
                    class="kind-group"
                    classList={{
                      'kind-pod': g.kind === 'Pod',
                      // Fade the whole kind group (label + bg + cards) when a kind filter is
                      // active and this kind isn't in it — otherwise the bg rect + label stay
                      // opaque while cards inside fade, which reads as a stale leftover.
                      faded: !!activeKinds() && !activeKinds()!.has(g.kind),
                      'kind-group-interactive': !!props.onKindFilter,
                    }}
                    // Clicking a kind group's bg/label solos that kind in the filter,
                    // matching Shift+click on the kind chip. Faster than scanning the chip row when
                    // the operator is already looking at the "All view" cluster they want to focus on.
                    onClick={(e) => {
                      if ((e.target as Element).closest?.('.node')) return // a card click takes priority
                      props.onKindFilter?.(g.kind, true)
                    }}
                  >
                    {/* Subtle background rect behind the whole kind group (label + cards) gives the
                        grouping a tactile container so kind boundaries read spatially, not just via
                        spacing. Drawn before the icon and label so it's the underlay. */}
                    <rect
                      class="kind-group-bg"
                      x={g.x - 10}
                      y={g.y - 6}
                      width={g.width + 20}
                      height={g.height + 16}
                      rx="8"
                    />
                    {/* A 12px kind icon centered on the label's optical center: the 12px uppercase
                        label's baseline sits at y+14, so its cap-height midpoint is ~y+9.7; the
                        scaled icon's content center is 0.86*7 ≈ 6 below its translate origin. */}
                    <g class="kind-group-icon" transform={`translate(${g.x}, ${g.y + 3.7}) scale(0.86)`}>
                      {kindIcon(g.kind)}
                    </g>
                    <text class="kind-group-label" x={g.x + 16} y={g.y + 14}>
                      {g.kind} <tspan class="kind-group-count">{g.count}</tspan>
                    </text>
                  </g>
                )}
              </For>
            </g>
          </Show>
          {/* Connectivity views: a grouping frame around each collapse cluster (visible siblings +
              pill), so a fold reads as one unit the pill folds/unfolds. Drawn under the cards as a
              dashed underlay; expanded frames get a solid-ish accent so "this block is unfolded"
              is obvious at a glance. Empty for All/Nodes (their kind/host boxes already group). */}
          <Show when={connFrames().length > 0}>
            <g class="conn-frames">
              <For each={connFrames()}>
                {(f) => (
                  <rect
                    class="conn-frame"
                    classList={{ expanded: f.expanded }}
                    x={f.x}
                    y={f.y}
                    width={f.width}
                    height={f.height}
                    rx="11"
                  />
                )}
              </For>
            </g>
          </Show>
          <g class="edges">
            <For each={renderedEdges()}>
              {(e) => (
                <g
                  // Hovering anywhere on the edge halos both endpoint cards. The hit
                  // target is the wide transparent companion path below, since the visible 1-2px line
                  // is nearly impossible to hover in a dense graph.
                  onPointerEnter={() => setHoverEnds({ from: e.from, to: e.to })}
                  onPointerLeave={() => setHoverEnds(null)}
                >
                  {/* <title> on the path makes hover reveal the relationship type. */}
                  <title>{edgeTitle(e, nodeById())}</title>
                  <path class="edge-hit" d={edgePath(e.points)} fill="none" stroke="transparent" stroke-width="10" />
                  <path
                    classList={{ faded: edgeFaded(e), adjacent: edgeAdjacent(e), owner: e.type === 'ownerReference' }}
                    d={edgePath(e.points)}
                    fill="none"
                    stroke="var(--edge-color)"
                    stroke-width={e.type === 'ownerReference' ? 1.8 : 1.2}
                    stroke-dasharray={isDashedEdge(e.type) ? '5 4' : undefined}
                    marker-end="url(#arrow)"
                  />
                  {/* Blueprint data-flow trace: a cyan dash that travels NETWORK edges (Ingress→
                      Service→Pod traffic, NetworkPolicy) so the motion visualizes actual data flowing
                      over the link. Ownership keeps plain solid arrows (structure, not traffic) — that
                      kept the dense backbone from shimmering. Brighter/faster on edges adjacent to the
                      selection; stilled under reduced-motion. */}
                  <Show when={NETWORK_EDGE_TYPES.has(e.type)}>
                    <path
                      classList={{ flow: true, faded: edgeFaded(e), 'flow-lit': edgeFlowLit(e) }}
                      d={edgePath(e.points)}
                      fill="none"
                    />
                  </Show>
                </g>
              )}
            </For>
          </g>
          <g class="nodes">
            {/* Render layout().nodes + exiting() so removed cards keep their last-known position
                while fading out — operators see "what left" rather than a card vanishing. The Nodes
                group-by draws its own bar visualization above (cap-view), so the card renderer is
                skipped there — its layout().nodes are segment hit-boxes, not cards. */}
            <For each={renderNodes}>
              {(n) => (
                <Show
                  when={n.collapse}
                  fallback={
                <g
                  class="node"
                  classList={{
                    selected: n.id === props.selectedId,
                    faded: nodeFaded(n),
                    // Endpoint of the hovered edge: a transient accent halo.
                    target: edgeEndpoint(n.id),
                    exiting: exitingIds().has(n.id),
                    [`h-${n.health.toLowerCase()}`]: true,
                    // Pod kind gets a CSS hook for the accent treatment: pods are the
                    // fundamental workload, so they read distinct from their controllers/services
                    // even before the operator focuses on the card.
                    'kind-pod': n.kind === 'Pod',
                  }}
                  /* CSS transform (not the SVG attribute) so browsers can transition position
                     changes — when SSE patches shift the Dagre layout, cards glide to their new
                     spots instead of teleporting. See .node { transition: transform … } in CSS. */
                  style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                  /* Clicking the already-selected card deselects (mirrors how the legend pills and
                     kind chips toggle on a repeat click). The toggle-OFF is
                     deferred a beat so a double-click can cancel it — otherwise double-clicking a
                     card (a natural "focus this" gesture) ran select(click1)→deselect(click2) and
                     left nothing selected. Selecting stays immediate; only deselect waits. */
                  onClick={() => {
                    if (n.id === props.selectedId && props.onDeselect) {
                      clearTimeout(cardClickTimer)
                      cardClickTimer = setTimeout(() => props.onDeselect?.(), 220)
                    } else {
                      props.onSelect(n.id)
                    }
                  }}
                  onDblClick={() => {
                    // Cancel the pending deselect from this double-click's second click, and make
                    // sure the card ends up selected + framed (selection-fit runs on select).
                    clearTimeout(cardClickTimer)
                    props.onSelect(n.id)
                  }}
                  /* Hover preview spotlight (relationship view, drawer closed): point at a card and
                     its direct relationships light while the rest fades — a no-commit preview of the
                     selection focus. The spotlight ignores hover while a selection owns the view, so
                     setting the id unconditionally is safe (subjectId gates it). No camera move. */
                  onPointerEnter={() => setHoveredNodeId(n.id)}
                  onPointerLeave={() => setHoveredNodeId((cur) => (cur === n.id ? null : cur))}
                >
                  {/* Hover tooltip: a compact "everything on the card + a little more" view, so
                      a tightly-truncated card in a zoomed-out graph still reveals the full name,
                      age, host (pods), and restart count without selecting it. */}
                  <title>{cardTitle(n, now())}</title>
                  {/* Blueprint card (theme overhaul): a notched "tech panel" — sharp corners with
                      the top-right chamfered, the cut traced in accent (.node-notch), and corner
                      brackets (.node-bracket) that light up on selection. Health stays carried by
                      the body border + tint (see CSS), so the schematic framing never bears status. */}
                  <path class="node-bg" d={`M0 0 H${n.width - 10} L${n.width} 10 V${n.height} H0 Z`} />
                  <path class="node-notch" d={`M${n.width - 10} 0 L${n.width} 10`} />
                  <path class="node-bracket" d={`M0 12 L0 0 L12 0 M0 ${n.height - 12} L0 ${n.height} L12 ${n.height} M${n.width - 12} ${n.height} L${n.width} ${n.height} L${n.width} ${n.height - 12}`} />
                  {/* Icon-forward card: a 28×28 kind silhouette anchors the left column
                      and a small uppercase kind label sits under it; the right column lays name,
                      status and the restart/age badge on their own rows so nothing competes for
                      width. Health is carried by the .node-bg border + tint (see CSS), so a colored
                      stripe is redundant and was removed to reclaim left padding for the icon. */}
                  {/* Optically-centered icon: a full-box glyph inks ~y14–34, i.e. ~2px
                      above the card's geometric center (y30). Geometric centering measured
                      dead-on but *looked* bottom-heavy because the kind label hangs below with empty
                      space above — an icon with a caption beneath has to ride slightly high to read as
                      centered. The label tucks ~3px under the glyph. */}
                  <g class="node-icon node-icon-large" transform="translate(10,12) scale(2)">
                    {kindIcon(n.kind)}
                  </g>
                  <text class="node-kind" x="24" y="49" text-anchor="middle">
                    {cardKindLabel(n.kind)}
                  </text>
                  <text class="node-name" x="46" y="32">
                    {label(n)}
                  </text>
                  <Show when={n.status}>
                    <text class="node-status" x={n.width - 12} y="17" text-anchor="end" fill={healthTextColor(n.health)}>
                      {cardStatus(n.status!)}
                    </text>
                  </Show>
                  <Show when={rightBadge(n)}>
                    <text class="node-restarts" x={n.width - 12} y="50" text-anchor="end">
                      {rightBadge(n)}
                    </text>
                  </Show>
                </g>
                  }
                >
                  {/* Two-way collapse pill: a ghost card that folds/unfolds the extra same-kind
                      resources. Collapsed it reads "+ show N more" and expands the cluster; expanded
                      it reads "− show N fewer" and refolds it (one affordance, both directions —
                      "older" is deliberately not surfaced). A "● N match" badge appears only while
                      collapsed, when the fold hides a search or health-filter result (D7) — expanded,
                      those cards are already shown. */}
                  {(meta) => (
                    <g
                      class="collapse-pill"
                      classList={{
                        faded: pillFaded(meta()),
                        expanded: meta().expanded,
                      }}
                      style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                      // A real, keyboard-operable button: it's the ONLY way to reveal a folded cluster
                      // (pills are excluded from search-nav, so unlike a graph node there's no
                      // alternative keyboard path to the expand action). role+tabindex+aria-label give a
                      // screen reader a named control; Enter/Space activate it like a native button. A
                      // bare <g><title> left it mouse-only and unnamed.
                      role="button"
                      tabindex="0"
                      aria-label={
                        meta().expanded
                          ? `Show ${meta().hidden.length} fewer ${pluralizeKind(meta().groupKind, meta().hidden.length)}`
                          : `Show ${meta().hidden.length} more ${pluralizeKind(meta().groupKind, meta().hidden.length)}${
                              collapseHiddenTrouble(meta())
                                ? `, ${collapseHiddenTrouble(meta())!.count} ${collapseHiddenTrouble(meta())!.count === 1 ? 'needs' : 'need'} attention`
                                : ''
                            }`
                      }
                      aria-expanded={meta().expanded}
                      onClick={() => toggleCluster(meta().key)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleCluster(meta().key)
                        }
                      }}
                    >
                      <title>
                        {meta().expanded
                          ? `Show ${meta().hidden.length} fewer ${pluralizeKind(meta().groupKind, meta().hidden.length)}`
                          : `Show ${meta().hidden.length} more ${pluralizeKind(meta().groupKind, meta().hidden.length)}`}
                      </title>
                      <path class="collapse-pill-bg" d={`M0 0 H${n.width - 10} L${n.width} 10 V${n.height} H0 Z`} />
                      <Show
                        when={!meta().expanded}
                        fallback={
                          <text class="collapse-pill-label" x={n.width / 2} y="35" text-anchor="middle">
                            − show {meta().hidden.length} fewer
                          </text>
                        }
                      >
                        <text
                          class="collapse-pill-label"
                          x={n.width / 2}
                          y={collapseMatchCount(meta()) > 0 || collapseHiddenTrouble(meta()) ? 24 : 35}
                          text-anchor="middle"
                        >
                          + show {meta().hidden.length} more
                        </text>
                        {/* One badge slot: a search/health-filter hit ("● N match", accent) takes
                            precedence; otherwise, if the fold hides non-healthy resources, surface the
                            worst with a health-coloured "● N <worst>" so the trouble is visible even
                            with no filter active (the no-filter case the match badge never covered). */}
                        <Show
                          when={collapseMatchCount(meta()) > 0}
                          fallback={
                            <Show when={collapseHiddenTrouble(meta())}>
                              {(t) => (
                                <text
                                  class="collapse-pill-trouble"
                                  x={n.width / 2}
                                  y="46"
                                  text-anchor="middle"
                                  style={{ fill: healthTextColor(t().worst) }}
                                >
                                  <title>
                                    {t().count} hidden {t().count === 1 ? 'resource needs' : 'resources need'} attention — {healthHint[t().worst]}
                                  </title>
                                  ● {t().count} {t().worst.toLowerCase()}
                                </text>
                              )}
                            </Show>
                          }
                        >
                          <text class="collapse-pill-match" x={n.width / 2} y="46" text-anchor="middle">
                            ● {collapseMatchCount(meta())} match
                          </text>
                        </Show>
                      </Show>
                    </g>
                  )}
                </Show>
              )}
            </For>
          </g>
        </g>
      </svg>
      {/* Bottom-left count overlay: at-a-glance namespace size, plus the active-filter subset
          when one is active ("4 of 23"). Active filters compose (search ∩ health ∩ kinds), so
          the count reflects what's actually lit on the canvas. Hidden when the canvas is empty —
          the empty-state already covers the message. */}
      <Show when={visibleNodes().length > 0}>
        <div class="topology-count" aria-live="polite" aria-atomic="true">
          <Show
            when={matches() || props.healthFilter || activeKinds()}
            fallback={
              <>
                {/* The Nodes view headlines pods (its grouped members), every other view headlines
                    resources — a baffling "182 resources" over a dozen pod bars is the count counting
                    a namespace inventory the capacity canvas never draws (see capacityShown). */}
                <Show
                  when={props.groupBy === 'nodes'}
                  fallback={<>{visibleNodes().length} resource{visibleNodes().length === 1 ? '' : 's'}</>}
                >
                  {shownPods().length} pod{shownPods().length === 1 ? '' : 's'}
                </Show>
                {/* Per-grouping summary: Kind grouping shows the kind count, Nodes
                    grouping shows the host count — each surfaces the dimension that grouping
                    actually exposes, so "is this dense?" reads without parsing the canvas. */}
                <Show when={props.groupBy === 'kind' && groups().length > 1}>
                  {' '}· {groups().length} kinds
                </Show>
                <Show when={props.groupBy === 'nodes' && capRows().length > 0}>
                  {' '}· {capRows().length} node{capRows().length === 1 ? '' : 's'}
                </Show>
              </>
            }
          >
            {/* The filtered count doubles as the frame-the-matches affordance — the same idiom as
                the search row's count button (a match count is clickable and frames its matches),
                because under a health/kind-only filter the search button is absent and this pill is
                the ONLY count, leaving a mouse operator no way to fly to off-screen matches. The
                button is INSIDE the aria-live pill (not a swapped element) so the live region
                survives filter toggles and keeps announcing count changes. */}
            <button
              type="button"
              class="topology-count-frame"
              disabled={filterMatchCount() === 0}
              onClick={frameMatches}
              title={
                filterMatchCount() === 0
                  ? 'Nothing matches the active filters.'
                  : `Click to frame the matching ${props.groupBy === 'nodes' ? 'pods' : 'resources'}.`
              }
            >
              {filterMatchCount()} of {props.groupBy === 'nodes' ? shownPods().length : visibleNodes().length}
              {/* The bare "M of N" is clear visually but ambiguous read aloud; this sr-only suffix
                  gives the polite live announcement a noun. "match" (not "shown") because the count is
                  the true filter total — some matches may be folded into a collapse pill, not on canvas. */}
              <span class="sr-only"> {props.groupBy === 'nodes' ? 'pods' : 'resources'} match</span>
            </button>
          </Show>
        </div>
      </Show>
      {/* Hide the Fit button when there's nothing on canvas — it would just trigger a no-op against
          an empty layout, and the empty-state copy already explains what to do. */}
      <Show when={props.nodes.length > 0}>
      <button class="topology-fit" onClick={fitAll} title="Fit all resources in view">
        {/* Tiny "fit corners" glyph: four L-corners around an implied frame so the button reads
            as "frame the canvas" even before the eye lands on the word. */}
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
          <path d="M 1 4 L 1 1 L 4 1 M 8 1 L 11 1 L 11 4 M 11 8 L 11 11 L 8 11 M 4 11 L 1 11 L 1 8" />
        </svg>
        Fit
      </button>
      </Show>
      {/* Capacity-bar hover tooltip. A fixed-position HTML card that follows the cursor while hovering a
          segment / fold / overhead slice, showing just that part's name + amount (the bars' own right
          labels already carry the use/req totals, so a full triple here would be redundant). Offset from
          the cursor and pointer-events:none so it never eats the hover. */}
      <Show when={capTip()}>
        {(t) => {
          const d = () => t().d
          // Flip the cursor-following tooltip to the cursor's other side near a viewport edge so it never
          // clips off-screen (hovering a far-right pod card / bottom node row used to push it past the
          // edge). Threshold uses the CSS max-width (360) + margin as the worst case, so even a wide
          // tooltip stays fully on-screen; the translate keeps the chosen corner anchored to the cursor.
          const pos = () => {
            const flipX = t().x > window.innerWidth - 374
            const flipY = t().y > window.innerHeight - 110
            return {
              left: `${flipX ? t().x - 14 : t().x + 14}px`,
              top: `${flipY ? t().y - 14 : t().y + 14}px`,
              transform: flipX || flipY ? `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})` : undefined,
            }
          }
          return (
            <div class="cap-tooltip" style={pos()}>
              <div class="cap-tooltip-name">{d().title}</div>
              <Show when={d().sub}>{(sub) => <div class="cap-tooltip-sub">{sub()}</div>}</Show>
              <div class="cap-tooltip-value">{d().value}</div>
              <Show when={d().hint}>{(hint) => <div class="cap-tooltip-hint">{hint()}</div>}</Show>
            </div>
          )
        }}
      </Show>
    </div>
  )
}
