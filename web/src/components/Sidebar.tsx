import { createMemo, createSignal, For, Show } from 'solid-js'
import type { NamespaceInfo } from '../api'
import { healthColor } from '../health'
import { compareNamespaces } from '../ns'

interface Props {
  namespaces: NamespaceInfo[]
  selected: string | null
  onSelect: (ns: string) => void
  loading: boolean
  failed: boolean
  // Lets the app focus the filter from a global key ("/").
  filterRef?: (el: HTMLInputElement) => void
}

// Sidebar lists the namespaces the caller may see (already RBAC-filtered by the server) with a
// quick filter box. A namespace with a non-healthy resource shows a colored dot, so an operator
// spots trouble across the cluster without opening each one.
export default function Sidebar(props: Props) {
  const [filter, setFilter] = createSignal('')
  // Troubled namespaces sort to the top (operators look there first); ties break alphabetically.
  const shown = createMemo(() => {
    const f = filter().toLowerCase()
    return props.namespaces
      .filter((n) => n.name.toLowerCase().includes(f))
      .slice()
      .sort(compareNamespaces)
  })
  const troubled = createMemo(() => props.namespaces.filter((n) => n.health !== 'Healthy').length)
  // Index of the first healthy entry in the sorted list, so a divider can mark the transition
  // between "needs attention" and "fine"; -1 means no boundary (all troubled or all healthy).
  const dividerAt = createMemo(() => {
    const list = shown()
    const firstHealthy = list.findIndex((n) => n.health === 'Healthy')
    return firstHealthy > 0 && firstHealthy < list.length ? firstHealthy : -1
  })

  return (
    <nav class="sidebar">
      <div class="sidebar-title">
        Namespaces
        <Show when={troubled() > 0}>
          <span class="ns-trouble" title={`${troubled()} need attention`}>{troubled()}</span>
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
          placeholder="Filter…  ( / )"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
        />
        <Show when={filter()}>
          <button class="topology-search-clear" onClick={() => setFilter('')} title="Clear (Esc)">
            ×
          </button>
        </Show>
      </div>
      <Show when={!props.loading} fallback={<div class="sidebar-loading">loading…</div>}>
        <Show when={!props.failed} fallback={<div class="sidebar-loading">Couldn't load namespaces.</div>}>
          <ul class="ns-list">
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
                    <Show when={ns.health !== 'Healthy'} fallback={<span class="ns-dot ns-dot-ok" />}>
                      <span class="ns-dot" style={{ background: healthColor(ns.health) }} title={ns.health} />
                    </Show>
                    <span class="ns-name">{ns.name}</span>
                    <Show when={(ns.nonReady ?? 0) > 0}>
                      {/* Inline color matches the dot (and the topology health-stroke), so the
                          count reads as "this many of THAT color need a look", not as a neutral
                          stat. Healthy ns never carries a count, so falling back to text-dim is
                          only for the (rare) Unknown case. */}
                      <span
                        class="ns-count"
                        style={{ color: healthColor(ns.health) }}
                        title={`${ns.nonReady} not healthy`}
                      >
                        {ns.nonReady}
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
