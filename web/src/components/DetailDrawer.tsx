import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { fetchEvents, fetchResource, type ManifestFormat } from '../api'
import { kindFromRef, kindIcon } from '../icons'
import { splitByMatch } from '../logs'
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
  // Navigation history affordance (cycle 300): canBack=true when a prior selection exists; onBack
  // pops one step. Optional so the drawer still works for callers that haven't wired history.
  canBack?: boolean
  onBack?: () => void
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
  // displayNode lingers for the exit-animation duration after props.node clears, so the slide-out
  // has a body to show. A re-selection during the exit cancels the exit and adopts the new node.
  const [displayNode, setDisplayNode] = createSignal<KNode | null>(props.node)
  const [exiting, setExiting] = createSignal(false)
  // Expanded mode (cycle 311): the drawer grows to fill the whole canvas area so logs/manifests get
  // the full width an operator needs to actually read them. Sticky across owner-chip navigation (you
  // stay in "big" mode while walking the tree) but resets when the drawer closes, so a fresh
  // selection opens in the compact side panel again.
  const [expanded, setExpanded] = createSignal(false)
  const EXIT_MS = 220
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  // Set when the drawer opens from a closed state (not when navigating between resources while
  // open), so the tab-default effect below can reset to the kind's default tab on a fresh open —
  // a loggable resource lands on Logs (the most-accessed view) even if the last session ended on
  // Manifest — while still preserving the tab as the operator walks owner chips (cycle 312).
  let openedFresh = false
  createEffect(
    on(
      () => props.node,
      (n, prev) => {
        if (exitTimer) {
          clearTimeout(exitTimer)
          exitTimer = undefined
        }
        if (n) {
          if (!prev) openedFresh = true // was closed → this is a fresh open, not a navigation
          setDisplayNode(n)
          setExiting(false)
        } else if (displayNode()) {
          setExiting(true)
          exitTimer = setTimeout(() => {
            setDisplayNode(null)
            setExiting(false)
            setExpanded(false)
            exitTimer = undefined
          }, EXIT_MS)
        }
      },
    ),
  )
  onCleanup(() => {
    if (exitTimer) clearTimeout(exitTimer)
  })

  const isPod = createMemo(() => displayNode()?.kind === 'Pod')
  const loggable = createMemo(() => (displayNode() ? LOGGABLE.has(displayNode()!.kind) : false))
  const tabs = createMemo<Tab[]>(() => (loggable() ? ['logs', 'events', 'manifest'] : ['events', 'manifest']))

  const [tab, setTab] = createSignal<Tab>('logs')

  // [ / ] cycle the drawer's tabs (cycle 292). Only active while the drawer is visible and the
  // operator isn't typing into a field. Lets keyboard users flip between Logs/Events/Manifest
  // without reaching for the mouse — common during triage ("does the log say anything? what
  // events fired? show me the manifest").
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== '[' && e.key !== ']') return
      if (!displayNode()) return
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
      const list = tabs()
      const cur = list.indexOf(tab())
      if (cur < 0) return
      const dir = e.key === ']' ? 1 : -1
      e.preventDefault()
      setTab(list[(cur + dir + list.length) % list.length])
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })
  // On selection change, keep the current tab if the new resource has it — so triaging the same tab
  // (e.g. Events) across several resources doesn't reset each click — falling back to the kind's
  // default only when the tab isn't available (e.g. Logs → a non-loggable resource).
  // Tab panel scroll containers — reset to the top whenever the displayed resource changes so a
  // long previous events list or scrolled-down manifest doesn't carry the operator's prior
  // position into a fresh resource (cycle 272).
  let eventsPanelEl: HTMLDivElement | undefined
  let manifestSectionEl: HTMLElement | undefined
  createEffect(
    on(
      () => displayNode()?.id,
      (id) => {
        // Nothing shown — don't default the tab, or the effect (which also runs on creation while
        // the drawer is empty) would latch a loggable resource onto Manifest before it even opens.
        if (!id) return
        // Fresh open → the kind's default (Logs for loggable, else Manifest). Navigating between
        // resources keeps the current tab when the new resource supports it, falling back to the
        // default only when it doesn't (e.g. Logs → a ConfigMap that has no Logs tab).
        if (openedFresh) {
          setTab(loggable() ? 'logs' : 'manifest')
          openedFresh = false
        } else {
          setTab((cur) => (tabs().includes(cur) ? cur : loggable() ? 'logs' : 'manifest'))
        }
        if (eventsPanelEl) eventsPanelEl.scrollTop = 0
        const mp = manifestSectionEl?.querySelector('.manifest') as HTMLElement | null
        if (mp) mp.scrollTop = 0
      },
    ),
  )

  const key = () =>
    displayNode() ? { ctx: props.ctx, ns: displayNode()!.namespace ?? '', kind: displayNode()!.kind, name: displayNode()!.name } : null

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
  // Warnings-only toggle: noisy resources emit many Normal events (Pulled, Created, Started…) that
  // bury the Warning a triage needs. Resets when the drawer switches to a different resource so
  // the filter doesn't silently follow operators into a new context.
  const [warnOnly, setWarnOnly] = createSignal(false)
  createEffect(on(() => displayNode()?.id, () => setWarnOnly(false)))
  // Within-manifest search: long YAMLs hide an env var or a strategy buried 80 lines down. Resets
  // on selection change so the query doesn't follow into a new resource's manifest. The memo guards
  // detail.error the same way shownEvents does — the resource throws on read when errored.
  const [manifestQuery, setManifestQuery] = createSignal('')
  // 0-based index of the "current" highlighted match within the manifest. Pressing Enter in the
  // find field scrolls to the next match and bumps this index; the matching <mark> gets a stronger
  // styling so the operator can tell "this is where you are" vs the other matches.
  const [manifestMatchIdx, setManifestMatchIdx] = createSignal(0)
  createEffect(on(() => displayNode()?.id, () => {
    setManifestQuery('')
    setManifestMatchIdx(0)
  }))
  // Query change resets the match cursor — a new query has a new "first match".
  createEffect(on(manifestQuery, () => setManifestMatchIdx(0)))
  const manifestSegments = createMemo(() => {
    if (detail.error) return []
    return splitByMatch(detail() ?? '', manifestQuery())
  })
  const manifestMatchCount = createMemo(() => (manifestQuery() ? manifestSegments().filter((s) => s.match).length : 0))
  let manifestPre: HTMLPreElement | undefined
  function scrollManifestMatch(idx: number) {
    if (!manifestPre) return
    const marks = manifestPre.querySelectorAll<HTMLElement>('mark.manifest-match')
    const target = marks[idx]
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function stepMatch(dir: 1 | -1) {
    const total = manifestMatchCount()
    if (total === 0) return
    const next = (manifestMatchIdx() + dir + total) % total
    setManifestMatchIdx(next)
    queueMicrotask(() => scrollManifestMatch(next))
  }

  const shownEvents = createMemo(() => {
    // The resource throws when errored; reading events() then surfaces an uncaught rejection. The
    // outer Show gates the JSX, but the memo also runs reactively so we must short-circuit here.
    if (events.error) return []
    const all = events() ?? []
    return warnOnly() ? all.filter((e) => e.type === 'Warning') : all
  })

  // Events are transient and a failing resource keeps emitting them, so poll while the drawer is
  // open (a no-op when nothing is selected) to keep the tab badge and list current.
  onMount(() => {
    const t = setInterval(() => refetchEvents(), 8000)
    onCleanup(() => clearInterval(t))
  })

  // Focus trap (cycle 326): expanded mode covers the topology, but the canvas controls (search, kind
  // chips, Fit) stay in the DOM and tabbable — Shift+Tab from the drawer's first control would land
  // on a button hidden behind the panel. While expanded, wrap Tab at the drawer's focusable
  // boundaries so keyboard focus can't escape to the obscured canvas. offsetParent filtering drops
  // controls in inactive (display:none) tab panels; the handler no-ops in compact mode.
  let asideEl: HTMLElement | undefined
  const onDrawerKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !expanded() || !asideEl) return
    const focusable = [
      ...asideEl.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <Show when={displayNode()}>
      {(node) => (
        <aside
          ref={asideEl}
          class="drawer"
          classList={{ exiting: exiting(), expanded: expanded() }}
          onKeyDown={onDrawerKeyDown}
        >
          <header class="drawer-header">
            <ResourceSummary
              node={node()}
              owners={props.owners}
              onNavigate={props.onNavigate}
              onNavigateRef={props.onNavigateRef}
            />
            {/* Header action cluster: back (when history exists, cycle 300), share (copies the
                deep-link URL) and close. Grouped in a flex row so space-between in the header
                doesn't push them apart. Share lets the operator paste a link to this resource
                into a chat / PR instead of explaining "the noisy pod in prod ns". URL already
                carries ?sel=Kind/name. */}
            <div class="drawer-actions">
              <Show when={props.canBack && props.onBack}>
                <button
                  class="drawer-back"
                  type="button"
                  title="Back to previous resource (Alt+←)"
                  aria-label="Back to previous resource"
                  onClick={() => props.onBack!()}
                >
                  <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
                    <path d="M 9 2 L 4 7 L 9 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </Show>
              {/* Expand/restore: grow the drawer to fill the canvas for comfortable log/manifest
                  reading, then shrink it back to the side panel. The 4-corner glyph points outward
                  to "maximize" and inward to "restore" — a familiar window-control idiom. */}
              <button
                class="drawer-expand"
                type="button"
                title={expanded() ? 'Restore panel size' : 'Expand to fill the canvas'}
                aria-label={expanded() ? 'Restore panel size' : 'Expand to fill the canvas'}
                aria-pressed={expanded()}
                onClick={() => setExpanded((v) => !v)}
              >
                <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
                  <Show
                    when={expanded()}
                    fallback={
                      <path
                        d="M2 5 L2 2 L5 2 M9 2 L12 2 L12 5 M12 9 L12 12 L9 12 M5 12 L2 12 L2 9"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    }
                  >
                    <path
                      d="M5 2 L5 5 L2 5 M9 2 L9 5 L12 5 M12 9 L9 9 L9 12 M2 9 L5 9 L5 12"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </Show>
                </svg>
              </button>
              <button
                class="drawer-share"
                title="Copy share link"
                aria-label="Copy share link to this resource"
                onClick={async (e) => {
                  // Capture the element BEFORE await — `currentTarget` is nulled out as soon as the
                  // synchronous event handler returns (standard DOM), so the post-await read would
                  // throw on .classList. Same pattern label-chip uses (cycle 254).
                  const el = e.currentTarget as HTMLButtonElement
                  try {
                    await navigator.clipboard.writeText(window.location.href)
                    el.classList.add('copied')
                    setTimeout(() => el.classList.remove('copied'), 1100)
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
                  {/* Two linked rings — universal "share" / "link" affordance. */}
                  <path d="M 5 7 Q 5 4 8 4 H 10 Q 13 4 13 7 Q 13 10 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                  <path d="M 9 7 Q 9 10 6 10 H 4 Q 1 10 1 7 Q 1 4 4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                </svg>
              </button>
              <button class="drawer-close" onClick={props.onClose} title="Close" aria-label="Close details">
                ×
              </button>
            </div>
          </header>

          <nav class="drawer-tabs">
            <For each={tabs()}>
              {(t) => (
                <button
                  classList={{ active: tab() === t }}
                  aria-pressed={tab() === t}
                  onClick={() => setTab(t)}
                >
                  {TAB_LABELS[t]}
                  <Show when={t === 'events' && !events.error && (events()?.length ?? 0) > 0}>
                    <span class="tab-badge" classList={{ warn: warnings() > 0 }}>
                      {events()!.length > 99 ? '99+' : events()!.length}
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
                visible={tab() === 'logs'}
              />
            </div>
          </Show>

          <div class="events-panel" classList={{ hidden: tab() !== 'events' }} ref={eventsPanelEl}>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              {/* events() throws if the resource errored, so gate on events.error first — both to show
                  a real error (not a misleading "no events") and to avoid reading the errored signal. */}
              <Show when={!events.error} fallback={<div class="events-empty">Couldn't load events.</div>}>
                {/* Warnings-only toggle: surfaced only when there's a mix to filter (some warnings AND
                    some normal). Pure "all normal" or "all warnings" hides the chip — no useful action. */}
                <Show when={(events()?.length ?? 0) > 0 && warnings() > 0 && warnings() < (events()?.length ?? 0)}>
                  <div class="events-filter">
                    <button
                      class="events-filter-chip"
                      classList={{ active: warnOnly() }}
                      aria-pressed={warnOnly()}
                      onClick={() => setWarnOnly((v) => !v)}
                      title={warnOnly() ? 'Show all events' : 'Show only Warning events'}
                    >
                      Warnings only
                      <span class="events-filter-count">{warnings()}</span>
                    </button>
                  </div>
                </Show>
                <Show when={shownEvents().length > 0} fallback={<div class="events-empty">{warnOnly() ? 'No warnings.' : 'No recent events.'}</div>}>
                  <ul class="event-list">
                    <For each={shownEvents()}>
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

          <section class="manifest-section" classList={{ hidden: tab() !== 'manifest' }} ref={manifestSectionEl}>
            <div class="manifest-head">
              <span class="manifest-format">
                <button classList={{ active: format() === 'yaml' }} onClick={() => setFormat('yaml')}>
                  YAML
                </button>
                <button classList={{ active: format() === 'json' }} onClick={() => setFormat('json')}>
                  JSON
                </button>
              </span>
              {/* Within-manifest find: case-insensitive substring highlight. Enter steps through
                  the matches (scrolling each into view), Esc clears without leaving the drawer. */}
              <input
                class="manifest-find"
                placeholder="find in manifest…  (Enter ↓ · Shift+Enter ↑)"
                aria-label="Find in manifest"
                value={manifestQuery()}
                onInput={(e) => setManifestQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // Two-stage Esc: clear first, then blur (matches the other find/search fields,
                    // cycle 268). Keeps the global Esc handler from running until both are done.
                    if (manifestQuery()) setManifestQuery('')
                    else (e.currentTarget as HTMLInputElement).blur()
                  }
                  else if (e.key === 'Enter') {
                    e.preventDefault()
                    stepMatch(e.shiftKey ? -1 : 1)
                  }
                }}
              />
              <Show when={manifestQuery()}>
                <span class="manifest-find-count" classList={{ none: manifestMatchCount() === 0 }}>
                  {manifestMatchCount() === 0
                    ? 'no matches'
                    : `${manifestMatchIdx() + 1}/${manifestMatchCount()}`}
                </span>
              </Show>
              <CopyButton text={() => detail() ?? ''} title="Copy manifest" />
            </div>
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              {/* detail() throws if the fetch errored, so check detail.error before reading it. */}
              <Show when={!detail.error && detail() != null} fallback={<div class="drawer-loading">unavailable</div>}>
                <pre class="manifest" ref={manifestPre} tabindex="0">
                  <Show when={manifestQuery()} fallback={detail()}>
                    {(() => {
                      // Per-segment render: each match gets a sequential index so the "current"
                      // mark can be styled differently from the others. Counter lives outside the
                      // For loop because Solid doesn't expose the running match index naturally.
                      let mi = -1
                      return (
                        <For each={manifestSegments()}>
                          {(p) => {
                            if (!p.match) return <>{p.text}</>
                            mi++
                            const idx = mi
                            return (
                              <mark
                                class="manifest-match"
                                classList={{ current: idx === manifestMatchIdx() }}
                              >
                                {p.text}
                              </mark>
                            )
                          }}
                        </For>
                      )
                    })()}
                  </Show>
                </pre>
              </Show>
            </Suspense>
          </section>
        </aside>
      )}
    </Show>
  )
}
