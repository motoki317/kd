import { createMemo, createSignal, For, Show, createEffect, on, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { connGroups, kindGroups, layoutGraphByKind, layoutGraphWithOrphans, type CollapseMeta, type OrphanLayout } from '../layout'
import { layoutGraphByCapacity, type CapResource, type CapRow, type CapacityLayout } from '../capacityLayout'
import { useNow } from '../clock'
import { edgeKey, spotlightSubtree } from '../graphState'
import { DASHED, edgePath, edgeTitle } from '../edgeRender'
import { nextRovingIndex } from '../rovingFocus'
import { type CapTipData } from '../capacityTooltips'
import CapacityView from './CapacityView'
import { HEALTH_ORDER, healthColor, healthTextColor } from '../health'
import { kindStats as computeKindStats } from '../kindStats'
import { orderedForNav } from '../nav'
import { cardKindLabel, cardName, cardStatus, cardTitle, kindShortLabel, pluralizeKind, prefixParentNames } from '../names'
import { nodeMatches } from '../search'
import { kindIcon } from '../icons'
import { relativeAge } from '../time'
import { projectEdges, REL_CATEGORIES, relCategoriesPresent } from '../relationships'
import { boundingBox, clampPan, fitBox, selectionMaxScale } from '../viewport'
import { isNodeFaded } from '../fade'
import { readRawPref, writePref } from '../prefs'
import { scrollEdges, type ScrollEdges } from '../scrollEdges'
import { CLUSTER_SCOPE } from '../api'
import type { Capacity, GroupBy, Health, KEdge, KNode, RelCategory } from '../types'

const EMPTY_RELS: ReadonlySet<RelCategory> = new Set()
const EMPTY_IDS: ReadonlySet<string> = new Set()

// The group-by options, exported so App's keyboard shortcuts (1–3) and help overlay stay in sync
// with the segmented control rendered in the toolbar. Order = number-key order.
export const GROUP_OPTIONS: { id: GroupBy; label: string; hint: string }[] = [
  { id: 'relationship', label: 'Relationship', hint: 'Lay resources out along the relationships you enable' },
  { id: 'nodes', label: 'Nodes', hint: 'Group pods into the node they run on' },
  { id: 'kind', label: 'Kind', hint: 'Group every resource into per-kind boxes' },
]

interface Props {
  nodes: KNode[]
  edges: KEdge[]
  selectedId: string | null
  healthFilter?: import('../types').Health | null
  // Multi-select set of kinds to spotlight (cycle 203). Empty / null means "show all"; a
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
  // Lets the app focus the topology search from a global key (Cmd/Ctrl+K) — like Sidebar's
  // filterRef but for the resource search instead of the namespace filter.
  searchRef?: (el: HTMLInputElement) => void
  onSelect: (id: string) => void
  // Background click dismisses the open drawer (cycle 161). Optional — parent decides whether
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

export default function Topology(props: Props) {
  // Per-cluster expansion state for the "+N older" collapse (ephemeral: a Set of expanded keys,
  // empty = everything collapsed, resets on reload). Keyed by the layout's stable collapse key
  // ("kind:Pod", "host:<node>", …) so toggling one cluster never disturbs another.
  const [expandedClusters, setExpandedClusters] = createSignal<ReadonlySet<string>>(new Set())
  const toggleCluster = (key: string) =>
    setExpandedClusters((s) => {
      const next = new Set(s)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })

  // Capacity view (Nodes group-by) control: which single resource sizes the bars. App owns the
  // signal (so it round-trips through the URL + localStorage like group-by/relationships, making the
  // capacity view shareable); here it's a read accessor + a change request. The bars are always the
  // explicit Req + Use stacked form (the overlay/Use-only mode was retired after live review).
  const capResource = (): CapResource => props.capResource ?? 'cpu'
  const setCapResource = (r: CapResource) => props.onCapResource?.(r)
  // Radio refs for the two single-select segmented controls, so arrow-key navigation can move DOM
  // focus to follow the roving tabindex (see the radiogroup onKeyDown handlers in the toolbar).
  const groupSegRefs: Partial<Record<GroupBy, HTMLButtonElement>> = {}
  const capResRefs: Partial<Record<CapResource, HTMLButtonElement>> = {}
  // Roving keyboard model for the filter-chip toolbars (role=toolbar): the first chip is the single
  // Tab stop and arrows/Home/End move focus among the rest, so Tab doesn't have to step through all
  // 11+ kind chips to pass the row. Derives the chip list + current focus from the DOM, so it works
  // unchanged for the dynamic kind row whose chip count changes per namespace.
  const onToolbarKey = (e: KeyboardEvent) => {
    const chips = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button')]
    const next = nextRovingIndex(e.key, chips.indexOf(document.activeElement as HTMLButtonElement), chips.length)
    if (next === null) return
    e.preventDefault()
    chips[next].focus()
  }
  // Rich hover tooltip for the capacity bars (item: Grafana-style panels). Holds normalized tooltip
  // data + the pointer position; an HTML overlay (not an SVG <title>) follows the cursor so the bar's
  // name/usage/request/limit read instantly instead of after the browser's ~700ms title delay. The
  // bullets/segments no longer print these numbers inline (too cluttered) — the tooltip carries them.
  const [capTip, setCapTip] = createSignal<{ d: CapTipData; x: number; y: number } | null>(null)
  // The tooltip payload builders (tipFromSeg / tipFromAgg / tipFromNodeUse) are pure and live in
  // capacityTooltips.ts; here we just thread the active resource and pointer position through. A
  // segment's contributed metric (use vs req) depends on which bar it sits on, so the caller passes it.
  const showTip = (d: CapTipData, e: PointerEvent) => setCapTip({ d, x: e.clientX, y: e.clientY })

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
    // the live metrics-server usage feed (props.usage) + the active resource/mode toggles.
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
  // Auto-expand the fold hiding a navigated-to selection. Enter-cycle, j/k stepping, and deep-links
  // all walk the FULL node set (troubled-first), so a target is often a node folded behind a "+N more"
  // pill: the drawer opens but the node isn't rendered, so there's no on-canvas .selected marker and
  // the operator can't see where it lives. When the selection isn't currently visible, find the single
  // pill whose fold covers it and expand just that one — revealing the node with its marker. Scoped to
  // the EXACT selected node (not its related() subtree) so selecting a hub never unfolds every sibling.
  createEffect(() => {
    const id = props.selectedId
    if (!id) return
    const nodes = layout().nodes
    if (nodes.some((n) => n.id === id && !n.collapse)) return // already on canvas
    for (const n of nodes) {
      const meta = n.collapse
      if (!meta) continue
      if (meta.hidden.some((h) => h.id === id) || meta.hiddenDescendants?.some((h) => h.id === id)) {
        setExpandedClusters((s) => (s.has(meta.key) ? s : new Set(s).add(meta.key)))
        break
      }
    }
  })
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
  // to the TOP (cards are ordered largest-usage-first, so the heaviest pods sit up top and the operator
  // pans down for the long tail) rather than centring an unreadable whole.
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
  // Fold the specialized (secondary) relationship lenses behind a "+N more" disclosure so the row stays
  // scannable — the user's "collapse the minor ones" ask. An ACTIVE secondary always shows inline (so
  // the operator never loses sight of what's drawn); only inactive ones hide. Persisted like the other
  // display habits so the choice sticks across reloads.
  const [relsExpanded, setRelsExpanded] = createSignal(readRawPref('kd:relsExpanded') === '1')
  const toggleRelsExpanded = () =>
    setRelsExpanded((v) => {
      writePref('kd:relsExpanded', v ? '0' : '1')
      return !v
    })
  const relActive = (id: RelCategory) => props.relFilter?.has(id) ?? false
  const visibleRelChips = createMemo(() =>
    relChips().filter((c) => !c.secondary || relActive(c.id) || relsExpanded()),
  )
  // Inactive secondary lenses present in this graph — the ones the disclosure folds away. The toggle
  // appears only when there is at least one (else the row already shows everything).
  const foldableRelCount = createMemo(() => relChips().filter((c) => c.secondary && !relActive(c.id)).length)
  // Exit animation (cycle 160): when a node drops out of props.nodes, keep its last-known position
  // rendered with a fading-out class for 320ms so the operator sees it leave rather than vanish.
  // We snapshot the prior layout each time createEffect runs and diff against the new one.
  const [exiting, setExiting] = createSignal<import('../layout').PositionedNode[]>([])
  let prevPositioned: import('../layout').PositionedNode[] = []
  const exitTimers = new Map<string, number>()
  createEffect(() => {
    const cur = layout().nodes
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
  const [renderNodes, setRenderNodes] = createStore<import('../layout').PositionedNode[]>([])
  createEffect(() => {
    const next = props.groupBy === 'nodes' ? [] : [...layout().nodes, ...exiting()]
    setRenderNodes(reconcile(next, { key: 'id' }))
  })

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

  // When a node is selected, walk its connected component (edges treated as undirected) so the
  // entire relationship tree containing the selection stays lit while everything else fades out —
  // ArgoCD-style focus on "this resource and what relates to it". Cycle 157 promoted this from
  // immediate-neighbors to full-component because the auto-fit (below) targets the same set:
  // clicking a Pod should frame Deployment+ReplicaSet+Pod, not just the parent edge.
  // Walk only the DISPLAYED relationships (displayEdges, the relFilter projection) — NOT the full edge
  // set. Following relationships the operator hasn't enabled lit (and framed) nodes they can't even
  // see — e.g. a Pod dragging in its mounted ConfigMaps when Volumes is off, so the selection-fit
  // zoomed way out. The spotlight now matches what's on screen. (BFS in spotlightSubtree, graphState.ts.)
  const related = createMemo(() => {
    const id = props.selectedId
    if (!id) return null
    // A ghost selection (the inspected resource was deleted; the drawer shows its terminal banner)
    // has no card on canvas — a spotlight with no subject would just fade EVERYTHING. No spotlight.
    if (!props.nodes.some((n) => n.id === id)) return null
    return spotlightSubtree(id, displayEdges())
  })

  // Search dims everything that doesn't match the query (by name, kind, label, or image), so a
  // resource is findable in a dense namespace without losing its place in the tree. Null when the
  // box is empty. The query is owned by the parent so it resets on namespace/view change.
  const query = () => props.search
  const setQuery = (q: string) => props.onSearch(q)
  const matches = createMemo(() => {
    const q = query().trim()
    if (!q) return null
    // Count over the FULL node set, not layout().nodes — a folded collapse pill removes matching
    // nodes from the layout, so counting only what's on canvas undercounts (search "workflow" on a
    // namespace whose 144 Workflows are mostly folded read "38" while the honest total is 158). The
    // matchOrdered Enter-cycle steps through this full set and auto-expands the fold hiding each
    // target (see the selection auto-expand effect), so every counted match is actually reachable;
    // and this readout now agrees with the bottom-overlay filterMatchCount. Intersect with the kind
    // filter so faded-out kinds don't count. Read props.kindFilter directly (not activeKinds(),
    // declared later → TDZ).
    const kf = props.kindFilter
    const kindOk = (kind: string) => !kf || kf.size === 0 || kf.has(kind)
    const m = new Set<string>()
    // Over visibleNodes (not props.nodes): a hidden orphan isn't on the canvas, so search must not
    // count or Enter-cycle to it — "what you see is what you search". Still the full set minus orphans,
    // so folded-but-present matches keep counting (the folded-undercount fix holds).
    for (const n of visibleNodes()) {
      if (kindOk(n.kind) && nodeMatches(n, q)) m.add(n.id)
    }
    return m
  })
  // Ordered list of matches in the same severity-first order used for Enter cycling (cycle 284).
  // Memoized so the "X of N" indicator and the Enter handler agree on positions.
  const matchOrdered = createMemo(() => {
    const m = matches()
    if (!m || m.size === 0) return []
    return orderedForNav(props.nodes.filter((n) => m.has(n.id)))
  })
  // 1-based position of the current selection within matchOrdered, or 0 if the selection is not a
  // match. Drives the "3 of 7 matches" indicator that complements Enter-cycling (cycle 285).
  const matchPos = createMemo(() => {
    const ordered = matchOrdered()
    if (ordered.length === 0) return 0
    const idx = ordered.findIndex((n) => n.id === props.selectedId)
    return idx < 0 ? 0 : idx + 1
  })

  // Active kind filter (cycle 203): an empty/null set means "show all kinds"; otherwise only the
  // listed kinds stay lit. Re-derived so an empty set still reads as "no filter active".
  const activeKinds = createMemo(() => {
    const s = props.kindFilter
    return s && s.size > 0 ? s : null
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
  // The per-kind worst health (cycle 289) drives a small severity dot on the chip so the operator
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
      selectedId: props.selectedId,
      kindOk: nodeKindOk,
      matchIds: matches(),
      healthFilter: props.healthFilter,
      relatedIds: related()?.nodes ?? null,
    })
  // Capacity-view spotlight: hovering a pod segment/bullet (not just clicking it) spotlights it and
  // fades the rest, like a Grafana panel — faster than click-to-select for reading the bars. capHover
  // holds the hovered element's key: a pod id, a `small:<host>` / `other:<host>` aggregate marker, or
  // `overhead:<host>` for the node-usage backdrop (no segment matches it, so everything else fades).
  // When something is hovered it wins; with nothing hovered we fall back to the standard
  // selection/search/filter fade (nodeFaded), so a selected pod stays spotlit after the cursor leaves.
  const [capHover, setCapHover] = createSignal<string | null>(null)
  // The spotlight originally dimmed only the pod SEGMENTS, leaving every node row's frame, tracks, value
  // labels and name fully bright — a half-applied "fades the rest" that left a dozen bright frames and a
  // column of bright totals competing with the one hovered pod. capRowFaded recedes a WHOLE row's chrome
  // when the hover belongs to a DIFFERENT node, so only the spotlit pod's node stays lit (Contrast).
  const capHoverHost = createMemo<string | null>(() => {
    const h = capHover()
    if (!h) return null
    const colon = h.indexOf(':') // small:/other:/overhead:<host> markers carry the host
    if (colon >= 0) return h.slice(colon + 1)
    for (const n of props.capacity?.nodes ?? []) if (n.id === h) return n.host ?? null // pod id → its node
    return null
  })
  const capRowFaded = (host: string) => {
    const hh = capHoverHost()
    return hh !== null && hh !== host
  }
  const capSegFaded = (n: { id: string; health: string; kind: string; host?: string }) => {
    const h = capHover()
    // A segment on a fully-dimmed OTHER row is recessed by capRowFaded already — don't double-fade it
    // (it would compound to near-invisible and read dimmer than its own row frame). Only the hovered
    // row's own siblings fade individually here.
    if (h) return capRowFaded(n.host ?? '') ? false : n.id !== h
    return nodeFaded(n)
  }
  // An aggregate block stands for many pods and is never the single spotlighted pod, so it fades
  // whenever a specific element is in focus — a hovered sibling, or a selected/searched/filtered pod.
  // (Fixes the bug where the bright accent block stayed lit while every individual segment faded.)
  const capAggFaded = (marker: string) => {
    const h = capHover()
    if (h) return capRowFaded(marker.slice(marker.indexOf(':') + 1)) ? false : marker !== h
    return !!props.selectedId || !!matches() || !!props.healthFilter
  }
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
  // One id→node map per layout, so the per-edge lookups below (the kind-fade test and each edge's
  // hover title) are O(1) instead of a linear find apiece — they run for every edge on every render,
  // so the old finds were O(edges×nodes) on each SSE patch / selection change.
  const nodeById = createMemo(() => {
    const m = new Map<string, import('../layout').PositionedNode>()
    for (const n of layout().nodes) m.set(n.id, n)
    return m
  })
  const edgeFaded = (e: KEdge) => {
    const m = matches()
    if (m) return !(m.has(e.from) && m.has(e.to))
    if (props.healthFilter) return true
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
  // Kind grouping draws NO arrows at all: the cross-kind backbone fans across the whole matrix with
  // no meaningful routing (cards sit in per-kind boxes, not along their links), so the lines are pure
  // noise — even on selection, where they tangled across boxes rather than tracing a path. The
  // selection spotlight (related(), nodeFaded) still lights the connected subtree, which carries the
  // "what connects to THIS" answer without the clutter. Every other view keeps its edges (their
  // layouts route them meaningfully along the backbone).
  const renderedEdges = createMemo(() => (props.groupBy === 'kind' ? [] : layout().edges))
  // Accent only the edges DIRECTLY touching the selected node (one hop in or out) — not every edge
  // in its connected component (cycle 309). The whole subtree still stays lit (nodeFaded keeps the
  // component visible and edgeFaded leaves its edges in normal style); the accent is reserved for
  // "what connects straight to the thing I clicked", so a Pod selection highlights only its own
  // owner→pod link rather than lighting up the Deployment→RS→all-siblings backbone too.
  const edgeAdjacent = (e: KEdge) => {
    if (matches() || props.healthFilter || activeKinds()) return false
    const id = props.selectedId
    return !!id && (e.from === id || e.to === id)
  }

  const [scale, setScale] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  // Endpoints of the edge currently under the pointer (cycle 330/R4): in a dense graph an edge's two
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
  // drag release (cycle 339/R10).
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
  let selFitFrame = 0 // rAF handle for the deferred selection-fit (cycle 307)
  let cardClickTimer: ReturnType<typeof setTimeout> | undefined // deferred deselect, cancelled by dblclick (cycle 315)
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

  // fitNodeSet (cycle 336/R9): frames a set of cards. boundingBox + selectionMaxScale + fitBox are
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
    const target = computeFitFor(0, 0, l.width, l.height, 1.4)
    target.scale *= 0.92 // a little breathing room when the whole graph already fits comfortably
    if (target.scale < MIN_FIT_SCALE) {
      // Too many resources to fit readably: rather than shrink the whole graph to an unreadable
      // speck, clamp to a legible floor (a hard minimum, applied AFTER the breathing room so it's
      // never undercut) and open on the top-left — the first resources. Center the axis that still
      // fits at the floor; anchor the overflowing axis to its start. The operator zooms out from
      // there for the whole picture (the fit button / `f` still frames everything on demand).
      const rect = svg.getBoundingClientRect()
      const pad = 60
      // Anchor below the control bar, not behind it: inset the top by the bar height so the first
      // resources open just under the bar rather than hidden under it.
      const topInset = toolbarEl?.getBoundingClientRect().height ?? 0
      const availH = Math.max(1, rect.height - topInset)
      const contentW = l.width * MIN_FIT_SCALE
      const contentH = l.height * MIN_FIT_SCALE
      target.scale = MIN_FIT_SCALE
      target.tx = contentW + pad * 2 <= rect.width ? (rect.width - contentW) / 2 : pad
      target.ty = contentH + pad * 2 <= availH ? topInset + (availH - contentH) / 2 : topInset + pad
    }
    if (firstFit) {
      firstFit = false
      setScale(target.scale)
      setTx(target.tx)
      setTy(target.ty)
    } else {
      animateTo(target)
    }
  })

  // Track SVG size so resizes keep the graph on-screen (cycle 294). Drawer open/close and window
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
        const l = layout()
        if (l.width === 0) return
        if (props.selectedId) return // selection-fit owns this case
        // Snap, not animate: a resize is a viewport change, not a user-initiated transition.
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
        if (!id) return
        // Nodes view: frame the node row the selection sits in (see capRowBoxFor) — UNLESS the selection
        // came from clicking an expanded pod card, in which case zoom to that card (the user's "click a
        // pod box to read its bars"). capPodFitBox is consumed once so a later keyboard/search selection
        // of the same kind still frames the whole row.
        const capBox = capRowBoxFor(id)
        if (capBox) {
          const podBox = capPodFitBox
          capPodFitBox = null
          if (podBox) {
            fitCapBox(podBox)
          } else {
            // Selecting the node NAME (opening its drawer) frames the row exactly like CLICKING the row
            // does (toggleCapRow): width-driven + top-anchored when expanded, centred when collapsed.
            // Framing the row's FULL height (the old fitNodeSet path) zoomed an expanded many-pod stack
            // so far out the bars and text were unreadable — the user's report.
            const row = capRows().find((r) => r.node?.id === id || r.allPodIds.includes(id))
            if (row && expandedClusters().has(`host:${row.host}`)) fitCapRowExpanded(row)
            else if (row) fitCapBox({ x: row.x, y: row.y, width: row.width, height: row.height })
            else {
              cancelAnimationFrame(selFitFrame)
              selFitFrame = requestAnimationFrame(() => animateTo(fitNodeSet([capBox], 1.4)))
            }
          }
          return
        }
        const r = related()
        if (!r) return
        const inSet = l.nodes.filter((n) => r.nodes.has(n.id))
        if (inSet.length === 0) return
        // Defer the fit one frame so the just-opened drawer has taken its flex width and the SVG
        // has shrunk to the still-visible canvas before computeFitFor reads getBoundingClientRect.
        // The drawer is a flex sibling created after Topology, so on the *first* selection this
        // effect would otherwise measure the full pre-drawer width and frame the subtree off-center,
        // half-hidden under the drawer — while every later selection (drawer already open) measured
        // correctly. The rAF lets Solid finish committing the drawer DOM and the browser reflow the
        // SVG, so the very first click frames against the visible canvas too (cycle 307).
        cancelAnimationFrame(selFitFrame)
        selFitFrame = requestAnimationFrame(() => {
          animateTo(fitNodeSet(inSet, selectionMaxScale))
        })
      },
      { defer: true },
    ),
  )

  // Auto-fit to the lit subset when a DISCRETE filter (health legend / kind chips) toggles, so a
  // triage action — "show me what's Degraded" — frames the matches instead of leaving the operator
  // staring at faded healthy cards while the few matches sit off-screen ("11 of 336" with nothing
  // visible). The manual Fit already frames the lit subset (cycle 214); this just does it on the
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
      const target = fitNodeSet(lit, 1.4)
      target.scale *= 0.92 // a touch of breathing room, matching the manual Fit
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

  // clampTranslate keeps at least a margin of the laid-out graph on-screen, so a pan can't fling the
  // whole canvas into the void (where the only recovery was the Fit button). The graph spans screen
  // x in [tx, tx + width*scale]; we require its far edge to stay ≥ margin inside the viewport on
  // each side. A graph smaller than the viewport is unaffected (the bounds never invert). (cycle 316)
  function clampTranslate(txv: number, tyv: number): { tx: number; ty: number } {
    const l = layout()
    if (!svg || l.width === 0) return { tx: txv, ty: tyv }
    const rect = svg.getBoundingClientRect()
    return clampPan(txv, tyv, { width: l.width * scale(), height: l.height * scale() }, { width: rect.width, height: rect.height })
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
      const s = Math.min(Math.max(scale() * factor, 0.15), 3)
      setTx(mx - ((mx - tx()) / scale()) * s)
      setTy(my - ((my - ty()) / scale()) * s)
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
        const s = Math.min(Math.max(scale() * (dist / pinchDist), 0.15), 3)
        setTx(mx - ((mx - tx()) / scale()) * s)
        setTy(my - ((my - ty()) / scale()) * s)
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
  // Coast the canvas after a flick, decaying velocity until it's negligible (cycle 339/R10). Gives the
  // pan a physical "throw it and let it settle" feel instead of stopping dead. clampTranslate still
  // arrests each axis at the layout edge, so momentum can't fling the graph out of view.
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
      if (c.tx !== nx) vx = 0 // hit the horizontal edge — stop that axis
      if (c.ty !== ny) vy = 0
      if (Math.hypot(vx, vy) > 0.015) animFrame = requestAnimationFrame(tick)
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
    // After a drag: a fast release coasts (momentum, cycle 339/R10); a slow one just glides back into
    // bounds if it ended past the edge (cycle 316). 0.4 px/ms ≈ 400 px/s — above a deliberate flick,
    // below an ordinary reposition, so a careful drag still stops exactly where released.
    if (wasDragging) {
      if (Math.hypot(vx, vy) > 0.4) {
        startMomentum()
        return
      }
      const c = clampTranslate(tx(), ty())
      if (c.tx !== tx() || c.ty !== ty()) animateTo({ scale: scale(), tx: c.tx, ty: c.ty }, 200)
      return
    }
    // Cycle 161: a click on the topology background (not on a card and not a pan) dismisses the
    // open drawer. Walk up from the click target — if any ancestor has the .node class, it was a
    // card click (its own onClick will run); otherwise treat as a background click.
    if (!props.onDeselect || !props.selectedId) return
    let el: Element | null = e.target as Element | null
    while (el && el !== svg) {
      // A card (.node) OR a collapse pill (.collapse-pill) is an interactive target with its own
      // onClick — treat it as a hit, not background. Without the pill check, clicking "show more"
      // while a resource is selected also ran this background branch and deselected it, closing the
      // drawer out from under the operator who only meant to expand the cluster.
      if ((el as Element).classList?.contains('node') || (el as Element).classList?.contains('collapse-pill')) return
      el = el.parentElement
    }
    props.onDeselect()
  }

  // Double-clicking empty canvas re-fits the view. A common gesture in graph editors; cheaper to
  // discover than the 'f' shortcut for new operators. Card hit-test walks ancestors the same way
  // onPointerUp does, so a stray double-click on a node title runs the node's own behavior.
  function onBackgroundDblClick(e: MouseEvent) {
    let el: Element | null = e.target as Element | null
    while (el && el !== svg) {
      // A card (.node) OR a collapse pill (.collapse-pill) is an interactive target with its own
      // onClick — treat it as a hit, not background. Without the pill check, clicking "show more"
      // while a resource is selected also ran this background branch and deselected it, closing the
      // drawer out from under the operator who only meant to expand the cluster.
      if ((el as Element).classList?.contains('node') || (el as Element).classList?.contains('collapse-pill')) return
      el = el.parentElement
    }
    resetView()
  }

  function resetView() {
    const l = layout()
    if (!svg || l.width === 0) return
    // Cycle 293: when a selection is active, 'f' re-frames the selection's connected subtree
    // (same set the click-into-selection effect targets). Otherwise it falls back to the
    // filter-aware fit-all from cycle 214. Without this, the operator who manually panned
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
        animateTo(fitNodeSet(inSet, selectionMaxScale))
        return
      }
    }
    // When any filter is active, frame just the lit subset — otherwise "Fit" gives you a
    // viewport of mostly-faded cards with the actual interesting nodes shrunk down. With no
    // filter the full layout BOX is the right frame (cycle 214) — NOT the node boxes: in the
    // capacity view layout().nodes are small hit-targets (pod segments, node labels) while the
    // drawn content is the full-width tracks/bars, so framing the boxes zoomed Fit to 1.4x and
    // left the track running 4 viewports wide on a phone. The box also covers kind-band headers.
    const lit = matches() || props.healthFilter || activeKinds()
      ? l.nodes.filter((n) => !nodeFaded(n))
      : null
    if (!lit || lit.length === 0) {
      // No filter (or a filter that excluded everything): frame the whole drawn layout.
      const target = computeFitFor(0, 0, l.width, l.height, 1.4)
      target.scale *= 0.92
      animateTo(target)
      return
    }
    const target = fitNodeSet(lit, 1.4)
    target.scale *= 0.92
    animateTo(target)
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
    const target = fitNodeSet(lit, 1.4)
    target.scale *= 0.92
    animateTo(target)
  }

  // Keyboard zoom (cycle 329/R3): scale by a factor while keeping the viewport-center world point
  // fixed — same pivot math as the wheel handler, just anchored at the middle instead of the cursor.
  // Gives keyboard/trackpad-less operators (and Vim-style users) fine zoom control to pair with 'f'.
  // Applied instantly (not via animateTo) so successive presses accumulate: animateTo reads the
  // mid-flight scale() signal, so a burst of presses would all target the same value and lose steps.
  function zoomByAtCenter(factor: number) {
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const cx = rect.width / 2, cy = rect.height / 2
    const s0 = scale()
    const s = Math.min(Math.max(s0 * factor, 0.15), 3)
    if (s === s0) return
    cancelAnimationFrame(animFrame) // stop any in-flight fit/glide from fighting the keyboard zoom
    setTx(cx - ((cx - tx()) / s0) * s)
    setTy(cy - ((cy - ty()) / s0) * s)
    setScale(s)
  }

  // Keyboard shortcuts: 'f' fits the canvas (cycle 229); '='/'+' zoom in, '-' zoom out, '0' resets to
  // 1× (all centered). Plain keys, no modifier — Cmd/Ctrl variants are left to the browser's own zoom.
  // Ignored when typing in an input or when a non-Shift modifier is held (Shift passes so '+' works).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'f') {
        e.preventDefault()
        resetView()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        zoomByAtCenter(1.2)
      } else if (e.key === '-') {
        e.preventDefault()
        zoomByAtCenter(1 / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        zoomByAtCenter(1 / scale()) // land exactly on 1× without moving the center
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    // Below ~0.45 zoom the fixed-size card text renders at a few unreadable pixels, so it's just
    // noise over the overview. labels-hidden fades the text out, leaving a clean map of health-tinted,
    // icon-only cards; hover/click still reveal the detail. The icon + card color carry kind + health
    // at any zoom (cycle 325).
    <div class="topology" classList={{ 'labels-hidden': scale() < 0.45 }}>
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
      {/* Filtered-everything-out overlay (cycle 219): when a filter is active and nothing
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
        <div class="topology-empty">
          {/* Friendly graphic: three card silhouettes staggered like a small cluster, each with a
              tiny icon-circle hint at the top-left echoing the cycle-126 icon-forward card. */}
          <svg class="topology-empty-illo" viewBox="0 0 140 64" width="140" height="64" aria-hidden="true">
            <g>
              <rect x="6" y="22" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="14" cy="32" r="2.6" class="empty-card-icon" />
            </g>
            <g>
              <rect x="50" y="12" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="58" cy="22" r="2.6" class="empty-card-icon" />
            </g>
            <g>
              <rect x="94" y="26" width="36" height="22" rx="5" class="empty-card" />
              <circle cx="102" cy="36" r="2.6" class="empty-card-icon" />
            </g>
          </svg>
          {/* role=status: the connecting→offline/no-access/not-signed-in transitions must be
              announced — the conn pill (the other live region) HIDES in the identity states, so
              without this a screen reader hears nothing when the canvas reaches its terminal
              answer. */}
          <div class="topology-empty-text" role="status">
            <Show when={props.connected} fallback={
              // Rung order: auth > no-access > offline > connecting. Identity failures outrank
              // connectivity ones — with zero visible namespaces or no identity at all, "can't
              // reach the cluster" misdiagnoses what is actually a permissions answer.
              <Show when={props.authFailed} fallback={
              <Show when={props.noAccess} fallback={
                <Show when={props.offline} fallback={
                  <>
                    {/* Small inline spinner so "Connecting…" reads as "actively working on it" rather
                        than a frozen text state. CSS animation; respects prefers-reduced-motion. */}
                    <span class="topology-empty-spinner" aria-hidden="true" />
                    Connecting…
                  </>
                }>
                  {/* Offline with no data (e.g. an unreachable context): a static message, NOT the
                      spinner — the connection failed, so point at the retry control rather than
                      implying progress. */}
                  Can't reach the cluster — use “offline · retry” above to reconnect.
                  {/* The server-reported reason (when the context's cache failed to build): a Go error
                      chain whose TAIL names the root cause ("getting credentials: exec: …"), telling
                      an expired-SSO operator the fix is a login, not another retry. Dim and clamped —
                      diagnosis, not the headline; the full chain stays in the title. */}
                  <Show when={props.offlineReason}>
                    <div class="topology-empty-reason" title={props.offlineReason}>{props.offlineReason}</div>
                  </Show>
                </Show>
              }>
                No namespaces are visible to this account — ask whoever runs kd to grant access.
              </Show>
              }>
                Not signed in — kd received no identity from its auth proxy, or access is denied.
              </Show>
            }>
              Nothing to show in this namespace.
            </Show>
          </div>
          {/* When the canvas is empty but the stream is live, surface a hint describing the current
              grouping / relationship selection, so the operator understands the lens they're
              looking through. Hidden while connecting (the line above carries the message). */}
          <Show when={props.connected}>
            <div class="topology-empty-hint">{emptyHint()}</div>
          </Show>
        </div>
      </Show>
      {/* The canvas control bar: a full-width strip across the top of the canvas, three short rows
          — search + Group, Relationships + Health, then Kinds — instead of one facet per line, so
          it stays shallow. Each facet is an inline label hugging its controls (proximity). The
          Kinds row is a strict single line that scrolls horizontally on overflow, so the bar height
          never grows with the number of kinds. */}
      <div class="topology-toolbar" ref={toolbarEl}>
      {/* Row 1 — search + group: the resource search plus the layout selector. */}
      <div class="toolbar-row topology-search">
        {/* Wraps the input so the magnifier glyph (positional, decorative) and the clear-X button
            sit inside the field's frame instead of beside it. */}
        <div class="topology-search-field">
          <svg class="topology-search-icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle cx="6" cy="6" r="3.5" />
            <line x1="8.6" y1="8.6" x2="12" y2="12" />
          </svg>
          <input
            ref={props.searchRef}
            placeholder="Search resources…  ( ⌘K )"
            aria-label="Search resources in current view"
            // Surface the structured-form (cycle 295) on hover so an operator who pasted a
            // Kind/name and got a single hit can intuit why — also discoverable for those who
            // haven't read the help overlay.
            title="Search by name, kind, status, IP, image, or label. Enter steps through matches; po/web finds one kind."
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (query()) setQuery('')
                else (e.currentTarget as HTMLInputElement).blur()
              }
              else if (e.key === 'Enter') {
                // Cycle through matches: first Enter picks the most-troubled (orderedForNav).
                // Subsequent Enters step to the next match in that order; Shift+Enter steps back.
                // Wraps at both ends. With nothing matched it's a no-op.
                const ordered = matchOrdered()
                if (ordered.length === 0) return
                const cur = ordered.findIndex((n) => n.id === props.selectedId)
                const dir = e.shiftKey ? -1 : 1
                const next = cur < 0
                  ? (dir > 0 ? 0 : ordered.length - 1)
                  : (cur + dir + ordered.length) % ordered.length
                props.onSelect(ordered[next].id)
              }
            }}
          />
          <Show when={query()}>
            <button class="topology-search-clear" onClick={() => setQuery('')} title="Clear (Esc)" aria-label="Clear search">
              ×
            </button>
          </Show>
        </div>
        <Show when={matches()}>
          {/* The count is also the affordance: clicking it flies to the matches (frameMatches),
              so a mouse operator who typed a query and sees only faded cards has a discoverable way
              to reach the results — complementing Enter-cycling for the keyboard. Disabled (a true
              no-op) when nothing matches. */}
          <button
            type="button"
            class="topology-matches"
            classList={{ none: matches()!.size === 0 }}
            disabled={matches()!.size === 0}
            onClick={frameMatches}
            // When the current selection is itself a match, prefix the count with its 1-based
            // position in the cycle order — so an operator pressing Enter knows "I'm at 3 of 7"
            // and can predict when the cycle wraps. Falls back to the bare count if the selection
            // is outside the match set (or no selection).
            title={
              matchPos() > 0
                ? `Match ${matchPos()} of ${matches()!.size} — click to frame all`
                : matches()!.size === 0
                  ? 'Nothing matches this search'
                  : `Click to frame the ${matches()!.size} match${matches()!.size === 1 ? '' : 'es'}`
            }
          >
            <Show
              when={matches()!.size === 0}
              fallback={matchPos() > 0
                ? `${matchPos()} of ${matches()!.size}`
                : `${matches()!.size} match${matches()!.size === 1 ? '' : 'es'}`}
            >
              no matches
            </Show>
          </button>
        </Show>
        {/* Clear-all: surfaces the same operation as Escape, but discoverable without knowing
            the shortcut. Visible only when at least one filter is on, so the toolbar stays
            quiet when there's nothing to clear (cycle 216). */}
        <Show when={(matches() || props.healthFilter || activeKinds()) && props.onClearFilters}>
          <button class="topology-clear" onClick={() => props.onClearFilters?.()} title="Clear all filters (Esc)">
            clear
          </button>
        </Show>
        {/* Group facet — the layout selector. Single-select, so a connected segmented control (the
            contrast against the toggle chips signals "pick one mode"). Shares row 1 with the search
            field to keep the panel short. */}
        <Show when={props.onGroupBy}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Group</span>
            {/* Single-select → a radiogroup (not aria-pressed toggle buttons): a screen reader hears
                "radio group, Relationship selected, 1 of 3" and arrow keys move between options, the
                expected segmented-control model. */}
            <div
              class="group-seg"
              role="radiogroup"
              aria-label="Group resources by"
              onKeyDown={(e) => {
                const ids = GROUP_OPTIONS.map((g) => g.id)
                const i = nextRovingIndex(e.key, ids.indexOf(props.groupBy ?? 'relationship'), ids.length)
                if (i === null) return
                e.preventDefault()
                props.onGroupBy?.(ids[i])
                groupSegRefs[ids[i]]?.focus()
              }}
            >
              <For each={GROUP_OPTIONS}>
                {(g) => (
                  <button
                    ref={(el) => (groupSegRefs[g.id] = el)}
                    role="radio"
                    aria-checked={(props.groupBy ?? 'relationship') === g.id}
                    tabindex={(props.groupBy ?? 'relationship') === g.id ? 0 : -1}
                    classList={{ active: (props.groupBy ?? 'relationship') === g.id }}
                    onClick={() => props.onGroupBy?.(g.id)}
                    title={g.hint}
                  >
                    {g.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        {/* Capacity-view facet — only in the Nodes group-by. Resource picks which single metric
            sizes the bars (CPU/memory never share one length channel). The bars are the explicit
            Req + Use stacked form; this namespace's pods render individually and the rest fold into
            one labelled "other namespaces" block, so no separate legend is needed. */}
        <Show when={props.groupBy === 'nodes'}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Resource</span>
            <div
              class="group-seg"
              role="radiogroup"
              aria-label="Size bars by resource"
              onKeyDown={(e) => {
                const ids: CapResource[] = ['cpu', 'memory']
                const i = nextRovingIndex(e.key, ids.indexOf(capResource()), ids.length)
                if (i === null) return
                e.preventDefault()
                setCapResource(ids[i])
                capResRefs[ids[i]]?.focus()
              }}
            >
              <For each={[{ id: 'cpu', label: 'CPU' }, { id: 'memory', label: 'Memory' }] as const}>
                {(r) => (
                  <button
                    ref={(el) => (capResRefs[r.id] = el)}
                    role="radio"
                    aria-checked={capResource() === r.id}
                    tabindex={capResource() === r.id ? 0 : -1}
                    classList={{ active: capResource() === r.id }}
                    onClick={() => setCapResource(r.id)}
                    title={`Size the bars by ${r.label}`}
                  >
                    {r.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
        {/* Row 2 — Relationships + Health: which links are drawn, and the health spotlight. The
            Relationships facet only appears in the relationship grouping: it's the one view whose
            layout AND arrows the relationship filter drives. The Nodes view draws no edges (it groups
            pods by host) and the Kind view draws no edges either (the cross-kind backbone is pure
            noise in a per-kind matrix), so the facet would be inert there — suppress it and let the
            row carry the health pills alone. */}
        <Show when={(props.groupBy === 'relationship' && relChips().length > 0 && props.onRelFilter) || (shownHealth().length > 0 && props.onHealthFilter) || (isRelGrouping() && props.onShowOrphaned)}>
          <div class="toolbar-row">
        {/* Relationships facet — which relationship categories are drawn (and so drive
            connectivity). Composable toggles: several can be active at once. One chip per category
            present in the graph; Shift+click solos. */}
        <Show when={props.groupBy === 'relationship' && relChips().length > 0 && props.onRelFilter}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Relationships</span>
            <div class="topology-rels" role="toolbar" aria-label="Relationship filter" onKeyDown={onToolbarKey}>
            <For each={visibleRelChips()}>
              {(c, i) => (
                <button
                  class="rel-chip"
                  tabindex={i() === 0 ? 0 : -1}
                  classList={{ active: props.relFilter?.has(c.id) ?? false }}
                  aria-pressed={props.relFilter?.has(c.id) ?? false}
                  onClick={(e) => props.onRelFilter?.(c.id, e.shiftKey)}
                  title={`${c.hint} · Shift+click to show only this`}
                >
                  {c.label}
                  <span class="rel-chip-count">{c.count}</span>
                </button>
              )}
            </For>
            {/* Disclosure for the folded secondary lenses (RBAC/Disruption/Monitoring). Shown only when
                at least one is foldable; "+N more" reveals them inline, "less" folds them back. */}
            <Show when={foldableRelCount() > 0 || relsExpanded()}>
              <button
                class="rel-chip rel-more"
                tabindex={-1}
                aria-expanded={relsExpanded()}
                onClick={toggleRelsExpanded}
                title={relsExpanded() ? 'Show fewer relationship types' : 'Show RBAC, Disruption, Monitoring'}
              >
                {relsExpanded() ? 'less' : `+${foldableRelCount()} more`}
              </button>
            </Show>
            </div>
          </div>
        </Show>
        {/* Health facet — spotlight a health state. Shares row 2 with Relationships. The
            at-a-glance proportion lives in the fixed-width stripe pinned to the top of the canvas
            (rendered below), not here — so this row never changes the stripe's width. */}
        <Show when={shownHealth().length > 0 && props.onHealthFilter}>
          <div class="toolbar-facet">
            <span class="toolbar-label">Health</span>
            <div class="topology-health-pills" role="toolbar" aria-label="Health filter" onKeyDown={onToolbarKey}>
            <For each={shownHealth()}>
              {(h, i) => (
                <button
                  class="legend-item"
                  tabindex={i() === 0 ? 0 : -1}
                  aria-pressed={props.healthFilter === h}
                  classList={{ active: props.healthFilter === h }}
                  // Active pill borrows the health hue for its border + tint, so the link to
                  // "spotlighting THIS color" stays explicit (matches the kind chips' accent).
                  style={
                    props.healthFilter === h
                      ? {
                          'border-color': healthColor(h),
                          background: `color-mix(in srgb, ${healthColor(h)} 14%, transparent)`,
                          color: 'var(--text)',
                        }
                      : undefined
                  }
                  onClick={() => props.onHealthFilter?.(props.healthFilter === h ? null : h)}
                  title={`Spotlight ${h} resources`}
                >
                  <span class="dot" style={{ background: healthColor(h) }} />
                  {h}
                  <span class="legend-count">{healthStats()[h]}</span>
                </button>
              )}
            </For>
            </div>
          </div>
        </Show>
        {/* Show-orphaned toggle — relationship grouping only. Orphans (no displayed relationship) hide by
            default so the canvas reads as the tree; the count advertises how many are tucked away so the
            operator knows the toggle is worth flipping (explicit over implicit). Degraded orphans still
            surface under the Degraded filter regardless, so this never buries broken resources. */}
        <Show when={isRelGrouping() && props.onShowOrphaned}>
          <div class="toolbar-facet">
            <label
              class="toolbar-checkbox"
              title="Also show resources with no connection in this view"
            >
              <input
                type="checkbox"
                checked={!!props.showOrphaned}
                onChange={(e) => props.onShowOrphaned?.(e.currentTarget.checked)}
              />
              Show orphaned
              <Show when={orphanIds().size > 0}>
                <span class="toolbar-checkbox-count">{orphanIds().size}</span>
              </Show>
            </label>
          </div>
        </Show>
          </div>
        </Show>
        {/* Row 3 — Kinds: the kind filter, usually the widest row, on its own line. Click toggles a
            kind in/out of the active set (multi-select, composes with search + health); Shift+click
            solos. Hidden when only one kind is present. Each chip carries the same monochrome
            silhouette as its cards, so the row reads as a legend of "what kinds are here". */}
        <Show when={kindChips().length > 1 && props.onKindFilter}>
          <div class="toolbar-row">
          <div class="toolbar-facet toolbar-facet-grow">
            <span class="toolbar-label">Kinds</span>
            <div
              class="topology-kinds"
              classList={{ 'scroll-l': kindsEdges().l, 'scroll-r': kindsEdges().r }}
              ref={kindsRowEl}
              onScroll={updateKindsEdges}
              role="toolbar"
              aria-label="Kind filter"
              onKeyDown={onToolbarKey}
            >
            <For each={kindChips()}>
              {(c, i) => (
                <button
                  class="kind-chip"
                  tabindex={i() === 0 ? 0 : -1}
                  classList={{ active: activeKinds()?.has(c.kind) ?? false, 'kind-pod': c.kind === 'Pod', troubled: c.worst != null }}
                  onClick={(e) => props.onKindFilter?.(c.kind, e.shiftKey)}
                  title={
                    c.worst
                      ? `${c.kind} · Shift+click to show only this — some are ${c.worst}`
                      : `${c.kind} · Shift+click to show only this`
                  }
                  // The visible chip is a compact abbreviation + count ("SA42"), which a screen reader
                  // would announce as a cryptic string. Give it a real accessible NAME (the full kind +
                  // count + any trouble) so AT reads "ServiceAccount, 42" — the title stays as the
                  // interaction-hint description, and aria-pressed conveys the toggle state.
                  aria-label={`${c.kind}, ${c.count}${c.worst ? `, some ${c.worst}` : ''}`}
                  aria-pressed={activeKinds()?.has(c.kind) ?? false}
                >
                  <svg class="kind-chip-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                    {kindIcon(c.kind)}
                  </svg>
                  <span class="kind-chip-label">{kindShortLabel(c.kind)}</span>
                  {/* Tiny severity dot (cycle 289): kinds with any non-Healthy resource get a
                      colored pip in their bottom-right. Preserves the count-based chip order so
                      muscle memory survives, while still surfacing "which kinds carry trouble" at
                      a glance — answer the operator's "where do I look?" without scanning cards. */}
                  <Show when={c.worst}>
                    <span class="kind-chip-dot" style={{ background: healthColor(c.worst!) }} aria-hidden="true" />
                  </Show>
                  <span class="kind-chip-count">{c.count}</span>
                </button>
              )}
            </For>
            </div>
          </div>
          </div>
        </Show>
      </div>
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
              shows as stacked req/use bars (split) or one usage bar + a Σrequest marker (overlay).
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
                    // Cycle 276: clicking a kind group's bg/label solos that kind in the filter,
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
                    {/* A 12px kind icon at the label's y-baseline (icon is 14×14 in viewBox space;
                        translate so it centers vertically on the text baseline). */}
                    <g class="kind-group-icon" transform={`translate(${g.x}, ${g.y + 1}) scale(0.86)`}>
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
                  // Hovering anywhere on the edge halos both endpoint cards (cycle 330/R4). The hit
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
                    stroke-dasharray={DASHED[e.type] ? '5 4' : undefined}
                    marker-end="url(#arrow)"
                  />
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
                    // Endpoint of the hovered edge (cycle 330/R4): a transient accent halo.
                    target: edgeEndpoint(n.id),
                    exiting: exitingIds().has(n.id),
                    [`h-${n.health.toLowerCase()}`]: true,
                    // Pod kind gets a CSS hook for the accent treatment (cycle 202): pods are the
                    // fundamental workload, so they read distinct from their controllers/services
                    // even before the operator focuses on the card.
                    'kind-pod': n.kind === 'Pod',
                  }}
                  /* CSS transform (not the SVG attribute) so browsers can transition position
                     changes — when SSE patches shift the Dagre layout, cards glide to their new
                     spots instead of teleporting. See .node { transition: transform … } in CSS. */
                  style={{ transform: `translate(${n.x - n.width / 2}px, ${n.y - n.height / 2}px)` }}
                  /* Cycle 298: clicking the already-selected card deselects (mirrors how the legend
                     pills and kind chips toggle on a repeat click). Cycle 315: the toggle-OFF is
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
                >
                  {/* Hover tooltip: a compact "everything on the card + a little more" view, so
                      a tightly-truncated card in a zoomed-out graph still reveals the full name,
                      age, host (pods), and restart count without selecting it. */}
                  <title>{cardTitle(n, now())}</title>
                  <rect class="node-bg" width={n.width} height={n.height} rx="9" />
                  {/* Cycle 163: a faint white-to-transparent strip across the top of the card
                      gives the surface a subtle "glass tile" highlight (more pronounced on the
                      tinted non-healthy cards). Drawn at 1.5px below the bg's top border so it
                      tucks inside the rounded corners. */}
                  <rect class="node-glaze" x="1.5" y="1.5" width={n.width - 3} height={Math.min(20, n.height / 3)} rx="7.5" />
                  {/* Icon-forward card (cycle 126): a 28×28 kind silhouette anchors the left column
                      and a small uppercase kind label sits under it; the right column lays name,
                      status and the restart/age badge on their own rows so nothing competes for
                      width. Health is carried by the .node-bg border + tint (see CSS), so a colored
                      stripe is redundant and was removed to reclaim left padding for the icon. */}
                  {/* Optically-centered icon (cycle 306): a full-box glyph inks ~y14–34, i.e. ~2px
                      above the card's geometric center (y30). Geometric centering (cycle 305) measured
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
                          : `Show ${meta().hidden.length} more ${pluralizeKind(meta().groupKind, meta().hidden.length)}`
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
                      <rect class="collapse-pill-bg" width={n.width} height={n.height} rx="9" />
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
                          y={collapseMatchCount(meta()) > 0 ? 24 : 35}
                          text-anchor="middle"
                        >
                          + show {meta().hidden.length} more
                        </text>
                        <Show when={collapseMatchCount(meta()) > 0}>
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
                {/* Per-grouping summary (cycle 231): Kind grouping shows the kind count, Nodes
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
      <button class="topology-fit" onClick={resetView} title="Fit to view (f)">
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
