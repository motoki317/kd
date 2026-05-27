import { createResource, Show, Suspense } from 'solid-js'
import { fetchResource } from '../api'
import { healthColor } from '../health'
import type { KNode } from '../types'
import LogViewer from './LogViewer'

interface Props {
  node: KNode | null
  onClose: () => void
}

// DetailDrawer shows the selected resource's metadata and spec, plus live logs for pods.
export default function DetailDrawer(props: Props) {
  const [detail] = createResource(
    () => (props.node ? { ns: props.node.namespace ?? '', kind: props.node.kind, name: props.node.name } : null),
    (key) => fetchResource(key.ns, key.kind, key.name),
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

          <Show when={node().kind === 'Pod'}>
            <LogViewer namespace={node().namespace ?? ''} pod={node().name} />
          </Show>

          <section class="drawer-section">
            <h3>Manifest</h3>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              <Show when={detail()} fallback={<div class="drawer-loading">unavailable</div>}>
                <pre class="manifest">{JSON.stringify(detail(), null, 2)}</pre>
              </Show>
            </Suspense>
          </section>
        </aside>
      )}
    </Show>
  )
}
