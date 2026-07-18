import { createMemo, createSignal, For, Show } from 'solid-js'
import type { CapResource } from '../../resource'
import { healthColor } from '../../health'
import { kindIcon } from '../../icons'
import { kindShortLabel } from '../../names'
import { readRawPref, writePref } from '../../prefs'
import { nextRovingIndex } from '../../rovingFocus'
import { type ScrollEdges } from '../../scrollEdges'
import type { RelCategoryDef } from '../../relationships'
import type { GroupBy, Health, KNode, RelCategory } from '../../types'

// The group-by options, exported so urlState's group validation stays in sync with the segmented
// control rendered in the toolbar.
export const GROUP_OPTIONS: { id: GroupBy; label: string; hint: string }[] = [
  { id: 'relationship', label: 'Relationship', hint: 'Lay resources out along the relationships you enable' },
  { id: 'nodes', label: 'Nodes', hint: 'Group pods into the node they run on' },
  { id: 'kind', label: 'Kind', hint: 'Group every resource into per-kind boxes' },
]

interface Props {
  // The toolbar element itself, handed back to Topology — the viewport fit reads its live height
  // to frame the graph into the visible area BELOW the bar.
  toolbarRef: (el: HTMLDivElement) => void
  searchRef?: (el: HTMLInputElement) => void
  // Stable accessors/callbacks owned by Topology (its memos and viewport functions); the toolbar
  // only reads/invokes them, so they're destructured once below.
  query: () => string
  setQuery: (q: string) => void
  matches: () => Set<string> | null
  matchOrdered: () => KNode[]
  matchPos: () => number
  frameMatches: () => void
  activeKinds: () => Set<string> | null
  capResource: () => CapResource
  setCapResource: (r: CapResource) => void
  relChips: () => (RelCategoryDef & { count: number })[]
  shownHealth: () => Health[]
  healthStats: () => Record<Health, number>
  isRelGrouping: () => boolean
  orphanIds: () => ReadonlySet<string>
  kindChips: () => { kind: string; count: number; worst: Health | null }[]
  kindsEdges: () => ScrollEdges
  kindsRowRef: (el: HTMLDivElement) => void
  updateKindsEdges: () => void
  // Reactive props forwarded straight from Topology's own props (accessed via props.* so they
  // keep tracking).
  selectedId: string | null
  onSelect: (id: string) => void
  healthFilter?: Health | null
  onHealthFilter?: (h: Health | null) => void
  onClearFilters?: () => void
  groupBy?: GroupBy
  onGroupBy?: (g: GroupBy) => void
  relFilter?: ReadonlySet<RelCategory>
  onRelFilter?: (c: RelCategory, solo?: boolean) => void
  showOrphaned?: boolean
  onShowOrphaned?: (v: boolean) => void
  onKindFilter?: (k: string, solo?: boolean) => void
}

export default function Toolbar(props: Props) {
  // Function-valued props never change identity, so destructuring them loses no reactivity —
  // and keeps the JSX below byte-equivalent to its pre-extraction form in Topology.tsx.
  const {
    query,
    setQuery,
    matches,
    matchOrdered,
    matchPos,
    frameMatches,
    activeKinds,
    capResource,
    setCapResource,
    relChips,
    shownHealth,
    healthStats,
    isRelGrouping,
    orphanIds,
    kindChips,
    kindsEdges,
    updateKindsEdges,
  } = props

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

  // The whole filter block (Relationships + Kinds rows) folds behind one "Filters" disclosure,
  // closed by default: the resting toolbar is a single row — search, layout, health — because most
  // sessions never touch the per-kind/per-relationship narrowing, and three permanent rows of
  // equal-weight chips buried the row that matters. Persisted; the active-kind count rides on the
  // button so a collapsed block can never hide that the view is narrowed (the health spotlight and
  // search stay visible in row 1 on their own).
  const [filtersOpen, setFiltersOpen] = createSignal(readRawPref('kd:filtersOpen') === '1')
  const toggleFilters = () =>
    setFiltersOpen((v) => {
      writePref('kd:filtersOpen', v ? '0' : '1')
      return !v
    })
  const hasFoldableFacets = createMemo(
    () =>
      (props.groupBy === 'relationship' && relChips().length > 0 && !!props.onRelFilter) ||
      (kindChips().length > 1 && !!props.onKindFilter) ||
      (isRelGrouping() && !!props.onShowOrphaned),
  )
  const narrowedKinds = createMemo(() => activeKinds()?.size ?? 0)

  return (
    /* The canvas control bar: ONE permanent row — search, layout, health, and the Filters
       disclosure — with the relationship/kind narrowing folded behind it. Each facet is an inline
       label hugging its controls (proximity). The Kinds row, when open, is a strict single line
       that scrolls horizontally on overflow, so the bar height never grows with kind count. */
    <div class="topology-toolbar" ref={props.toolbarRef}>
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
            // Explicit call, not ref={props.searchRef}: with searchRef omitted (tests), Solid's
            // compiled ref helper falls back to ASSIGNING the element onto props — a TypeError on
            // a forwarded getter-only prop. The original sat on Topology's own (plain) props object,
            // where that dead-end assignment was silently absorbed.
            ref={(el) => props.searchRef?.(el)}
            placeholder="Search resources…  ( / )"
            aria-label="Search resources in current view"
            // Surface the structured-form on hover so an operator who pasted a
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
            quiet when there's nothing to clear. */}
        <Show when={(matches() || props.healthFilter || activeKinds()) && props.onClearFilters}>
          <button class="topology-clear" onClick={() => props.onClearFilters?.()} title="Clear all filters (Esc)">
            clear
          </button>
        </Show>
        {/* Group facet — the layout selector. Single-select, so a connected segmented control (the
            contrast against the toggle chips signals "pick one mode"). Shares row 1 with the search
            field to keep the panel short. No caps label: the three option words explain themselves. */}
        <Show when={props.onGroupBy}>
          <div class="toolbar-facet">
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
        {/* Health pills — the cluster's vital sign AND the spotlight filter, so they live on the
            permanent row, not behind the Filters fold. No caps label: each pill already names its
            state in words next to its dot. The at-a-glance proportion lives in the fixed-width
            stripe pinned to the top of the canvas (rendered by Topology). */}
        {/* Health is an ordinal severity ladder, so triage spotlights one state at a time; unlike
            nominal Kinds, it is not multi-select. */}
        <Show when={shownHealth().length > 0 && props.onHealthFilter}>
          <div class="toolbar-facet">
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
        {/* The Filters disclosure: the per-relationship / per-kind narrowing is power-user surface,
            so it folds away and the resting toolbar is ONE row. The active-kind count rides on the
            button so collapsing can't hide that the view is narrowed. */}
        <Show when={hasFoldableFacets()}>
          <button
            class="toolbar-filters-btn"
            aria-expanded={filtersOpen()}
            onClick={toggleFilters}
            title={filtersOpen() ? 'Hide the relationship and kind filters' : 'Filter by relationship or kind'}
          >
            Filters
            <Show when={!filtersOpen() && narrowedKinds() > 0}>
              <span class="toolbar-filters-count">{narrowedKinds()}</span>
            </Show>
            <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden="true" style={{ transform: filtersOpen() ? 'rotate(180deg)' : undefined }}>
              <path d="M 1 1 L 5 5 L 9 1" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </button>
        </Show>
      </div>
      {/* Filter block row 1 — Relationships + orphans: which links are drawn. The Relationships
          facet only appears in the relationship grouping: it's the one view whose layout AND arrows
          the relationship filter drives (the Nodes and Kind views draw no edges). */}
      <Show when={filtersOpen() && ((props.groupBy === 'relationship' && relChips().length > 0 && props.onRelFilter) || (isRelGrouping() && props.onShowOrphaned))}>
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
      {/* Filter block row 2 — Kinds: the kind filter, usually the widest row, on its own line. Click
          toggles a kind in/out of the active set (multi-select, composes with search + health);
          Shift+click solos. Hidden when only one kind is present. Each chip carries the same
          monochrome silhouette as its cards, so the row reads as a legend of "what kinds are here". */}
      <Show when={filtersOpen() && kindChips().length > 1 && props.onKindFilter}>
        <div class="toolbar-row">
          <div class="toolbar-facet toolbar-facet-grow">
            <span class="toolbar-label">Kinds</span>
            <div
              class="topology-kinds"
              classList={{ 'scroll-l': kindsEdges().l, 'scroll-r': kindsEdges().r }}
              ref={props.kindsRowRef}
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
                    {/* Tiny severity dot: kinds with any non-Healthy resource get a
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
  )
}
