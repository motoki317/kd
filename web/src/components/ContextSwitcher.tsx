import { For, Show } from 'solid-js'
import type { ContextsResponse } from '../api'

interface Props {
  // info is null while the contexts list is loading or failed. Null hides the switcher entirely so
  // a broken /api/v1/contexts call doesn't leave a dead control in the topbar.
  info: ContextsResponse | null
  current: string | null
  onSelect: (ctx: string) => void
}

// shortContextName trims structured cluster identifiers down to the human-meaningful tail so the
// switcher dropdown stays readable. EKS contexts kubeconfigs typically use a full ARN
// ("arn:aws:eks:us-west-2:111122223333:cluster/prod-cluster"); the operator thinks of the
// cluster by its trailing name. GKE/OpenShift use similarly long names — best effort to extract
// the trailing identifier after the last "/" or ":" (whichever is further right). The full
// original is preserved in the option's title (hover) so the ARN stays discoverable.
export function shortContextName(full: string): string {
  // The terminal slash component is the most useful for AWS/GCP-style ARNs and resource paths.
  const slashIdx = full.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < full.length - 1) return full.slice(slashIdx + 1)
  return full
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
        aria-label="Kubernetes context"
        value={props.current ?? props.info!.default}
        onChange={(e) => props.onSelect(e.currentTarget.value)}
      >
        <For each={props.info!.contexts}>
          {(c) => (
            // Contexts with an error during cache build are disabled so a stale credential can't be
            // chosen — the raw client-go error is exposed in the tooltip for local-dev debugging.
            // The option's value is the full kubeconfig context name (URL truth); the visible label
            // is the trimmed tail (cycle 210). Hover reveals the full identifier.
            <option
              value={c.name}
              disabled={c.status === 'error'}
              title={c.error || (c.name !== shortContextName(c.name) ? c.name : undefined)}
            >
              {shortContextName(c.name)}
              {c.name === props.info!.default ? ' (default)' : ''}
              {c.status === 'error' ? ' — unavailable' : ''}
            </option>
          )}
        </For>
      </select>
    </Show>
  )
}
