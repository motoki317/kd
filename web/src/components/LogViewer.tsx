import { createMemo, createSignal, onCleanup, createEffect, For, on, Show } from 'solid-js'
import { streamLogs, type LogEntry } from '../api'
import { ansiStyleToCss, hasAnsi, parseAnsi } from '../ansi'
import { readRawPref, writePref } from '../prefs'
import { defaultLogContainer, filterLogLines, formatLogTime, parseJsonLog, parseLogfmtLog, parseLogLevel, splitByMatch, type LogLevel } from '../logs'
import { middleTruncate } from '../names'
import CopyButton from './CopyButton'

interface Props {
  // ctx names the kubeconfig context whose API server backs this stream.
  ctx: string
  namespace: string
  kind: string
  name: string
  // aggregated logs span several descendant pods, so each line is labelled with its source pod.
  aggregated: boolean
  // app container names for a single pod; the picker appears when there's >1 container to choose
  // across both groups (app + init).
  containers: string[]
  // init container names — selectable in the picker too, so a failed init container's logs (why a pod
  // is stuck in Init) are reachable, not just the app containers'.
  initContainers?: string[]
  // restart total for a single pod; >0 offers the "previous" (crashed container) logs.
  restarts: number
  // single pod's status, to tell "container not started yet" from a real stream drop.
  status?: string
  // A scheduled resource (CronJob/CronWorkflow) that has never fired: there are no logs to wait
  // for until its first run, so the empty state says that instead of "waiting…" forever.
  neverRan?: boolean
  // True while the parent panel is on-screen. The viewer stays mounted across tab switches so the
  // stream survives; flipping this back to true asks the viewer to snap to the tail (so coming
  // back to Logs from Manifest lands on the newest line, not a stale scroll position).
  visible?: boolean
  // Whether the drawer summary is folded away so this panel takes the full drawer height. The control
  // lives here (not in the drawer header) because it reads as a property of the logs panel it enlarges
  // — proximity over a far-corner action cluster. Absent ⇒ no maximize control (e.g. embedded use).
  maximized?: boolean
  onToggleMaximize?: () => void
}

// LogViewer tails a resource's logs over SSE, auto-scrolling to the newest line. For workloads the
// server merges all descendant pods into one stream; the pod label disambiguates the lines.
export default function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<LogEntry[]>([])
  const [error, setError] = createSignal(false)
  // The one-shot `previous` dump signals `done` when it has finished; a finished dump with no lines
  // means the crashed container wrote nothing, so the empty state must read "no previous logs", not an
  // indefinite "waiting…". The live follow stream never completes, so this stays false there.
  const [completed, setCompleted] = createSignal(false)
  // The tailed resource was deleted server-side: the follow stream will produce nothing more, so
  // "waiting for log output…" would be a lie. Cleared if a same-name re-create resumes the stream.
  const [gone, setGone] = createSignal(false)
  // A terminally-finished run (Succeeded Workflow, Complete Job, Succeeded/Failed Pod) whose stream
  // stays empty will stay empty forever — its pods either printed nothing or were already cleaned up
  // (Argo GC, TTL). "waiting for log output…" would have the operator waiting on logs that can never
  // arrive (cost a confused round live on a day-old Succeeded Workflow). Exact statuses only: an
  // evicted pod's status carries kubelet's free-text message, which a substring match could trip on.
  const finishedRun = () => ['Succeeded', 'Failed', 'Complete', 'Error'].includes(props.status ?? '')
  // Follow the tail only while the viewport is at the bottom; once the user scrolls up to read
  // history, new lines stop yanking them down (a "Latest" button jumps back).
  const [pinned, setPinned] = createSignal(true)
  // Count of new lines arrived while the operator was scrolled up — surfaced in the "Latest"
  // button so they know how much they're missing without scrolling to check.
  const [unseenLines, setUnseenLines] = createSignal(0)
  // Selected container for a single multi-container pod. Defaults to ALL_CONTAINERS (merged across
  // every container) when the pod has more than one — a single container hides the cross-talk that
  // explains most multi-container failures (an app erroring because its sidecar/proxy isn't up yet).
  const initialContainer = () =>
    !props.aggregated && props.containers.length > 1 ? ALL_CONTAINERS : defaultLogContainer(props.containers)
  const [container, setContainer] = createSignal(initialContainer())
  // The merged all-container view (single pod) — labels each line by container and timestamp-orders
  // them, since the per-container tail dumps otherwise arrive grouped, not interleaved.
  const combined = createMemo(() => container() === ALL_CONTAINERS)
  // A "grouped" stream carries per-line source labels: by pod for an aggregated workload, by container
  // for a single pod's merged view. groupKey picks the right source for filtering/coloring/labeling.
  const grouped = createMemo(() => props.aggregated || combined())
  const groupKey = (l: LogEntry) => (combined() ? l.container ?? '' : l.pod)
  const groupNoun = () => (combined() ? 'container' : 'pod')
  // Show the previous (crashed) container's logs — where a CrashLoopBackOff reason lives.
  const [previous, setPrevious] = createSignal(false)
  // Client-side line filter ("grep"): hide lines not containing this substring.
  const [filter, setFilter] = createSignal('')
  // Case-sensitive matching for the filter (off by default — most triage is case-insensitive, but
  // an exact match disambiguates e.g. "ERROR" the level from "error" in prose). (cycle 321)
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  // Ask the server to prepend each line's emission time (kubectl --timestamps), rendered dimmed.
  const [timestamps, setTimestamps] = createSignal(false)
  // Combined mode interleaves several containers' streams BY TIME, so the timestamp is what makes the
  // resulting order legible — without it the merge reads as an arbitrarily shuffled blob (dogfooded on a
  // 3-container pod: init/wait/main lines jumbled with no anchor explaining the order). So default the
  // column ON when entering combined mode, honestly reflected in the toggle and still overridable — the
  // user asked for "combined log of all containers sorted by timestamps", and the sort is invisible
  // without the stamps. Only fires on the transition INTO combined, so a deliberate toggle-off sticks.
  createEffect(on(combined, (c) => { if (c) setTimestamps(true) }))
  // Soft-wrap long lines (default) vs. single-line-per-entry with horizontal scroll. Operators reading
  // structured/columnar logs (or stack traces) often want no-wrap so column alignment survives and one
  // 4 KB line can't push everything else off-screen. Persisted (a display habit, unlike the per-pod
  // filter) so it sticks across selections and reloads, matching the sidebar-collapsed preference.
  const [wrap, setWrap] = createSignal(readRawPref('kd:logsWrap') !== '0')
  const toggleWrap = () =>
    setWrap((w) => {
      writePref('kd:logsWrap', w ? '0' : '1')
      return !w
    })
  // Per-level filtering (cycle 328): the set of levels to HIDE. The badge classifier (parseLogLevel)
  // already labels each line; this reuses it as a filter so an operator can drop INFO/DEBUG noise and
  // scan errors without crafting a regex. Persisted like wrap — a content-agnostic triage habit that
  // should outlive a single pod selection — and kept visible as dimmed chips so the state never hides.
  const [hiddenLevels, setHiddenLevels] = createSignal<Set<LogLevel>>(
    new Set((readRawPref('kd:logsHideLevels') || '').split(',').filter(Boolean) as LogLevel[]),
  )
  const toggleLevel = (lvl: LogLevel) =>
    setHiddenLevels((prev) => {
      const next = new Set(prev)
      next.has(lvl) ? next.delete(lvl) : next.add(lvl)
      writePref('kd:logsHideLevels', [...next].join(','))
      return next
    })
  // Per-source filtering for grouped streams (cycle 328/R2, generalized): an aggregated workload
  // interleaves lines from every descendant pod, and a single pod's merged view interleaves every
  // container — so isolating one noisy source meant typing its name into the filter. hiddenGroups is
  // the set of source keys (pod, or container in combined mode) to suppress. NOT persisted — names are
  // specific to the current rollout/pod and churn, so it resets when the resource changes (see the
  // on(props.name) effect).
  const [hiddenGroups, setHiddenGroups] = createSignal<Set<string>>(new Set<string>())
  // Sources seen in the current buffer, sorted for a stable chip order. Only computed for a grouped
  // stream; an ungrouped single-container view has nothing to toggle.
  const presentGroups = createMemo(() => {
    if (!grouped()) return [] as string[]
    const seen = new Set<string>()
    for (const l of lines()) {
      const g = groupKey(l)
      if (g) seen.add(g)
    }
    return [...seen].sort()
  })
  const toggleGroup = (key: string) =>
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  // Shift-click solos a source (show only it); shift-clicking the already-soloed one clears the filter.
  // Mirrors the topology kind-chip solo so the gesture is consistent across the app.
  const soloGroup = (key: string) =>
    setHiddenGroups((prev) => {
      const others = presentGroups().filter((p) => p !== key)
      const alreadySolo = prev.size === others.length && others.every((p) => prev.has(p))
      return alreadySolo ? new Set<string>() : new Set(others)
    })
  const visibleLines = createMemo(() => {
    const hg = hiddenGroups()
    let base = hg.size ? lines().filter((l) => !hg.has(groupKey(l))) : lines()
    // The merged all-container view forces server-side timestamps (see the stream effect), so order by
    // emission time to interleave the per-container tail dumps that otherwise arrive container-grouped.
    // RFC3339Nano sorts correctly as a string; a copy keeps the source buffer in arrival order.
    if (combined()) base = [...base].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
    return filterLogLines(base, filter(), caseSensitive(), hiddenLevels())
  })
  // Any filter is active — text grep, a dimmed level chip, or a hidden source. Drives the "shown/total"
  // count and the copy-button's "filtered" wording: all kinds subset the buffer identically, so the
  // operator deserves the same "you're seeing X of Y" feedback for each.
  const filtering = createMemo(() => !!filter() || hiddenLevels().size > 0 || hiddenGroups().size > 0)
  // Reset every log filter at once — the recovery action when the active filters (often a level filter
  // PERSISTED from a previous pod via kd:logsHideLevels) have hidden the entire buffer, so a new pod's
  // output reads as empty. Clears the persisted level pref too; hidden-pods is per-resource so it just
  // resets in memory. Mirrors the topology empty-state's "clear all filters" affordance (Repetition).
  const clearLogFilters = () => {
    setFilter('')
    setCaseSensitive(false)
    setHiddenLevels(new Set<LogLevel>())
    writePref('kd:logsHideLevels', '')
    setHiddenGroups(new Set<string>())
  }
  let pre: HTMLPreElement | undefined
  let filterInput: HTMLInputElement | undefined

  // Jump-to-error (cycle 332/R6): error-level lines are the triage target, but finding the first one
  // in a 2000-line buffer of INFO chatter means scrolling forever. errorIndices are the positions of
  // error lines in the visible set; the button/Shift+E steps through them, wrapping. The badge
  // classifier already runs per visible line for the inline badge, so this is reusing that signal.
  const errorIndices = createMemo(() => {
    const vl = visibleLines()
    const out: number[] = []
    for (let i = 0; i < vl.length; i++) if (parseLogLevel(vl[i].line) === 'error') out.push(i)
    return out
  })
  const [errorCursor, setErrorCursor] = createSignal(-1)
  function jumpToNextError() {
    const errs = errorIndices()
    if (errs.length === 0 || !pre) return
    const next = (errorCursor() + 1) % errs.length
    setErrorCursor(next)
    const el = pre.querySelectorAll('.log-line')[errs[next]] as HTMLElement | undefined
    if (!el) return
    setPinned(false) // stop following the tail or the jump-up is yanked straight back to the bottom
    el.scrollIntoView({ block: 'center' })
    el.classList.remove('log-line-flash')
    void el.offsetWidth // restart the flash if we land on the same line twice
    el.classList.add('log-line-flash')
    el.addEventListener('animationend', () => el.classList.remove('log-line-flash'), { once: true })
  }

  // A single pod that isn't Running can't produce logs yet, so an error there is "no logs" not a drop.
  const gentle = createMemo(() => !props.aggregated && !(props.status ?? '').startsWith('Running'))
  // Direct scrollTop assignment instead of scrollTo({ ... }) — jsdom doesn't implement scrollTo
  // on HTMLElement (the test env throws), and there's no behaviorial difference here.
  const toBottom = () => {
    if (pre) pre.scrollTop = pre.scrollHeight
  }
  // Programmatic scrolls (toBottom) fire onScroll, so guard against treating our own scroll as a
  // user gesture that would unpin the tail. Cleared once the resulting scroll event has been
  // observed (or the next frame, whichever comes first).
  let autoScrolling = false
  // Coalesce many incoming lines into one tail-snap per frame: rAF runs after Solid's DOM updates,
  // so the scrollHeight we read reflects the final batch — no need for per-line microtasks that
  // can race the renderer.
  let scrollPending = false
  function scheduleTail() {
    if (!pinned() || scrollPending) return
    scrollPending = true
    requestAnimationFrame(() => {
      scrollPending = false
      if (!pinned() || !pre) return
      autoScrolling = true
      toBottom()
      requestAnimationFrame(() => {
        autoScrolling = false
      })
    })
  }
  const onScroll = () => {
    if (autoScrolling || !pre) return
    const nowPinned = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
    setPinned(nowPinned)
    if (nowPinned) setUnseenLines(0) // back at tail → clear the backlog badge
  }

  // Reset container + previous toggle whenever the target pod changes.
  createEffect(
    on(
      () => props.name,
      () => {
        setContainer(initialContainer())
        setPrevious(false)
        setFilter('')
        setCaseSensitive(false)
        setHiddenGroups(new Set<string>())
        setErrorCursor(-1)
      },
    ),
  )

  createEffect(() => {
    // Re-subscribe whenever the target context, resource, container, or previous toggle changes.
    const ctx = props.ctx
    const ns = props.namespace
    const kind = props.kind
    const name = props.name
    const c = container()
    const prev = previous()
    // The merged all-container view needs per-line timestamps to interleave the containers' tail dumps,
    // so fetch them even when the operator hasn't toggled the (visible) timestamp column — the column's
    // display stays gated on timestamps(), the ordering uses the time field regardless.
    const ts = timestamps() || combined()
    setLines([])
    setError(false)
    setCompleted(false)
    setGone(false)
    setPinned(true)
    setUnseenLines(0)
    const close = streamLogs(
      ctx,
      ns,
      kind,
      name,
      { tailLines: 200, container: c || undefined, previous: prev, timestamps: ts },
      (entry) => {
        setError(false) // a line arriving means the stream recovered
        setGone(false) // a same-name re-create resumed streaming — the notice is stale
        setLines((prev) => (prev.length > 2000 ? [...prev.slice(-2000), entry] : [...prev, entry]))
        // While scrolled up, count incoming lines so the Latest button can advertise the backlog.
        if (!pinned()) setUnseenLines((n) => Math.min(n + 1, 999))
        scheduleTail()
      },
      () => setError(true),
      () => setCompleted(true),
      () => setGone(true),
    )
    onCleanup(close)
  })

  // Coming back to the Logs tab after viewing Manifest/Events should land on the newest line —
  // even if the user had previously scrolled up, opening the tab is a "show me what's happening
  // now" signal. Re-pin and snap on each visibility transition into true.
  createEffect(
    on(
      () => props.visible !== false,
      (visible) => {
        if (visible) {
          setPinned(true)
          requestAnimationFrame(() => {
            if (pre) {
              autoScrolling = true
              toBottom()
              requestAnimationFrame(() => {
                autoScrolling = false
              })
            }
          })
        }
      },
    ),
  )

  return (
    <div class="logs">
      <div class="logs-header">
        {/* No "Logs" caption: the active tab directly above already names the panel — the header
            spends its one row on controls. */}
        {/* Picker appears when there's more than one container to choose across BOTH groups, so a
            single-app-container pod with an init container now also gets it. When init containers
            exist the two groups are split into labelled optgroups (init runs first) so the operator
            can tell which is which; with none, the flat list keeps the common case unchanged. */}
        <Show when={!props.aggregated && props.containers.length + (props.initContainers?.length ?? 0) > 1}>
          <select class="logs-container" aria-label="Container" value={container()} onChange={(e) => setContainer(e.currentTarget.value)}>
            {/* "All containers" (the default for a multi-container pod) merges every app container,
                colour-labelled and timestamp-ordered, so cross-container cause-and-effect is visible. */}
            <Show when={props.containers.length > 1}>
              <option value={ALL_CONTAINERS}>All containers</option>
            </Show>
            <Show
              when={(props.initContainers?.length ?? 0) > 0}
              fallback={<For each={props.containers}>{(c) => <option value={c}>{c}</option>}</For>}
            >
              <optgroup label="Init containers">
                <For each={props.initContainers}>{(c) => <option value={c}>{c}</option>}</For>
              </optgroup>
              <optgroup label="App containers">
                <For each={props.containers}>{(c) => <option value={c}>{c}</option>}</For>
              </optgroup>
            </Show>
          </select>
        </Show>
        <Show when={!props.aggregated && props.restarts > 0}>
          <button
            class="logs-prev"
            classList={{ active: previous() }}
            aria-pressed={previous()}
            onClick={() => setPrevious((p) => !p)}
            title="Logs from before the last restart"
          >
            previous
          </button>
        </Show>
        <button
          class="logs-ts"
          classList={{ active: timestamps() }}
          aria-pressed={timestamps()}
          onClick={() => setTimestamps((t) => !t)}
          title="Show timestamps"
        >
          timestamps
        </button>
        <button
          class="logs-wrap"
          classList={{ active: wrap() }}
          aria-pressed={wrap()}
          onClick={toggleWrap}
          title={wrap() ? 'Stop wrapping lines — scroll sideways instead' : 'Wrap long lines'}
        >
          wrap
        </button>
        <Show when={lines().length > 0 || filter()}>
          <input
            ref={filterInput}
            class="logs-filter"
            placeholder="filter…"
            aria-label="Filter log lines"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Two-stage Esc: clear first, then blur (matches sidebar/topology, cycle 268).
                if (filter()) setFilter('')
                else (e.currentTarget as HTMLInputElement).blur()
              }
            }}
          />
          {/* Case-sensitivity toggle for the filter, styled like the previous/timestamps chips. */}
          <button
            class="logs-case"
            classList={{ active: caseSensitive() }}
            aria-pressed={caseSensitive()}
            onClick={() => setCaseSensitive((c) => !c)}
            // The visible "Aa" glyph is its only accessible name otherwise — cryptic to a screen
            // reader (the sibling chips spell out "previous"/"timestamps"/"wrap"); title isn't a
            // reliable name source. Give it a worded label so it announces "Match case, toggle button".
            aria-label="Match case"
            title="Match case"
          >
            Aa
          </button>
        </Show>
        {/* Per-level filter chips (cycle 328): one per recognized severity, colored to match the inline
            badges. A lit chip shows that level; clicking dims it and hides those lines. Lines with no
            detected level always stay (see filterLogLines), so this trims labeled noise, not context. */}
        <Show when={lines().length > 0}>
          <span class="logs-levels" role="group" aria-label="Filter by level">
            <For each={LEVEL_ORDER}>
              {(lvl) => (
                <button
                  class={`logs-level log-level-${lvl}`}
                  classList={{ off: hiddenLevels().has(lvl) }}
                  aria-pressed={!hiddenLevels().has(lvl)}
                  onClick={() => toggleLevel(lvl)}
                  title={hiddenLevels().has(lvl) ? `Show ${lvl} lines` : `Hide ${lvl} lines`}
                >
                  {LEVEL_LABEL[lvl]}
                </button>
              )}
            </For>
          </span>
        </Show>
        <span class="logs-right">
          {/* Jump-to-error (cycle 332/R6): only present when the visible buffer holds error lines.
              Clicking (or Shift+E) steps to the next one, wrapping — fast triage past INFO chatter. */}
          <Show when={errorIndices().length > 0}>
            <button
              class="logs-errjump"
              title={`Jump to next error of ${errorIndices().length}`}
              aria-label={`Jump to next error of ${errorIndices().length}`}
              onClick={jumpToNextError}
            >
              ↧ {errorIndices().length} err
            </button>
          </Show>
          <Show when={filtering()}>
            <span
              class="logs-count"
              classList={{ none: visibleLines().length === 0 }}
              title={`${visibleLines().length} of ${lines().length} lines shown — the rest are hidden by filters`}
            >
              {visibleLines().length}/{lines().length}
            </span>
          </Show>
          <Show when={error()}>
            <span class="logs-error" classList={{ notice: gentle() }}>
              {gentle() ? 'no logs yet' : 'stream interrupted'}
            </span>
          </Show>
          <Show when={visibleLines().length > 0}>
            {/* Grouped views mix lines from several sources (pods in a workload, containers in a merged
                pod); copying without the source prefix would lose attribution. Prepend "<source> | " so
                the paste matches what the on-screen chip/label shows. Time is included only when the
                (visible) timestamp column is on, so the copy mirrors the screen. */}
            <CopyButton
              text={() =>
                visibleLines()
                  .map((l) => {
                    const ts = timestamps() && l.time ? `${l.time} ` : ''
                    const src = grouped() ? `${groupKey(l)} | ` : ''
                    return `${src}${ts}${l.line}`
                  })
                  .join('\n')
              }
              // Copy acts on the filtered view, so say so when ANY filter is active (text, level, or
              // source) — otherwise the static "Copy logs" hides that you're copying a subset, not the
              // whole buffer (cycle 318; extended to level/source filters so all three read alike).
              title={filtering() ? `Copy ${visibleLines().length} filtered line${visibleLines().length === 1 ? '' : 's'}` : 'Copy logs'}
            />
          </Show>
          {/* Maximize: fold the resource summary away so this panel takes the drawer's full height.
              Sits at the panel's top-right (the conventional maximize corner) and next to the logs it
              grows, rather than in the drawer-header action cluster. */}
          <Show when={props.onToggleMaximize}>
            <button
              class="logs-maximize"
              classList={{ active: props.maximized }}
              aria-pressed={props.maximized}
              title={props.maximized ? 'Restore the resource summary' : 'Hide the summary to enlarge this panel'}
              aria-label={props.maximized ? 'Restore the resource summary' : 'Hide the summary to enlarge this panel'}
              onClick={() => props.onToggleMaximize!()}
            >
              <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                <path
                  d={props.maximized ? 'M3 6 L7 10 L11 6' : 'M3 8 L7 4 L11 8'}
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <line x1="3" y1={props.maximized ? 3 : 11} x2="11" y2={props.maximized ? 3 : 11} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
              </svg>
              {props.maximized ? 'restore' : 'maximize'}
            </button>
          </Show>
        </span>
      </div>
      {/* Per-source toggles for grouped streams (cycle 328/R2, generalized): one chip per source
          present (pod for a workload, container for a merged pod), colored to match that source's inline
          label so the connection is obvious. Click hides/shows it; shift-click solos it. Only shown
          when more than one source is interleaved. */}
      <Show when={presentGroups().length > 1}>
        <div class="logs-pods" role="group" aria-label={`Filter by ${groupNoun()}`}>
          <For each={presentGroups()}>
            {(key) => (
              <button
                class="logs-pod-chip"
                classList={{ off: hiddenGroups().has(key) }}
                aria-pressed={!hiddenGroups().has(key)}
                title={`${key}\n${hiddenGroups().has(key) ? 'click to show' : 'click to hide'} · shift-click to show only this ${groupNoun()}`}
                onClick={(e) => (e.shiftKey ? soloGroup(key) : toggleGroup(key))}
              >
                <span class="logs-pod-dot" style={{ background: labelColor(key) }} />
                {middleTruncate(key, 22)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <pre ref={pre} class="logs-body" classList={{ 'no-wrap': !wrap() }} onScroll={onScroll} tabindex="0">
        <For each={visibleLines()}>
          {(l) => {
            // A structured line — JSON ({…}) or logfmt (key=value) — renders message-first instead of
            // as a raw blob, so time=/level= metadata doesn't bury the message. Skip the parse for ANSI
            // lines (they carry their own colouring and are rarely structured).
            const structured = hasAnsi(l.line) ? null : parseJsonLog(l.line) ?? parseLogfmtLog(l.line)
            return (
            <div
              class="log-line"
              // Alt/Option-click copies just this line (with its source/timestamp prefix, matching the
              // bulk copy) — the fastest way to share one error line into a chat or ticket. Alt
              // rather than Shift so it doesn't fight Shift+click range text-selection (cycle 323).
              title="Alt-click to copy this line"
              onClick={(e) => {
                if (!e.altKey) return
                const el = e.currentTarget as HTMLElement
                const ts = timestamps() && l.time ? `${l.time} ` : ''
                const src = grouped() ? `${groupKey(l)} | ` : ''
                // Optional-chain the whole chain: in a non-secure context `navigator.clipboard` is
                // undefined, so `?.writeText(…)` is undefined and a bare `.then` would throw a
                // TypeError synchronously (the `.catch` can't catch a sync throw). Same guard as the
                // App-level y-yank.
                navigator.clipboard
                  ?.writeText(`${src}${ts}${l.line}`)
                  ?.then(() => {
                    el.classList.add('copied')
                    setTimeout(() => el.classList.remove('copied'), 700)
                  })
                  ?.catch(() => {})
              }}
            >
              {/* Colored severity badge (cycle 322) for error-first scanning. Only shown when a
                  level is confidently detected; plain lines stay badge-free. */}
              <Show when={parseLogLevel(l.line)}>
                {(lvl) => <span class={`log-level log-level-${lvl()}`}>{LEVEL_LABEL[lvl()]}</span>}
              </Show>
              <Show when={grouped()}>
                <span class="log-pod" style={{ color: labelColor(groupKey(l)) }} title={groupKey(l)}>
                  {middleTruncate(groupKey(l), 20)}
                </span>
              </Show>
              {/* Time column shows when timestamps are on — toggled by the operator, or defaulted on in
                  combined mode (the merge is time-ordered, so the stamp is what makes the order legible). */}
              <Show when={timestamps() && l.time}>
                {/* Compact HH:MM:SS.mmm display; full RFC3339 stamp on hover (cycle 324). */}
                <span class="log-time" title={l.time}>{formatLogTime(l.time!)}</span>
              </Show>
              {/* A structured line (JSON or logfmt) leads with its `message` (bright) and trails the
                  remaining fields dimmed — the operator reads the message without scanning past time/level
                  noise,
                  and with no-wrap the message sits at the visible left while the extras scroll off.
                  Nothing is lost: the raw line still backs copy/grep, and `extras` keeps every field the
                  badge/time column don't already show. Highlighting runs on the displayed text so a
                  filter still marks hits in either part. */}
              <Show
                when={structured}
                fallback={
                  // Plain lines (the common case) skip the ANSI parser to keep allocations down — ANSI
                  // segmentation only kicks in for lines that actually contain a CSI escape. Both
                  // branches chunk each segment via splitByMatch so a typed filter highlights the
                  // matched substring inline (cycle 249), making the hit's position obvious.
                  <Show
                    when={hasAnsi(l.line)}
                    fallback={
                      <For each={splitByMatch(l.line, filter(), caseSensitive())}>
                        {(p) => (p.match ? <mark class="log-match">{p.text}</mark> : <>{p.text}</>)}
                      </For>
                    }
                  >
                    <For each={parseAnsi(l.line)}>
                      {(seg) => (
                        <span style={ansiStyleToCss(seg.style)}>
                          <For each={splitByMatch(seg.text, filter(), caseSensitive())}>
                            {(p) => (p.match ? <mark class="log-match">{p.text}</mark> : <>{p.text}</>)}
                          </For>
                        </span>
                      )}
                    </For>
                  </Show>
                }
              >
                {(j) => (
                  <>
                    <span class="log-msg">
                      <For each={splitByMatch(j().message, filter(), caseSensitive())}>
                        {(p) => (p.match ? <mark class="log-match">{p.text}</mark> : <>{p.text}</>)}
                      </For>
                    </span>
                    <Show when={j().extras}>
                      <span class="log-json-extra">
                        {' '}
                        <For each={splitByMatch(j().extras, filter(), caseSensitive())}>
                          {(p) => (p.match ? <mark class="log-match">{p.text}</mark> : <>{p.text}</>)}
                        </For>
                      </span>
                    </Show>
                  </>
                )}
              </Show>
            </div>
            )
          }}
        </For>
        {gone() && visibleLines().length > 0 && (
          // The tailed resource died with lines already on screen (often a final kubelet notice):
          // mark the end of the stream where the eye is — at the tail — instead of relying on the
          // empty-state text that only renders when nothing arrived.
          <div class="logs-waiting">— log stream ended: the resource was deleted —</div>
        )}
        {visibleLines().length === 0 && !error() && (
          // Distinguish "logs exist but every line is hidden by a filter" from "no logs yet". The
          // old check looked only at the text filter, so toggling off all level chips (or all pod
          // chips) left 25 streaming lines reading "waiting for log output…" — falsely implying the
          // pod was silent. Keying on the raw buffer covers every filter (level, pod, text).
          <div class="logs-waiting">
            <Show
              when={lines().length > 0}
              fallback={
                completed()
                  ? 'no previous logs for this container'
                  : gone()
                    ? 'log stream ended — the resource was deleted'
                    : finishedRun()
                      ? 'this run already finished — no log output remains (its pods may have been cleaned up)'
                      : props.neverRan
                        ? 'this has not run yet — logs will appear after its first scheduled run'
                        : 'waiting for log output…'
              }
            >
              {/* Name the count so a PERSISTED level filter that hides a fresh pod's whole output reads
                  as "30 lines are here, hidden" not "this pod is silent", and offer a one-click reset
                  (the topology empty-state has the same affordance). */}
              all {lines().length} line{lines().length === 1 ? '' : 's'} hidden by the active filters
              <button class="logs-clear-filters" onClick={clearLogFilters}>show all</button>
            </Show>
          </div>
        )}
      </pre>
      <Show when={!pinned()}>
        <button
          class="logs-jump"
          onClick={() => {
            toBottom()
            setPinned(true)
            setUnseenLines(0)
          }}
        >
          ↓ Latest
          <Show when={unseenLines() > 0}>
            <span class="logs-jump-count">{unseenLines() >= 999 ? '999+' : unseenLines()}</span>
          </Show>
        </button>
      </Show>
    </div>
  )
}

// Compact, fixed-width labels for the per-line severity badge so the colored column stays aligned.
const LEVEL_LABEL: Record<LogLevel, string> = { error: 'ERR', warn: 'WRN', info: 'INF', debug: 'DBG' }
// Severity order (most→least urgent) for the per-level filter chips, so the chip row reads ERR→DBG.
const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug']
// ALL_CONTAINERS is the sentinel container selection requesting a single pod's logs merged across every
// container — the default for a multi-container pod, mirroring the server's allContainers value.
const ALL_CONTAINERS = '__all__'

// labelColor maps a source name (pod, in an aggregated workload stream; container, in a single pod's
// all-container view) to a stable hue so interleaved lines are easy to tell apart at a glance — the
// same source is always the same color.
function labelColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360
  return `hsl(${h}, 70%, 70%)`
}
