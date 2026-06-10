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
// switcher dropdown stays readable. EKS kubeconfigs typically name the context by a full ARN
// ("arn:aws:eks:us-west-2:111122223333:cluster/prod-cluster"), but the operator thinks of the
// cluster by its trailing name. We extract the component after the LAST "/" — the cluster id sits
// there in every "/"-terminated form (the EKS ".../cluster/<name>" suffix, generic resource paths).
// Colon-delimited prefixes are deliberately NOT split: the ARN's meaningful tail is already past its
// final "/", and a name with no "/" (docker-desktop, an underscore-joined GKE id) has no safe split
// point, so it passes through whole. The full original is kept in the option's title (hover).
export function shortContextName(full: string): string {
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
            // The CURRENT context is never disabled even when broken: disabling the selected option
            // made the browser silently move the native selection to the next enabled option, so the
            // topbar named a DIFFERENT cluster than the one the URL and canvas showed (D79).
            // `selected` is declared on the option itself so the choice also survives the <For>
            // re-rendering the list (the contexts refetch after a stream failure churns the option
            // nodes, and the select-level value binding loses that race).
            // The option's value is the full kubeconfig context name (URL truth); the visible label
            // is the trimmed tail (cycle 210). Hover reveals the full identifier.
            <option
              value={c.name}
              selected={c.name === (props.current ?? props.info!.default)}
              disabled={c.status === 'error' && c.name !== props.current}
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
