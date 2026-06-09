import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'
import { CLUSTER_SCOPE, type NamespaceInfo } from '../api'
import { HEALTH_ORDER, healthColor, healthHint, healthSeverity } from '../health'

interface Props {
  namespaces: NamespaceInfo[]
  selected: string | null
  onSelect: (ns: string) => void
  loading: boolean
  failed: boolean
  // Lets the app focus the filter from a global key ("/").
  filterRef?: (el: HTMLInputElement) => void
  // Lets the failure state offer a retry button — optional so a caller that hides the
  // namespaces list outright (or has no refresh handler) still works.
  onRetry?: () => void
  // Monotonic tick bumped by the app on a programmatic "jump to namespace" (Alt+T, first-load
  // auto-select). Each change flashes the now-selected row so the eye finds where the jump landed —
  // a plain selection (a click the operator made themselves) doesn't pulse, since they know where it is.
  flash?: number
  // Jump to the most-troubled namespace (same path as Alt+T). Wired to the trouble badge so the
  // "N need attention" count is also the one-click way to GET there — not just a passive number.
  onJumpToTrouble?: () => void
}

// Sidebar lists the namespaces the caller may see (already RBAC-filtered by the server) in a stable
// alphabetical order, with a quick filter box. Each namespace carries a health dot — green when
// healthy, red/amber/gray for trouble — so an operator reads the cluster's state as a column of
// color without opening each one; a quiet key under the title spells out the dot and the count for
// first-time visitors.
export default function Sidebar(props: Props) {
  const [filter, setFilter] = createSignal('')
  // The whole row carries the health tooltip, not just the 8px dot: the dot is too small a target to
  // land on, so an operator hovering the namespace NAME (the obvious target) saw nothing. Native
  // `title` resolves to the nearest ancestor with one, so this covers the name, padding, and dot.
  const rowTitle = (n: NamespaceInfo) =>
    healthHint[n.health] + ((n.nonReady ?? 0) > 0 ? ` · ${n.nonReady} not ready` : '')
  // The cluster pseudo-namespace is split out from the rest: it's pinned above the namespace
  // list (and the filter doesn't apply to it) so it stays a stable jump target regardless of
  // what the operator is searching for. Server-side it's identified by CLUSTER_SCOPE.
  const clusterEntry = createMemo(() => props.namespaces.find((n) => n.name === CLUSTER_SCOPE) ?? null)
  // Plain alphabetical order — a namespace keeps its row no matter how its health changes. We used
  // to float troubled namespaces to the top, but that re-shuffled the list every time a rollout or
  // failure changed a namespace's health, so the row an operator was aiming for moved under the
  // cursor. Health is already conveyed by the dot colour, so a stable A→Z list is easier to operate.
  // Exclude the cluster entry — it has its own pinned row above the list.
  const shown = createMemo(() => {
    const f = filter().toLowerCase()
    return props.namespaces
      .filter((n) => n.name !== CLUSTER_SCOPE && n.name.toLowerCase().includes(f))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  // The red "needs attention" badge counts only namespaces that are actively not-OK — Degraded
  // (broken) or Progressing (mid-rollout). Unknown (a CR/resource kd can't classify) and Suspended
  // (intentionally off) are excluded: counting them turned a cluster full of harmless custom
  // resources into a permanent red alarm (cycle 313, follows up the cycle-308 gray-dot fix). The list
  // itself stays A→Z (see `shown` above — troubled-first sorting was dropped because it re-shuffled
  // rows under the cursor); every namespace still shows its own health dot, only the badge COUNT narrows.
  const troubled = createMemo(
    () => props.namespaces.filter((n) => n.name !== CLUSTER_SCOPE && healthSeverity[n.health] >= healthSeverity.Progressing).length,
  )

  // Scroll the active ns into view when the selection changes externally — e.g. on first load
  // when mostTroubled() picks the auto-selected namespace, or when a URL change navigates to
  // one not currently visible (long list, scrolled away). Block: 'nearest' so we don't jump
  // when the item is already in view (cycle 242).
  let listRef: HTMLUListElement | undefined
  createEffect(
    on(
      () => props.selected,
      (sel) => {
        if (!sel || !listRef) return
        const el = listRef.querySelector('.active') as HTMLElement | null
        el?.scrollIntoView({ block: 'nearest' })
      },
    ),
  )
  // Flash the selected row on a programmatic jump (cycle 330/R5). 'nearest' scrolling above stays
  // silent when the row is already visible, so without this an Alt+T jump can land with no visible
  // change. Deferred to a microtask so the .active class for the new selection has been committed
  // before we look it up; remove/reflow/add restarts the CSS animation when the same row re-flashes.
  createEffect(
    on(
      () => props.flash,
      () => {
        if (!listRef) return
        queueMicrotask(() => {
          const el = listRef?.querySelector('.active') as HTMLElement | null
          if (!el) return
          el.scrollIntoView({ block: 'nearest' })
          el.classList.remove('ns-flash')
          void el.offsetWidth
          el.classList.add('ns-flash')
          el.addEventListener('animationend', () => el.classList.remove('ns-flash'), { once: true })
        })
      },
      { defer: true },
    ),
  )

  return (
    <nav class="sidebar" aria-label="Namespaces">
      <div class="sidebar-title">
        Namespaces
        {/* Total namespace count next to the title — quick "how big is this cluster's RBAC
            surface" read. The cluster pseudo-entry is excluded (it's not a real ns), matching
            the trouble badge below. Tabular-nums so the number sits at a constant width. */}
        <Show when={props.namespaces.length > 1}>
          <span class="ns-total" title="visible namespaces">
            {props.namespaces.filter((n) => n.name !== CLUSTER_SCOPE).length}
          </span>
        </Show>
        <Show when={troubled() > 0}>
          {/* The trouble count is also the jump affordance: clicking it steps to the next troubled
              namespace (Alt+T's path), worst-first and cycling, so the operator can triage all of them
              with repeated clicks without scanning the list or knowing the shortcut. Falls back to a
              plain badge when no jump handler is wired. */}
          <Show
            when={props.onJumpToTrouble}
            fallback={<span class="ns-trouble" title={`${troubled()} need attention`}>{troubled() > 99 ? '99+' : troubled()}</span>}
          >
            <button
              class="ns-trouble ns-trouble-btn"
              title={
                troubled() > 1
                  ? `Step through the ${troubled()} namespaces needing attention (worst first) — click again for the next`
                  : 'Jump to the namespace needing attention'
              }
              aria-label={
                troubled() > 1
                  ? `Step to the next of ${troubled()} namespaces needing attention`
                  : 'Jump to the namespace needing attention'
              }
              onClick={() => props.onJumpToTrouble?.()}
            >
              {troubled() > 99 ? '99+' : troubled()}
            </button>
          </Show>
        </Show>
        {/* Screen-reader counterpart to the trouble badge + favicon dot: a polite live region announces
            when the cluster's trouble count changes (a rollout degrades a namespace) — the single most
            important sidebar state change — so an AT user monitoring the cluster HEARS it arrive instead
            of only seeing the red pill appear. Empty when all-clear, so it stays silent until trouble. */}
        <span class="sr-only" role="status">
          {troubled() > 0 ? `${troubled()} ${troubled() === 1 ? 'namespace needs' : 'namespaces need'} attention` : ''}
        </span>
      </div>
      <div class="sidebar-filter-field">
        <svg class="topology-search-icon" viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
          <circle cx="6" cy="6" r="3.5" />
          <line x1="8.6" y1="8.6" x2="12" y2="12" />
        </svg>
        <input
          ref={props.filterRef}
          class="sidebar-filter"
          placeholder="Filter…  ( / · ↑↓ )"
          aria-label="Filter namespaces"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (filter()) setFilter('')
              else (e.currentTarget as HTMLInputElement).blur()
            }
            else if (e.key === 'Enter') {
              // Jump straight to the top-of-list match — operators expect filter+Enter to be
              // an explicit "go" action, not a "remember the search" no-op (cycle 223). The list
              // is alphabetical, so this lands on the first matching ns by name.
              const first = shown()[0]
              if (first) {
                props.onSelect(first.name)
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              // Step the selection through the filtered list without leaving the input — operators
              // can preview each ns's health (dot/count change) while keeping the filter typed.
              // Skips the cluster pseudo-entry (it's pinned, outside shown()) so the typed filter
              // governs which subset gets stepped through.
              const list = shown()
              if (list.length === 0) return
              e.preventDefault()
              const dir = e.key === 'ArrowDown' ? 1 : -1
              const cur = list.findIndex((n) => n.name === props.selected)
              const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length
              props.onSelect(list[next].name)
            }
          }}
        />
        <Show when={filter()}>
          <button class="topology-search-clear" onClick={() => setFilter('')} title="Clear (Esc)" aria-label="Clear filter">
            ×
          </button>
        </Show>
      </div>
      <Show when={!props.loading} fallback={<div class="sidebar-loading">loading…</div>}>
        <Show
          when={!props.failed}
          fallback={
            <div class="sidebar-loading">
              Couldn't load namespaces.
              <Show when={props.onRetry}>
                <button class="sidebar-retry" onClick={() => props.onRetry?.()}>
                  retry
                </button>
              </Show>
            </div>
          }
        >
          <ul class="ns-list" ref={listRef}>
            {/* Pinned cluster pseudo-namespace (FR-004): always above the namespace list and
                outside the filter, so the operator can always jump to cluster-scoped state
                — Nodes, PVs, ClusterRoles, cluster-scoped CRs — in one click. Visually
                distinct (italic label, brackets) so it doesn't look like a regular namespace. */}
            <Show when={clusterEntry()}>
              {(c) => (
                <li>
                  <button
                    class="ns-cluster"
                    classList={{ active: c().name === props.selected }}
                    aria-current={c().name === props.selected ? 'page' : undefined}
                    onClick={() => props.onSelect(c().name)}
                    title={rowTitle(c())}
                  >
                    <span class="ns-dot" style={{ background: healthColor(c().health) }} title={healthHint[c().health]} />
                    {/* Tiny cluster/server glyph echoes the Node icon and signals "cluster scope"
                        without requiring the user to read the bracketed text first. */}
                    <svg class="ns-cluster-icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                      <rect x="1" y="2.5" width="10" height="7" rx="1" />
                      <line x1="1" y1="6" x2="11" y2="6" />
                      <circle cx="2.8" cy="4.2" r="0.5" fill="currentColor" />
                      <circle cx="2.8" cy="8" r="0.5" fill="currentColor" />
                    </svg>
                    <span class="ns-name ns-name-cluster">[cluster]</span>
                    <Show when={(c().nonReady ?? 0) > 0}>
                      <span
                        class="ns-count"
                        style={{ color: healthColor(c().health) }}
                        title={`${c().nonReady} non-ready · ${c().health}`}
                      >
                        {(c().nonReady ?? 0) > 99 ? '99+' : c().nonReady}
                      </span>
                    </Show>
                  </button>
                </li>
              )}
            </Show>
            <For each={shown()}>
              {(ns) => (
                <li>
                  <button
                    classList={{ active: ns.name === props.selected }}
                    aria-current={ns.name === props.selected ? 'page' : undefined}
                    onClick={() => props.onSelect(ns.name)}
                    title={rowTitle(ns)}
                  >
                    <span class="ns-dot" style={{ background: healthColor(ns.health) }} title={healthHint[ns.health]} />
                    <span class="ns-name">{ns.name}</span>
                    <Show when={(ns.nonReady ?? 0) > 0}>
                      {/* Inline color matches the dot (and the topology health-stroke), so the
                          count reads as "this many of THAT color need a look", not as a neutral
                          stat. Healthy ns never carries a count, so falling back to text-dim is
                          only for the (rare) Unknown case. Clamp at "99+" so a runaway namespace
                          (rare, but possible after a node-loss cascade) doesn't widen the row. */}
                      <span
                        class="ns-count"
                        style={{ color: healthColor(ns.health) }}
                        title={`${ns.nonReady} non-ready · ${ns.health}`}
                      >
                        {(ns.nonReady ?? 0) > 99 ? '99+' : ns.nonReady}
                      </span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
            <Show when={shown().length === 0}>
              {/* Distinguish "filtered everything out" from "nothing visible to this user" (RBAC).
                  role="status" announces the empty result to an AT user typing a filter — the ↑↓ nav
                  early-returns on an empty set with no other feedback that the candidates vanished. */}
              <li class="ns-empty" role="status">{props.namespaces.length === 0 ? 'No namespaces visible.' : 'no matches'}</li>
            </Show>
          </ul>
        </Show>
      </Show>
      {/* Always-visible health key, pinned at the bottom. The per-row dot colors and trailing counts
          meant nothing to a first-time visitor; a static legend spells out every state and the
          number, with no hover or delay. Shown only once there are real namespaces to annotate —
          not on the loading / failed / empty states. Unknown is omitted: a namespace's color and
          count both ignore Unknown resources (non-actionable noise), so a namespace dot is never
          gray — listing Unknown would explain a state the list can't show. */}
      <Show when={!props.loading && !props.failed && props.namespaces.some((n) => n.name !== CLUSTER_SCOPE)}>
        <div class="ns-legend">
          <div class="ns-legend-title">Legend</div>
          <div class="ns-legend-items">
            <For each={HEALTH_ORDER.filter((h) => h !== 'Unknown')}>
              {(h) => (
                <span class="ns-legend-item" title={healthHint[h]}>
                  <span class="ns-dot" style={{ background: healthColor(h) }} />
                  {h}
                </span>
              )}
            </For>
          </div>
          <div class="ns-legend-num">
            <span class="ns-count ns-legend-num-badge">#</span>= resources not ready
          </div>
        </div>
      </Show>
    </nav>
  )
}
