import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, startTransition, Suspense } from 'solid-js'
import { CLUSTER_SCOPE, fetchEvents, isForbidden } from '../api'
import { ExpandGlyph, kindFromRef, kindIcon } from '../icons'
import { nextRovingIndex } from '../rovingFocus'
import { relativeAge } from '../time'
import { useNow } from '../clock'
import type { KNode, Resources, ResourceUsage } from '../types'
import type { WorkloadUsage } from '../usageAggregate'
import { LOGGABLE_KINDS } from '../loggable'
import LogViewer from './LogViewer'
import ManifestPanel from './ManifestPanel'
import ResourceSummary from './ResourceSummary'
import { isNarrowScreen } from '../screen'

interface Props {
  // ctx names the kubeconfig context whose cache this drawer reads. Threaded through so events
  // and manifest fetches stay scoped to the cluster the operator is currently viewing.
  ctx: string
  node: KNode | null
  owners: KNode[]
  // Live metrics-server consumption for the selected resource (Pods/Nodes), from the capacity feed;
  // threaded to the summary's usage gauges. Undefined when metrics are unavailable or the kind has none.
  usage?: ResourceUsage
  // A workload's usage rolled up from its descendant pods (Deployment/StatefulSet/… have no metrics of
  // their own); threaded to the summary's rolled-up gauge. Undefined for Pods/Nodes and when no replica
  // has a reading yet.
  workloadUsage?: WorkloadUsage
  // A Pod's host-node capacity (the unconstrained-bar fallback ceiling), derived from the cluster-wide
  // capacity feed, threaded to the resource bars.
  hostCapacity?: Resources
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
  // Reports whether a node id owns Pods in the current graph, so a pod-owning CRD (Argo Workflow, a
  // custom workload controller) the kind list can't enumerate still offers the aggregated Logs tab.
  // A predicate (not a boolean) so the check follows displayNode through the drawer's exit animation.
  hasPods?: (nodeId: string) => boolean
  // The inspected resource vanished from the live graph (deleted/replaced mid-investigation). The
  // drawer stays open on its last-known data with an explicit banner instead of silently closing —
  // see App's drawerNode. Tabs keep their normal empty/error states; owner chips remain the path
  // to the replacement.
  deleted?: boolean
  // Drag-to-resize the panel (mirrors the sidebar resizer). App owns the width signal + persistence;
  // the drawer just renders the left-edge handle and reports drags. Omitted by callers that don't
  // wire resizing (and unit tests) — the handle then doesn't render. The handle is suppressed in
  // expanded mode (the panel fills the canvas; there is no edge to drag).
  resizeWidth?: number
  resizeMin?: number
  resizeMax?: number
  onResizeStart?: (e: PointerEvent) => void
  onResizeTo?: (width: number) => void
  onResizeReset?: () => void
}

type Tab = 'logs' | 'events' | 'manifest'
const TAB_LABELS: Record<Tab, string> = { logs: 'Logs', events: 'Events', manifest: 'Manifest' }


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
          // Focus restoration on close: if keyboard focus is inside the drawer when it closes (the
          // operator pressed the close button, or Escape while a drawer control was focused), the
          // panel will unmount and focus would fall to <body> — stranding a keyboard user at the
          // document top (WCAG 2.4.3). Move focus back to the resource search, the keyboard home
          // base. Gated on focus actually being inside the drawer, so a mouse user who clicked the
          // canvas to deselect doesn't get focus yanked into the search. Degrades to a no-op if the
          // search isn't present (cluster-scope/empty states), which is no worse than today.
          // Phone width: focusing the search input would pop the on-screen keyboard the moment the
          // drawer closes — land on the topbar's sidebar toggle instead (visible, no keyboard).
          if (asideEl && asideEl.contains(document.activeElement)) {
            const target = isNarrowScreen()
              ? (document.querySelector('.sidebar-btn') as HTMLElement | null)
              : (document.querySelector('.topology-search input') as HTMLElement | null)
            target?.focus()
          }
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
  // A node is loggable by built-in kind OR because it owns Pods in the graph (Argo Workflow, custom
  // workload CRDs) — the latter asked of the parent, which holds the graph. Keyed on displayNode so the
  // tab set stays correct through the exit animation (props.node clears first).
  const loggable = createMemo(() => {
    const n = displayNode()
    if (!n) return false
    return LOGGABLE_KINDS.has(n.kind) || (props.hasPods?.(n.id) ?? false)
  })
  const tabs = createMemo<Tab[]>(() => (loggable() ? ['logs', 'events', 'manifest'] : ['events', 'manifest']))

  const [tab, setTab] = createSignal<Tab>('logs')

  // Tab element refs, so the tablist's arrow keys can move DOM focus to follow the roving tabindex.
  const tabRefs: Partial<Record<Tab, HTMLButtonElement>> = {}
  // WAI-ARIA tabs keyboard model (scoped to focus inside the tablist, unlike the global [ / ]):
  // ←/→ move to the previous/next tab (wrapping), Home/End jump to the first/last. Activation
  // follows focus (the APG "automatic activation" variant) — cheap here since switching just toggles
  // a hidden class, and it matches the [ / ] shortcut's immediate switch.
  const onTablistKey = (e: KeyboardEvent) => {
    const list = tabs()
    const next = nextRovingIndex(e.key, list.indexOf(tab()), list.length)
    if (next === null) return
    e.preventDefault()
    setTab(list[next])
    tabRefs[list[next]]?.focus()
  }
  // On selection change, keep the current tab if the new resource has it — so triaging the same tab
  // (e.g. Events) across several resources doesn't reset each click — falling back to the kind's
  // default only when the tab isn't available (e.g. Logs → a non-loggable resource).
  // Tab panel scroll container — reset to the top whenever the displayed resource changes so a
  // long previous events list doesn't carry the operator's prior position into a fresh resource
  // (cycle 272). The manifest's matching reset lives in ManifestPanel.
  let eventsPanelEl: HTMLDivElement | undefined
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
      },
    ),
  )

  // A cluster-scoped resource (Node, PriorityClass, ClusterRole…) carries no namespace, but the
  // resource/events/log routes require a non-empty {ns} segment — an empty one collapses to a
  // double slash the server 404s. Map it to the cluster sentinel, which the server unmaps to ""
  // server-side. (A namespaced resource selected in cluster scope still carries its real namespace.)
  // Reference-stable while the resource IDENTITY (ctx/ns/kind/name) is unchanged. This is load-bearing
  // for "the drawer must not flap on background updates": a live data tick re-creates the node OBJECT
  // (the capacity feed rebuilds its Node map every poll; the SSE store reconciles changed resources),
  // so a plain `() => {…}` here returned a NEW key on every tick — re-keying the events/manifest
  // resources, which re-fetch on a new source and (via the manifest's eager segment memo, see
  // ManifestPanel) re-suspend the drawer's OUTER <Suspense>, detaching + re-inserting the DOM and
  // replaying the slide-in ("the sidebar keeps re-opening every few seconds"). These endpoints depend
  // ONLY on the four identity strings, so returning the SAME object while they're unchanged means no
  // spurious re-fetch and no flap — for every resource kind, not just Nodes. A genuine re-selection
  // (different kind/name) or a manifest format toggle still produces a new key and re-fetches.
  const key = createMemo<{ ctx: string; ns: string; kind: string; name: string } | null>((prev) => {
    const n = displayNode()
    if (!n) return null
    const ns = n.namespace || CLUSTER_SCOPE
    if (prev && prev.ctx === props.ctx && prev.ns === ns && prev.kind === n.kind && prev.name === n.name) {
      return prev
    }
    return { ctx: props.ctx, ns, kind: n.kind, name: n.name }
  })

  // Events are fetched as soon as a node is selected, so switching tabs is instant. (The manifest
  // fetch lives in ManifestPanel, keyed the same way.)
  const [events, { refetch: refetchEvents }] = createResource(key, (k) => fetchEvents(k.ctx, k.ns, k.kind, k.name))
  // The loaded events read WITHOUT suspending. The tab badge and warn dot live in the tablist —
  // ABOVE the events panel's <Suspense> — so reading the suspending events() accessor there
  // re-suspends the drawer's OUTER boundary (App wraps the whole drawer in <Suspense>). On every 8s
  // refetch that detaches and re-inserts the drawer's DOM, restarting the slide-in animation: the
  // "drawer keeps re-opening every few seconds" flicker. resource.latest gives the last value
  // without suspending, but only once resolved (it suspends while unresolved, throws while errored),
  // so gate on state and treat the not-yet-loaded / errored window as empty.
  const loadedEvents = createMemo(() => (events.state === 'ready' || events.state === 'refreshing' ? events.latest ?? [] : []))
  const eventCount = () => loadedEvents().length
  const warnings = () => loadedEvents().filter((e) => e.type === 'Warning').length
  // Warnings-only toggle: noisy resources emit many Normal events (Pulled, Created, Started…) that
  // bury the Warning a triage needs. Resets when the drawer switches to a different resource so
  // the filter doesn't silently follow operators into a new context.
  const [warnOnly, setWarnOnly] = createSignal(false)
  createEffect(on(() => displayNode()?.id, () => setWarnOnly(false)))
  // A lazy accessor, NOT createMemo: an eager memo runs at component-init time — OUTSIDE the events
  // panel's <Suspense> — so its suspending events() read would register with the drawer's OUTER
  // boundary (App wraps the drawer in <Suspense>) and re-suspend it on every refetch, detaching and
  // re-inserting the drawer DOM (replaying the slide-in). As a plain function it's first read inside
  // the panel's own Suspense, so the INNER boundary owns the load. Guard events.error first: the
  // resource throws on read when errored.
  const shownEvents = () => {
    if (events.error) return []
    const all = events() ?? []
    return warnOnly() ? all.filter((e) => e.type === 'Warning') : all
  }

  // Events are transient and a failing resource keeps emitting them, so poll while the drawer is
  // open (a no-op when nothing is selected) to keep the tab badge and list current.
  onMount(() => {
    // Refetch inside a transition so a poll keeps the current list on screen (stale-while-revalidate)
    // instead of dropping the events panel back to its "loading…" fallback every 8s.
    const t = setInterval(() => void startTransition(() => refetchEvents()), 8000)
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
          // Name the complementary landmark by the resource it describes, so a screen reader's
          // landmark/rotor list reads "Pod web-0 details" instead of an anonymous "complementary".
          aria-label={`${node().kind} ${node().name} details`}
        >
          {/* Left-edge drag handle — the mirror of the namespace sidebar's resizer. A focusable
              separator (WAI-ARIA window-splitter): ←/→ nudge the width, Home/End jump to the
              min/max, double-click resets. The handle on the LEFT edge grows the panel LEFTWARD, so
              ← widens. Hidden in expanded mode (no edge to drag) and on phone width (CSS). */}
          <Show when={props.onResizeStart && !expanded()}>
            <div
              class="drawer-resizer"
              role="separator"
              tabindex="0"
              aria-orientation="vertical"
              aria-label="Resize the details panel"
              aria-valuemin={props.resizeMin}
              aria-valuemax={props.resizeMax}
              aria-valuenow={props.resizeWidth}
              onPointerDown={props.onResizeStart}
              onDblClick={() => props.onResizeReset?.()}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 32 : 8
                const w = props.resizeWidth ?? 0
                if (e.key === 'ArrowLeft') { e.preventDefault(); props.onResizeTo?.(w + step) }
                else if (e.key === 'ArrowRight') { e.preventDefault(); props.onResizeTo?.(w - step) }
                else if (e.key === 'Home') { e.preventDefault(); props.onResizeTo?.(props.resizeMin ?? w) }
                else if (e.key === 'End') { e.preventDefault(); props.onResizeTo?.(props.resizeMax ?? w) }
              }}
            />
          </Show>
          <Show when={props.deleted}>
            {/* Terminal state, spelled out: the resource is gone but the operator keeps their
                context (name, last-known facts, owner chips to find the replacement). aria-live
                so the transition is announced — visually the banner appears where the eye already
                is, but a screen reader would otherwise never hear the resource died. A sibling of
                the header, NOT a child: in the header's flex row the zero-basis summary "fits" on
                the banner's 100%-width line and collapses to 0px. */}
            <div class="drawer-deleted" role="status" aria-live="polite">
              Deleted from the cluster — showing its last known state{props.owners.length ? '. The owner chip leads to any replacement' : ''}.
            </div>
          </Show>
          <header class="drawer-header">
            <ResourceSummary
              node={node()}
              owners={props.owners}
              usage={props.usage}
              workloadUsage={props.workloadUsage}
              hostCapacity={props.hostCapacity}
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
                  title="Back to previous resource"
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
                  <ExpandGlyph expanded={expanded()} />
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

          {/* Proper WAI-ARIA tabs (not aria-pressed toggle buttons): a screen reader announces
              "tab, selected, 2 of 3" and associates each panel with its tab, and roving tabindex +
              arrow keys give the expected in-widget keyboard model. (The global [ / ] shortcut still
              cycles tabs from anywhere in the drawer; the arrows work once focus is on the tablist.) */}
          <nav class="drawer-tabs" role="tablist" aria-label="Resource details" onKeyDown={onTablistKey}>
            <For each={tabs()}>
              {(t) => (
                <button
                  ref={(el) => (tabRefs[t] = el)}
                  role="tab"
                  id={`drawer-tab-${t}`}
                  aria-controls={`drawer-tabpanel-${t}`}
                  aria-selected={tab() === t}
                  tabindex={tab() === t ? 0 : -1}
                  classList={{ active: tab() === t }}
                  onClick={() => setTab(t)}
                >
                  {TAB_LABELS[t]}
                  <Show when={t === 'events' && !events.error && eventCount() > 0}>
                    <span class="tab-badge" classList={{ warn: warnings() > 0 }}>
                      {eventCount() > 99 ? '99+' : eventCount()}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </nav>

          <Show when={loggable()}>
            {/* Kept mounted (hidden, not unmounted) so the log stream and scrollback survive a
                visit to another tab. */}
            <div
              class="logs-panel"
              classList={{ hidden: tab() !== 'logs' }}
              role="tabpanel"
              id="drawer-tabpanel-logs"
              aria-labelledby="drawer-tab-logs"
            >
              <LogViewer
                ctx={props.ctx}
                namespace={node().namespace ?? ''}
                kind={node().kind}
                name={node().name}
                aggregated={!isPod()}
                containers={node().containers ?? []}
                initContainers={node().initContainers ?? []}
                restarts={node().restarts ?? 0}
                status={node().status}
                neverRan={
                  // A scheduled kind that never fired has nothing to tail until its first run;
                  // lastRun mirrors status.lastScheduleTime, and active>0 means a run is live
                  // even before lastRun lands.
                  (node().kind === 'CronJob' || node().kind === 'CronWorkflow') &&
                  !node().lastRun &&
                  (node().active ?? 0) === 0
                }
                visible={tab() === 'logs'}
                expanded={expanded()}
                onToggleExpand={() => setExpanded((v) => !v)}
              />
            </div>
          </Show>

          <div
            class="events-panel"
            classList={{ hidden: tab() !== 'events' }}
            ref={eventsPanelEl}
            role="tabpanel"
            id="drawer-tabpanel-events"
            aria-labelledby="drawer-tab-events"
          >
            <Suspense fallback={<div class="drawer-loading">loading…</div>}>
              {/* events() throws if the resource errored, so gate on events.error first — both to show
                  a real error (not a misleading "no events") and to avoid reading the errored signal. */}
              {/* A 403 is kd's own policy speaking — "ask your admin", not "kd is broken" — so it
                  must not hide behind the generic load failure (the message an operator reads as
                  a server fault and retries). */}
              <Show
                when={!events.error}
                fallback={
                  <div class="events-empty">
                    {isForbidden(events.error) ? 'Access denied — your kd role can\'t read events here.' : "Couldn't load events."}
                  </div>
                }
              >
                {/* Warnings-only toggle: surfaced only when there's a mix to filter (some warnings AND
                    some normal). Pure "all normal" or "all warnings" hides the chip — no useful action. */}
                <Show when={eventCount() > 0 && warnings() > 0 && warnings() < eventCount()}>
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
                <Show
                  when={shownEvents().length > 0}
                  fallback={
                    <div class="events-empty">
                      {warnOnly() ? 'No warnings.' : 'No recent events.'}
                      {/* "No warnings" means events exist (just none are warnings) — no TTL caveat there.
                          But a bare "No recent events" on an aged-out resource reads as "nothing ever
                          happened", when Kubernetes simply expires events (~1h default). Say so, or the
                          operator suspects a broken feed and stops trusting the tab. */}
                      <Show when={!warnOnly()}>
                        <span class="events-empty-hint">Kubernetes keeps events for about an hour, so older ones expire.</span>
                      </Show>
                    </div>
                  }
                >

                  <ul class="event-list">
                    <For each={shownEvents()}>
                      {(ev) => {
                        const root = `${node().kind}/${node().name}`
                        // Only show the source pill when an aggregated event came from a
                        // descendant — the root's own events are obvious from the drawer header.
                        const showSource = ev.source && ev.source !== root
                        // The icon + short name is identical in the clickable and static branches
                        // below; one fragment, mounted by whichever branch renders. Built only when
                        // there's a source (kindFromRef would choke on an undefined ev.source).
                        const sourceBody = showSource ? (
                          <>
                            <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
                              {kindIcon(kindFromRef(ev.source!))}
                            </svg>
                            {ev.source!.split('/').pop()}
                          </>
                        ) : null
                        return (
                          <li
                            class="event-item"
                            classList={{ warning: ev.type === 'Warning' }}
                            // Alt-click copies the event ("source | Reason: message") — the same
                            // share-one-line idiom as log lines, for pasting a FailedScheduling /
                            // BackOff message into a ticket or search. Same whole-chain optional
                            // chaining: navigator.clipboard is undefined on plain-http origins.
                            title="Alt-click to copy this event"
                            onClick={(e) => {
                              if (!e.altKey) return
                              const el = e.currentTarget as HTMLElement
                              const src = showSource ? `${ev.source} | ` : ''
                              navigator.clipboard
                                ?.writeText(`${src}${ev.reason}: ${ev.message}`)
                                ?.then(() => {
                                  el.classList.add('copied')
                                  setTimeout(() => el.classList.remove('copied'), 700)
                                })
                                ?.catch(() => {})
                            }}
                          >
                            <div class="event-head">
                              <span class="event-reason">{ev.reason}</span>
                              <Show when={ev.count > 1}>
                                <span class="event-count" title={`Happened ${ev.count} times — Kubernetes folds repeats into one event`}>×{ev.count}</span>
                              </Show>
                              <Show when={showSource}>
                                {/* Clickable when the source resource is still in the current
                                    graph: triaging a controller's events leads straight to the
                                    offending descendant. Fall back to a static span when not. */}
                                {props.onNavigateRef ? (
                                  <button
                                    class="event-source"
                                    title={`Go to ${ev.source}`}
                                    // Alt-click belongs to the item's copy gesture — don't also navigate.
                                    onClick={(e) => { if (e.altKey) return; props.onNavigateRef!(ev.source!) }}
                                  >
                                    {sourceBody}
                                  </button>
                                ) : (
                                  <span class="event-source" title={`from ${ev.source}`}>
                                    {sourceBody}
                                  </span>
                                )}
                              </Show>
                              <span class="event-age" title={ev.last}>
                                {relativeAge(ev.last, useNow())}
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

          <ManifestPanel resKey={key()} nodeId={displayNode()?.id} active={tab() === 'manifest'} />
        </aside>
      )}
    </Show>
  )
}
