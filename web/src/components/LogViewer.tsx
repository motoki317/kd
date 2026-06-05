import { createMemo, createSignal, onCleanup, createEffect, For, on, onMount, Show } from 'solid-js'
import { streamLogs, type LogEntry } from '../api'
import { ansiStyleToCss, hasAnsi, parseAnsi } from '../ansi'
import { readRawPref, writePref } from '../prefs'
import { filterLogLines, formatLogTime, parseLogLevel, splitByMatch, type LogLevel } from '../logs'
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
  // container names for a single pod; >1 enables the per-container picker.
  containers: string[]
  // restart total for a single pod; >0 offers the "previous" (crashed container) logs.
  restarts: number
  // single pod's status, to tell "container not started yet" from a real stream drop.
  status?: string
  // True while the parent panel is on-screen. The viewer stays mounted across tab switches so the
  // stream survives; flipping this back to true asks the viewer to snap to the tail (so coming
  // back to Logs from Manifest lands on the newest line, not a stale scroll position).
  visible?: boolean
}

// LogViewer tails a resource's logs over SSE, auto-scrolling to the newest line. For workloads the
// server merges all descendant pods into one stream; the pod label disambiguates the lines.
export default function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<LogEntry[]>([])
  const [error, setError] = createSignal(false)
  // Follow the tail only while the viewport is at the bottom; once the user scrolls up to read
  // history, new lines stop yanking them down (a "Latest" button jumps back).
  const [pinned, setPinned] = createSignal(true)
  // Count of new lines arrived while the operator was scrolled up — surfaced in the "Latest"
  // button so they know how much they're missing without scrolling to check.
  const [unseenLines, setUnseenLines] = createSignal(0)
  // Selected container for a single multi-container pod (empty = server picks the first).
  const [container, setContainer] = createSignal('')
  // Show the previous (crashed) container's logs — where a CrashLoopBackOff reason lives.
  const [previous, setPrevious] = createSignal(false)
  // Client-side line filter ("grep"): hide lines not containing this substring.
  const [filter, setFilter] = createSignal('')
  // Case-sensitive matching for the filter (off by default — most triage is case-insensitive, but
  // an exact match disambiguates e.g. "ERROR" the level from "error" in prose). (cycle 321)
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  // Ask the server to prepend each line's emission time (kubectl --timestamps), rendered dimmed.
  const [timestamps, setTimestamps] = createSignal(false)
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
  // Per-pod filtering for aggregated workload streams (cycle 328/R2): an aggregated Deployment/
  // DaemonSet/Job view interleaves lines from every descendant pod, so isolating one misbehaving
  // replica meant typing its pod-hash into the filter. hiddenPods is the set to suppress. NOT
  // persisted — pod names are specific to the current rollout and churn on restart, so it resets when
  // the resource changes (see the on(props.name) effect).
  const [hiddenPods, setHiddenPods] = createSignal<Set<string>>(new Set<string>())
  // Pods seen in the current buffer, sorted for a stable chip order. Only computed for aggregated
  // streams; a single pod has nothing to toggle.
  const presentPods = createMemo(() => {
    if (!props.aggregated) return [] as string[]
    const seen = new Set<string>()
    for (const l of lines()) if (l.pod) seen.add(l.pod)
    return [...seen].sort()
  })
  const togglePod = (pod: string) =>
    setHiddenPods((prev) => {
      const next = new Set(prev)
      next.has(pod) ? next.delete(pod) : next.add(pod)
      return next
    })
  // Shift-click solos a pod (show only it); shift-clicking the already-soloed pod clears the filter.
  // Mirrors the topology kind-chip solo so the gesture is consistent across the app.
  const soloPod = (pod: string) =>
    setHiddenPods((prev) => {
      const others = presentPods().filter((p) => p !== pod)
      const alreadySolo = prev.size === others.length && others.every((p) => prev.has(p))
      return alreadySolo ? new Set<string>() : new Set(others)
    })
  const visibleLines = createMemo(() => {
    const hp = hiddenPods()
    const base = hp.size ? lines().filter((l) => !hp.has(l.pod)) : lines()
    return filterLogLines(base, filter(), caseSensitive(), hiddenLevels())
  })
  // Any filter is active — text grep, a dimmed level chip, or a hidden pod. Drives the "shown/total"
  // count and the copy-button's "filtered" wording: all three filter kinds subset the buffer
  // identically, so the operator deserves the same "you're seeing X of Y" feedback for each (the
  // empty-state message already covers all three; the count readout used to lag behind on text-only).
  const filtering = createMemo(() => !!filter() || hiddenLevels().size > 0 || hiddenPods().size > 0)
  // Reset every log filter at once — the recovery action when the active filters (often a level filter
  // PERSISTED from a previous pod via kd:logsHideLevels) have hidden the entire buffer, so a new pod's
  // output reads as empty. Clears the persisted level pref too; hidden-pods is per-resource so it just
  // resets in memory. Mirrors the topology empty-state's "clear all filters" affordance (Repetition).
  const clearLogFilters = () => {
    setFilter('')
    setCaseSensitive(false)
    setHiddenLevels(new Set<LogLevel>())
    writePref('kd:logsHideLevels', '')
    setHiddenPods(new Set<string>())
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
        setContainer(props.containers[0] ?? '')
        setPrevious(false)
        setFilter('')
        setCaseSensitive(false)
        setHiddenPods(new Set<string>())
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
    const ts = timestamps()
    setLines([])
    setError(false)
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
        setLines((prev) => (prev.length > 2000 ? [...prev.slice(-2000), entry] : [...prev, entry]))
        // While scrolled up, count incoming lines so the Latest button can advertise the backlog.
        if (!pinned()) setUnseenLines((n) => Math.min(n + 1, 999))
        scheduleTail()
      },
      () => setError(true),
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

  // Cmd/Ctrl+F focuses the in-viewer filter (the log "find"), overriding the browser's page find —
  // which is useless against a virtualized/streaming buffer anyway. Scoped to when the Logs tab is
  // actually showing so it doesn't hijack find elsewhere (cycle 321).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (props.visible === false) return
      const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT'
      // Cmd/Ctrl+F focuses the line filter (cycle 321).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        if (!filterInput) return
        e.preventDefault()
        filterInput.focus()
        filterInput.select()
        return
      }
      // Shift+E steps to the next error line (cycle 332/R6); plain 'e' is left alone for typing.
      if (e.shiftKey && (e.key === 'E' || e.key === 'e') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
        if (errorIndices().length === 0) return
        e.preventDefault()
        jumpToNextError()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <div class="logs">
      <div class="logs-header">
        <span>Logs</span>
        <Show when={!props.aggregated && props.containers.length > 1}>
          <select class="logs-container" aria-label="Container" value={container()} onChange={(e) => setContainer(e.currentTarget.value)}>
            <For each={props.containers}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        </Show>
        <Show when={!props.aggregated && props.restarts > 0}>
          <button
            class="logs-prev"
            classList={{ active: previous() }}
            aria-pressed={previous()}
            onClick={() => setPrevious((p) => !p)}
            title="Logs from the previous (crashed) container"
          >
            previous
          </button>
        </Show>
        <button
          class="logs-ts"
          classList={{ active: timestamps() }}
          aria-pressed={timestamps()}
          onClick={() => setTimestamps((t) => !t)}
          title="Show each line's emission time"
        >
          timestamps
        </button>
        <button
          class="logs-wrap"
          classList={{ active: !wrap() }}
          aria-pressed={!wrap()}
          onClick={toggleWrap}
          title={wrap() ? 'Stop wrapping long lines (scroll horizontally)' : 'Wrap long lines'}
        >
          wrap
        </button>
        <Show when={lines().length > 0 || filter()}>
          <input
            ref={filterInput}
            class="logs-filter"
            placeholder="filter…  ( ⌘F )"
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
              title={`Jump to next error of ${errorIndices().length} (Shift+E)`}
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
              title={`${visibleLines().length} of ${lines().length} lines shown (rest hidden by the active filters)`}
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
            {/* Aggregated views (Deployment / DaemonSet / Job …) mix lines from several pods;
                copying without the source-pod prefix would lose attribution and turn a useful
                paste into noise. Cycle 297: prepend "<pod> | " for aggregated streams. The on-
                screen pod chip already carries the same info, so the copy matches what the user
                sees. */}
            <CopyButton
              text={() =>
                visibleLines()
                  .map((l) => {
                    const ts = l.time ? `${l.time} ` : ''
                    const pod = props.aggregated ? `${l.pod} | ` : ''
                    return `${pod}${ts}${l.line}`
                  })
                  .join('\n')
              }
              // Copy acts on the filtered view, so say so when ANY filter is active (text, level, or
              // pod) — otherwise the static "Copy logs" hides that you're copying a subset, not the
              // whole buffer (cycle 318; extended to level/pod filters so all three read alike).
              title={filtering() ? `Copy ${visibleLines().length} filtered line${visibleLines().length === 1 ? '' : 's'}` : 'Copy logs'}
            />
          </Show>
        </span>
      </div>
      {/* Per-pod toggles for aggregated streams (cycle 328/R2): one chip per pod present, colored with
          the same hue as that pod's inline label so the connection is obvious. Click hides/shows a pod;
          shift-click solos it. Only shown when more than one pod is interleaved. */}
      <Show when={presentPods().length > 1}>
        <div class="logs-pods" role="group" aria-label="Filter by pod">
          <For each={presentPods()}>
            {(pod) => (
              <button
                class="logs-pod-chip"
                classList={{ off: hiddenPods().has(pod) }}
                aria-pressed={!hiddenPods().has(pod)}
                title={`${pod}\n${hiddenPods().has(pod) ? 'click to show' : 'click to hide'} · shift-click to show only this pod`}
                onClick={(e) => (e.shiftKey ? soloPod(pod) : togglePod(pod))}
              >
                <span class="logs-pod-dot" style={{ background: podColor(pod) }} />
                {middleTruncate(pod, 22)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <pre ref={pre} class="logs-body" classList={{ 'no-wrap': !wrap() }} onScroll={onScroll} tabindex="0">
        <For each={visibleLines()}>
          {(l) => (
            <div
              class="log-line"
              // Alt/Option-click copies just this line (with its pod/timestamp prefix, matching the
              // bulk copy) — the fastest way to share one error line into a chat or ticket. Alt
              // rather than Shift so it doesn't fight Shift+click range text-selection (cycle 323).
              title="Alt-click to copy this line"
              onClick={(e) => {
                if (!e.altKey) return
                const el = e.currentTarget as HTMLElement
                const ts = l.time ? `${l.time} ` : ''
                const pod = props.aggregated ? `${l.pod} | ` : ''
                // Optional-chain the whole chain: in a non-secure context `navigator.clipboard` is
                // undefined, so `?.writeText(…)` is undefined and a bare `.then` would throw a
                // TypeError synchronously (the `.catch` can't catch a sync throw). Same guard as the
                // App-level y-yank.
                navigator.clipboard
                  ?.writeText(`${pod}${ts}${l.line}`)
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
              <Show when={props.aggregated}>
                <span class="log-pod" style={{ color: podColor(l.pod) }} title={l.pod}>
                  {middleTruncate(l.pod, 20)}
                </span>
              </Show>
              <Show when={l.time}>
                {/* Compact HH:MM:SS.mmm display; full RFC3339 stamp on hover (cycle 324). */}
                <span class="log-time" title={l.time}>{formatLogTime(l.time!)}</span>
              </Show>
              {/* Plain lines (the common case) skip the ANSI parser to keep allocations down —
                  ANSI segmentation only kicks in for lines that actually contain a CSI escape.
                  Both branches further chunk each segment via splitByMatch so a typed filter
                  also highlights the matched substring inline (cycle 249), making the position
                  of the hit obvious in a long line. */}
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
            </div>
          )}
        </For>
        {visibleLines().length === 0 && !error() && (
          // Distinguish "logs exist but every line is hidden by a filter" from "no logs yet". The
          // old check looked only at the text filter, so toggling off all level chips (or all pod
          // chips) left 25 streaming lines reading "waiting for log output…" — falsely implying the
          // pod was silent. Keying on the raw buffer covers every filter (level, pod, text).
          <div class="logs-waiting">
            <Show when={lines().length > 0} fallback={'waiting for log output…'}>
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

// podColor maps a pod name to a stable hue so interleaved lines from different pods are easy to
// tell apart at a glance (the same pod is always the same color).
function podColor(pod: string): string {
  let h = 0
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) % 360
  return `hsl(${h}, 70%, 70%)`
}
