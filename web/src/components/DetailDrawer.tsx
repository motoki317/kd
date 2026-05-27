import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { fetchEvents, fetchResource, type ManifestFormat } from '../api'
import { healthColor } from '../health'
import { relativeAge } from '../time'
import type { KNode } from '../types'
import CopyButton from './CopyButton'
import LogViewer from './LogViewer'

interface Props {
  node: KNode | null
  owners: KNode[]
  onNavigate: (id: string) => void
  onClose: () => void
}

type Tab = 'logs' | 'events' | 'manifest'
const TAB_LABELS: Record<Tab, string> = { logs: 'Logs', events: 'Events', manifest: 'Manifest' }

// Kinds with logs worth showing: a Pod, or a controller whose descendant pods' logs we aggregate.
const LOGGABLE = new Set(['Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'])

// DetailDrawer inspects the selected resource across tabs: live Logs (pods and the controllers that
// own them), Events (kubectl-describe's "why is this degraded"), and the Manifest. Logs default for
// loggable kinds — the developer's first question; otherwise the manifest leads.
export default function DetailDrawer(props: Props) {
  const isPod = createMemo(() => props.node?.kind === 'Pod')
  const loggable = createMemo(() => (props.node ? LOGGABLE.has(props.node.kind) : false))
  const tabs = createMemo<Tab[]>(() => (loggable() ? ['logs', 'events', 'manifest'] : ['events', 'manifest']))

  const [tab, setTab] = createSignal<Tab>('logs')
  // Reset to the kind's default tab whenever the selection changes, so a non-loggable resource never
  // lands on a Logs tab it doesn't have.
  createEffect(on(() => props.node?.id, () => setTab(loggable() ? 'logs' : 'manifest')))

  const key = () =>
    props.node ? { ns: props.node.namespace ?? '', kind: props.node.kind, name: props.node.name } : null

  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text. Manifest and events
  // are fetched as soon as a node is selected, so switching tabs is instant.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  const [detail] = createResource(
    () => (props.node ? { ...key()!, format: format() } : null),
    (k) => fetchResource(k.ns, k.kind, k.name, k.format),
  )
  const [events, { refetch: refetchEvents }] = createResource(key, (k) => fetchEvents(k.ns, k.kind, k.name))
  const warnings = () => events()?.filter((e) => e.type === 'Warning').length ?? 0

  // Events are transient and a failing resource keeps emitting them, so poll while the drawer is
  // open (a no-op when nothing is selected) to keep the tab badge and list current.
  onMount(() => {
    const t = setInterval(() => refetchEvents(), 8000)
    onCleanup(() => clearInterval(t))
  })

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
              <div class="drawer-meta">
                <Show when={node().namespace}>
                  <span>{node().namespace}</span>
                </Show>
                <Show when={node().createdAt}>
                  <span class="drawer-age" title={node().createdAt}>
                    {relativeAge(node().createdAt!)} old
                  </span>
                </Show>
                <Show when={(node().restarts ?? 0) > 0}>
                  <span class="drawer-age">↻ {node().restarts} restarts</span>
                </Show>
                <Show when={node().host}>
                  <span class="drawer-age">on {node().host}</span>
                </Show>
              </div>
              <Show when={props.owners.length > 0}>
                <div class="drawer-owners">
                  <For each={props.owners}>
                    {(o) => (
                      <button class="owner-chip" onClick={() => props.onNavigate(o.id)} title={`Go to ${o.kind} ${o.name}`}>
                        ↑ {o.kind} <span class="owner-name">{o.name}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
            <button class="drawer-close" onClick={props.onClose} title="Close">
              ×
            </button>
          </header>

          <nav class="drawer-tabs">
            <For each={tabs()}>
              {(t) => (
                <button classList={{ active: tab() === t }} onClick={() => setTab(t)}>
                  {TAB_LABELS[t]}
                  <Show when={t === 'events' && (events()?.length ?? 0) > 0}>
                    <span class="tab-badge" classList={{ warn: warnings() > 0 }}>
                      {events()!.length}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </nav>

          <Show when={loggable()}>
            {/* Kept mounted (hidden, not unmounted) so the log stream and scrollback survive a
                visit to another tab. */}
            <div class="logs-panel" classList={{ hidden: tab() !== 'logs' }}>
              <LogViewer
                namespace={node().namespace ?? ''}
                kind={node().kind}
                name={node().name}
                aggregated={!isPod()}
                containers={node().containers ?? []}
                restarts={node().restarts ?? 0}
                status={node().status}
              />
            </div>
          </Show>

          <div class="events-panel" classList={{ hidden: tab() !== 'events' }}>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              <Show when={(events()?.length ?? 0) > 0} fallback={<div class="events-empty">No recent events.</div>}>
                <ul class="event-list">
                  <For each={events()}>
                    {(ev) => (
                      <li class="event-item" classList={{ warning: ev.type === 'Warning' }}>
                        <div class="event-head">
                          <span class="event-reason">{ev.reason}</span>
                          <Show when={ev.count > 1}>
                            <span class="event-count">×{ev.count}</span>
                          </Show>
                          <span class="event-age" title={ev.last}>
                            {relativeAge(ev.last)}
                          </span>
                        </div>
                        <div class="event-message">{ev.message}</div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Suspense>
          </div>

          <section class="manifest-section" classList={{ hidden: tab() !== 'manifest' }}>
            <div class="manifest-head">
              <span class="manifest-format">
                <button classList={{ active: format() === 'yaml' }} onClick={() => setFormat('yaml')}>
                  YAML
                </button>
                <button classList={{ active: format() === 'json' }} onClick={() => setFormat('json')}>
                  JSON
                </button>
              </span>
              <CopyButton text={() => detail() ?? ''} title="Copy manifest" />
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
