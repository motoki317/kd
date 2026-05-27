import { createMemo, createResource, createSignal, Show, Suspense } from 'solid-js'
import { fetchResource, type ManifestFormat } from '../api'
import { healthColor } from '../health'
import type { KNode } from '../types'
import LogViewer from './LogViewer'

interface Props {
  node: KNode | null
  onClose: () => void
}

type Tab = 'logs' | 'manifest'

// DetailDrawer shows the selected resource's manifest. Pods also stream live logs, so they get
// Logs/Manifest tabs (defaulting to logs, the developer's first question); other kinds have no
// logs and show the manifest directly.
export default function DetailDrawer(props: Props) {
  const isPod = createMemo(() => props.node?.kind === 'Pod')
  const [tab, setTab] = createSignal<Tab>('logs')

  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text. The manifest is
  // fetched as soon as a node is selected, so switching to it from the Logs tab is instant.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  const [detail] = createResource(
    () =>
      props.node ? { ns: props.node.namespace ?? '', kind: props.node.kind, name: props.node.name, format: format() } : null,
    (key) => fetchResource(key.ns, key.kind, key.name, key.format),
  )

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

          <Show when={isPod()}>
            <nav class="drawer-tabs">
              <button classList={{ active: tab() === 'logs' }} onClick={() => setTab('logs')}>
                Logs
              </button>
              <button classList={{ active: tab() === 'manifest' }} onClick={() => setTab('manifest')}>
                Manifest
              </button>
            </nav>
            {/* Kept mounted (hidden, not unmounted) so the log stream and scrollback survive a
                peek at the manifest tab. */}
            <div class="logs-panel" classList={{ hidden: tab() !== 'logs' }}>
              <LogViewer namespace={node().namespace ?? ''} pod={node().name} />
            </div>
          </Show>

          <section class="manifest-section" classList={{ hidden: isPod() && tab() !== 'manifest' }}>
            <div class="manifest-head">
              <Show when={!isPod()}>
                <span class="manifest-label">Manifest</span>
              </Show>
              <span class="manifest-format">
                <button classList={{ active: format() === 'yaml' }} onClick={() => setFormat('yaml')}>
                  YAML
                </button>
                <button classList={{ active: format() === 'json' }} onClick={() => setFormat('json')}>
                  JSON
                </button>
              </span>
            </div>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              <Show when={detail() != null} fallback={<div class="drawer-loading">unavailable</div>}>
                <pre class="manifest">{detail()}</pre>
              </Show>
            </Suspense>
          </section>
        </aside>
      )}
    </Show>
  )
}
