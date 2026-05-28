import { For, Show } from 'solid-js'
import type { ContextsResponse } from '../api'

interface Props {
  // info is null while the contexts list is loading or failed. Null hides the switcher entirely so
  // a broken /api/v1/contexts call doesn't leave a dead control in the topbar.
  info: ContextsResponse | null
  current: string | null
  onSelect: (ctx: string) => void
}

// ContextSwitcher sits beside the brand in the topbar and lets the operator pick which kubeconfig
// context the dashboard reads from. Hidden in in-cluster mode (info.enabled=false) and when there's
// only one context to choose — the dashboard then looks identical to the pre-multi-context UX.
export default function ContextSwitcher(props: Props) {
  const visible = () => !!props.info && props.info.enabled && props.info.contexts.length > 1
  return (
    <Show when={visible()}>
      <select
        class="ctx-switcher"
        title="Kubernetes context"
        value={props.current ?? props.info!.default}
        onChange={(e) => props.onSelect(e.currentTarget.value)}
      >
        <For each={props.info!.contexts}>
          {(c) => (
            // Contexts with an error during cache build are disabled so a stale credential can't be
            // chosen — the raw client-go error is exposed in the tooltip for local-dev debugging.
            <option value={c.name} disabled={c.status === 'error'} title={c.error || undefined}>
              {c.name}
              {c.name === props.info!.default ? ' (default)' : ''}
              {c.status === 'error' ? ' — unavailable' : ''}
            </option>
          )}
        </For>
      </select>
    </Show>
  )
}
