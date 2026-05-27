import { createMemo, createSignal, For, Show } from 'solid-js'
import type { NamespaceInfo } from '../api'
import { healthColor, healthSeverity } from '../health'

interface Props {
  namespaces: NamespaceInfo[]
  selected: string | null
  onSelect: (ns: string) => void
  loading: boolean
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
      .sort((a, b) => healthSeverity[b.health] - healthSeverity[a.health] || a.name.localeCompare(b.name))
  })
  const troubled = createMemo(() => props.namespaces.filter((n) => n.health !== 'Healthy').length)

  return (
    <nav class="sidebar">
      <div class="sidebar-title">
        Namespaces
        <Show when={troubled() > 0}>
          <span class="ns-trouble" title={`${troubled()} need attention`}>{troubled()}</span>
        </Show>
      </div>
      <input
        ref={props.filterRef}
        class="sidebar-filter"
        placeholder="Filter…  ( / )"
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      <Show when={!props.loading} fallback={<div class="sidebar-loading">loading…</div>}>
        <ul class="ns-list">
          <For each={shown()}>
            {(ns) => (
              <li>
                <button classList={{ active: ns.name === props.selected }} onClick={() => props.onSelect(ns.name)}>
                  <Show when={ns.health !== 'Healthy'} fallback={<span class="ns-dot ns-dot-ok" />}>
                    <span class="ns-dot" style={{ background: healthColor(ns.health) }} title={ns.health} />
                  </Show>
                  <span class="ns-name">{ns.name}</span>
                </button>
              </li>
            )}
          </For>
          <Show when={shown().length === 0}>
            <li class="ns-empty">no matches</li>
          </Show>
        </ul>
      </Show>
    </nav>
  )
}
