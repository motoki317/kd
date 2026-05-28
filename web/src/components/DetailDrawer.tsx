import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { fetchEvents, fetchResource, type ManifestFormat } from '../api'
import { kindFromRef, kindIcon } from '../icons'
import { relativeAge } from '../time'
import type { KNode } from '../types'
import CopyButton from './CopyButton'
import LogViewer from './LogViewer'
import ResourceSummary from './ResourceSummary'

interface Props {
  // ctx names the kubeconfig context whose cache this drawer reads. Threaded through so events
  // and manifest fetches stay scoped to the cluster the operator is currently viewing.
  ctx: string
  node: KNode | null
  owners: KNode[]
  onNavigate: (id: string) => void
  // Resolves a "Kind/name" string (e.g. an event's source) to a node id and selects it. Returns
  // whether a match was found, so the UI can avoid presenting a navigable pill when the source
  // isn't in the current graph (filtered out by view, or already gone).
  onNavigateRef?: (kindSlashName: string) => boolean
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
  // On selection change, keep the current tab if the new resource has it — so triaging the same tab
  // (e.g. Events) across several resources doesn't reset each click — falling back to the kind's
  // default only when the tab isn't available (e.g. Logs → a non-loggable resource).
  createEffect(
    on(
      () => props.node?.id,
      () => setTab((cur) => (tabs().includes(cur) ? cur : loggable() ? 'logs' : 'manifest')),
    ),
  )

  const key = () =>
    props.node ? { ctx: props.ctx, ns: props.node.namespace ?? '', kind: props.node.kind, name: props.node.name } : null

  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text. Manifest and events
  // are fetched as soon as a node is selected, so switching tabs is instant.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  const [detail] = createResource(
    () => (props.node ? { ...key()!, format: format() } : null),
    (k) => fetchResource(k.ctx, k.ns, k.kind, k.name, k.format),
  )
  const [events, { refetch: refetchEvents }] = createResource(key, (k) => fetchEvents(k.ctx, k.ns, k.kind, k.name))
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
            <ResourceSummary
              node={node()}
              owners={props.owners}
              onNavigate={props.onNavigate}
              onNavigateRef={props.onNavigateRef}
            />
            <button class="drawer-close" onClick={props.onClose} title="Close">
              ×
            </button>
          </header>

          <nav class="drawer-tabs">
            <For each={tabs()}>
              {(t) => (
                <button classList={{ active: tab() === t }} onClick={() => setTab(t)}>
                  {TAB_LABELS[t]}
                  <Show when={t === 'events' && !events.error && (events()?.length ?? 0) > 0}>
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
                ctx={props.ctx}
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
              {/* events() throws if the resource errored, so gate on events.error first — both to show
                  a real error (not a misleading "no events") and to avoid reading the errored signal. */}
              <Show when={!events.error} fallback={<div class="events-empty">Couldn't load events.</div>}>
                <Show when={(events()?.length ?? 0) > 0} fallback={<div class="events-empty">No recent events.</div>}>
                  <ul class="event-list">
                    <For each={events()}>
                      {(ev) => {
                        const root = `${node().kind}/${node().name}`
                        // Only show the source pill when an aggregated event came from a
                        // descendant — the root's own events are obvious from the drawer header.
                        const showSource = ev.source && ev.source !== root
                        return (
                          <li class="event-item" classList={{ warning: ev.type === 'Warning' }}>
                            <div class="event-head">
                              <span class="event-reason">{ev.reason}</span>
                              <Show when={ev.count > 1}>
                                <span class="event-count">×{ev.count}</span>
                              </Show>
                              <Show when={showSource}>
                                {/* Clickable when the source resource is still in the current
                                    graph: triaging a controller's events leads straight to the
                                    offending descendant. Fall back to a static span when not. */}
                                {props.onNavigateRef ? (
                                  <button
                                    class="event-source"
                                    title={`Go to ${ev.source}`}
                                    onClick={() => props.onNavigateRef!(ev.source!)}
                                  >
                                    <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                                      {kindIcon(kindFromRef(ev.source!))}
                                    </svg>
                                    {ev.source!.split('/').pop()}
                                  </button>
                                ) : (
                                  <span class="event-source" title={`from ${ev.source}`}>
                                    <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                                      {kindIcon(kindFromRef(ev.source!))}
                                    </svg>
                                    {ev.source!.split('/').pop()}
                                  </span>
                                )}
                              </Show>
                              <span class="event-age" title={ev.last}>
                                {relativeAge(ev.last)}
                              </span>
                            </div>
                            <div class="event-message">{ev.message}</div>
                          </li>
                        )
                      }}
                    </For>
                  </ul>
                </Show>
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
              {/* detail() throws if the fetch errored, so check detail.error before reading it. */}
              <Show when={!detail.error && detail() != null} fallback={<div class="drawer-loading">unavailable</div>}>
                <pre class="manifest">{detail()}</pre>
              </Show>
            </Suspense>
          </section>
        </aside>
      )}
    </Show>
  )
}
