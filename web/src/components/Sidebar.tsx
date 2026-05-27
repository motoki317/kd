import { createMemo, createSignal, For, Show } from 'solid-js'

interface Props {
  namespaces: string[]
  selected: string | null
  onSelect: (ns: string) => void
  loading: boolean
}

// Sidebar lists the namespaces the caller may see (already RBAC-filtered by the server) with a
// quick filter box.
export default function Sidebar(props: Props) {
  const [filter, setFilter] = createSignal('')
  const shown = createMemo(() => {
    const f = filter().toLowerCase()
    return props.namespaces.filter((n) => n.toLowerCase().includes(f))
  })

  return (
    <nav class="sidebar">
      <div class="sidebar-title">Namespaces</div>
      <input
        class="sidebar-filter"
        placeholder="Filter…"
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      <Show when={!props.loading} fallback={<div class="sidebar-loading">loading…</div>}>
        <ul class="ns-list">
          <For each={shown()}>
            {(ns) => (
              <li>
                <button classList={{ active: ns === props.selected }} onClick={() => props.onSelect(ns)}>
                  {ns}
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
