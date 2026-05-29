import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'
import { CLUSTER_SCOPE, type NamespaceInfo } from '../api'
import { healthColor, healthSeverity } from '../health'
import { compareNamespaces } from '../ns'

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
}

// Sidebar lists the namespaces the caller may see (already RBAC-filtered by the server) with a
// quick filter box. Each namespace carries a health dot — green when healthy, red/amber/gray for
// trouble — so an operator reads the cluster's state as a column of color without opening each one.
export default function Sidebar(props: Props) {
  const [filter, setFilter] = createSignal('')
  // The cluster pseudo-namespace is split out from the rest: it's pinned above the namespace
  // list (and the filter doesn't apply to it) so it stays a stable jump target regardless of
  // what the operator is searching for. Server-side it's identified by CLUSTER_SCOPE.
  const clusterEntry = createMemo(() => props.namespaces.find((n) => n.name === CLUSTER_SCOPE) ?? null)
  // Troubled namespaces sort to the top (operators look there first); ties break alphabetically.
  // Exclude the cluster entry — it has its own pinned row, not part of the alpha-sorted list.
  const shown = createMemo(() => {
    const f = filter().toLowerCase()
    return props.namespaces
      .filter((n) => n.name !== CLUSTER_SCOPE && n.name.toLowerCase().includes(f))
      .slice()
      .sort(compareNamespaces)
  })
  // The red "needs attention" badge counts only namespaces that are actively not-OK — Degraded
  // (broken) or Progressing (mid-rollout). Unknown (a CR/resource kd can't classify) and Suspended
  // (intentionally off) are excluded: counting them turned a cluster full of harmless custom
  // resources into a permanent red alarm (cycle 313, follows up the cycle-308 gray-dot fix). The
  // troubled-first SORT below still floats every non-Healthy ns up — only the alarm count narrows.
  const troubled = createMemo(
    () => props.namespaces.filter((n) => n.name !== CLUSTER_SCOPE && healthSeverity[n.health] >= healthSeverity.Progressing).length,
  )
  // Index of the first healthy entry in the sorted list, so a divider can mark the transition
  // between "needs attention" and "fine"; -1 means no boundary (all troubled or all healthy).
  const dividerAt = createMemo(() => {
    const list = shown()
    const firstHealthy = list.findIndex((n) => n.health === 'Healthy')
    return firstHealthy > 0 && firstHealthy < list.length ? firstHealthy : -1
  })

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
    <nav class="sidebar">
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
          <span class="ns-trouble" title={`${troubled()} need attention`}>{troubled() > 99 ? '99+' : troubled()}</span>
        </Show>
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
              // an explicit "go" action, not a "remember the search" no-op (cycle 223). The
              // first item is troubled-first sorted, so this lands on the most attention-worthy
              // ns matching the filter.
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
                    onClick={() => props.onSelect(c().name)}
                  >
                    <span class="ns-dot" style={{ background: healthColor(c().health) }} title={c().health} />
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
              {(ns, i) => (
                <>
                  {/* Quiet rule between the last troubled and first healthy namespace, so the
                      troubled-first sort reads as deliberate grouping ("here's what's wrong",
                      then "here's everything else") rather than an unmotivated order. */}
                  <Show when={i() === dividerAt()}>
                    <li class="ns-divider" aria-hidden="true" />
                  </Show>
                <li>
                  <button classList={{ active: ns.name === props.selected }} onClick={() => props.onSelect(ns.name)}>
                    <span class="ns-dot" style={{ background: healthColor(ns.health) }} title={ns.health} />
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
                </>
              )}
            </For>
            <Show when={shown().length === 0}>
              {/* Distinguish "filtered everything out" from "nothing visible to this user" (RBAC). */}
              <li class="ns-empty">{props.namespaces.length === 0 ? 'No namespaces visible.' : 'no matches'}</li>
            </Show>
          </ul>
        </Show>
      </Show>
    </nav>
  )
}
