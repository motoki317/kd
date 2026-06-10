import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { CLUSTER_SCOPE, fetchEvents, fetchResource, isForbidden, type ManifestFormat } from '../api'
import { kindFromRef, kindIcon } from '../icons'
import { nextRovingIndex } from '../rovingFocus'
import { splitByMatch } from '../logs'
import { relativeAge } from '../time'
import { useNow } from '../clock'
import type { KNode, Resources, ResourceUsage } from '../types'
import type { WorkloadUsage } from '../usageAggregate'
import { LOGGABLE_KINDS } from '../loggable'
import CopyButton from './CopyButton'
import LogViewer from './LogViewer'
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
  // Maximize the active tab section (cycle: operators reading long logs): collapse the verbose resource
  // summary down to just its hero (kind · name · status) so the Logs/Events/Manifest panel takes the
  // drawer's full height. Independent of `expanded` (width) — the two compose for the biggest reading
  // area. Sticky across owner-chip navigation, reset on close like `expanded`.
  const [summaryCollapsed, setSummaryCollapsed] = createSignal(false)
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
            setSummaryCollapsed(false)
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

  // A cluster-scoped resource (Node, PriorityClass, ClusterRole…) carries no namespace, but the
  // resource/events/log routes require a non-empty {ns} segment — an empty one collapses to a
  // double slash the server 404s. Map it to the cluster sentinel, which the server unmaps to ""
  // server-side. (A namespaced resource selected in cluster scope still carries its real namespace.)
  const key = () =>
    displayNode()
      ? { ctx: props.ctx, ns: displayNode()!.namespace || CLUSTER_SCOPE, kind: displayNode()!.kind, name: displayNode()!.name }
      : null

  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text. Manifest and events
  // are fetched as soon as a node is selected, so switching tabs is instant.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  // Refs so the format radiogroup's arrow keys can move DOM focus to follow the roving tabindex.
  const formatRefs: Partial<Record<ManifestFormat, HTMLButtonElement>> = {}
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
  // On a query change, reset to the first match AND scroll it into view — so typing reveals the first
  // hit immediately, the way the browser's own find does. Without the scroll the count read "1/3"
  // while the manifest stayed pinned at the top with the hit below the fold, and the first Enter then
  // appeared to skip straight to "2/3". Deferred a microtask so the freshly-rendered <mark>s exist
  // before we scroll. Placed below scrollManifestMatch/manifestMatchCount so the eager `on` (defer:
  // false) doesn't reference them in the temporal dead zone.
  createEffect(on(manifestQuery, () => {
    setManifestMatchIdx(0)
    if (manifestQuery() && manifestMatchCount() > 0) queueMicrotask(() => scrollManifestMatch(0))
  }))

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
          classList={{ exiting: exiting(), expanded: expanded(), 'summary-collapsed': summaryCollapsed() && tab() === 'logs' }}
          onKeyDown={onDrawerKeyDown}
          // Name the complementary landmark by the resource it describes, so a screen reader's
          // landmark/rotor list reads "Pod web-0 details" instead of an anonymous "complementary".
          aria-label={`${node().kind} ${node().name} details`}
        >
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
                visible={tab() === 'logs'}
                maximized={summaryCollapsed()}
                onToggleMaximize={() => setSummaryCollapsed((v) => !v)}
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
                                    // Alt-click belongs to the item's copy gesture — don't also navigate.
                                    onClick={(e) => { if (e.altKey) return; props.onNavigateRef!(ev.source!) }}
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

          <section
            class="manifest-section"
            classList={{ hidden: tab() !== 'manifest' }}
            ref={manifestSectionEl}
            role="tabpanel"
            id="drawer-tabpanel-manifest"
            aria-labelledby="drawer-tab-manifest"
          >
            <div class="manifest-head">
              {/* Single-select (YAML vs JSON) → a radiogroup, matching the toolbar's Group/Resource
                  segmented controls: a screen reader hears "radio group, YAML selected, 1 of 2" and
                  ←/→ move between formats. Plain toggle buttons left the active format unannounced. */}
              <span
                class="manifest-format"
                role="radiogroup"
                aria-label="Manifest format"
                onKeyDown={(e) => {
                  const ids: ManifestFormat[] = ['yaml', 'json']
                  const i = nextRovingIndex(e.key, ids.indexOf(format()), ids.length)
                  if (i === null) return
                  e.preventDefault()
                  setFormat(ids[i])
                  formatRefs[ids[i]]?.focus()
                }}
              >
                <For each={['yaml', 'json'] as const}>
                  {(f) => (
                    <button
                      ref={(el) => (formatRefs[f] = el)}
                      role="radio"
                      aria-checked={format() === f}
                      tabindex={format() === f ? 0 : -1}
                      classList={{ active: format() === f }}
                      onClick={() => setFormat(f)}
                    >
                      {f.toUpperCase()}
                    </button>
                  )}
                </For>
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
              {/* detail() throws if the fetch errored, so check detail.error before reading it.
                  Same 403 split as the events tab: a policy denial names itself. */}
              <Show
                when={!detail.error && detail() != null}
                fallback={
                  <div class="drawer-loading">
                    {isForbidden(detail.error) ? 'Access denied — your kd role can\'t read this manifest.' : 'unavailable'}
                  </div>
                }
              >
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
