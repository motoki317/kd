import { createResource, createSignal, Show, Suspense } from 'solid-js'
import { fetchResource, type ManifestFormat } from '../api'
import { healthColor } from '../health'
import type { KNode } from '../types'
import LogViewer from './LogViewer'

interface Props {
  node: KNode | null
  onClose: () => void
}

// DetailDrawer shows the selected resource's metadata and spec, plus live logs for pods.
export default function DetailDrawer(props: Props) {
  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  const [detail] = createResource(
    () =>
      props.node ? { ns: props.node.namespace ?? '', kind: props.node.kind, name: props.node.name, format: format() } : null,
    (key) => fetchResource(key.ns, key.kind, key.name, key.format),
  )

  // Buttons live inside the <summary>; preventDefault stops the click from also toggling the
  // <details> open/closed.
  const pick = (f: ManifestFormat) => (e: MouseEvent) => {
    e.preventDefault()
    setFormat(f)
  }

  return (
    <Show when={props.node}>
      {(node) => (
        <aside class="drawer">
          <header class="drawer-header">
            <div>
              <div class="drawer-kind">
                <span class="dot" style={{ background: healthColor(node().health) }} />
                {node().kind}
              </div>
              <div class="drawer-name">{node().name}</div>
              <Show when={node().namespace}>
                <div class="drawer-ns">{node().namespace}</div>
              </Show>
            </div>
            <button class="drawer-close" onClick={props.onClose} title="Close">
              ×
            </button>
          </header>

          <Show when={node().kind === 'Pod'}>
            <LogViewer namespace={node().namespace ?? ''} pod={node().name} />
          </Show>

          {/* Manifest is reference detail, so it is collapsed for pods (logs lead) and open
              otherwise. A plain <details> keeps it one element, not a stateful toggle. */}
          <details class="drawer-section manifest-section" open={node().kind !== 'Pod'}>
            <summary>
              <span class="manifest-label">Manifest</span>
              <span class="manifest-format">
                <button classList={{ active: format() === 'yaml' }} onClick={pick('yaml')}>
                  YAML
                </button>
                <button classList={{ active: format() === 'json' }} onClick={pick('json')}>
                  JSON
                </button>
              </span>
            </summary>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              <Show when={detail() != null} fallback={<div class="drawer-loading">unavailable</div>}>
                <pre class="manifest">{detail()}</pre>
              </Show>
            </Suspense>
          </details>
        </aside>
      )}
    </Show>
  )
}
