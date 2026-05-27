import { createMemo, createSignal, onCleanup, createEffect, For, on, Show } from 'solid-js'
import { streamLogs, type LogEntry } from '../api'
import { filterLogLines } from '../logs'
import { middleTruncate } from '../names'
import CopyButton from './CopyButton'

interface Props {
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
}

// LogViewer tails a resource's logs over SSE, auto-scrolling to the newest line. For workloads the
// server merges all descendant pods into one stream; the pod label disambiguates the lines.
export default function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<LogEntry[]>([])
  const [error, setError] = createSignal(false)
  // Follow the tail only while the viewport is at the bottom; once the user scrolls up to read
  // history, new lines stop yanking them down (a "Latest" button jumps back).
  const [pinned, setPinned] = createSignal(true)
  // Selected container for a single multi-container pod (empty = server picks the first).
  const [container, setContainer] = createSignal('')
  // Show the previous (crashed) container's logs — where a CrashLoopBackOff reason lives.
  const [previous, setPrevious] = createSignal(false)
  // Client-side line filter ("grep"): hide lines not containing this substring.
  const [filter, setFilter] = createSignal('')
  const visibleLines = createMemo(() => filterLogLines(lines(), filter()))
  let pre: HTMLPreElement | undefined

  // A single pod that isn't Running can't produce logs yet, so an error there is "no logs" not a drop.
  const gentle = createMemo(() => !props.aggregated && !(props.status ?? '').startsWith('Running'))
  const toBottom = () => pre?.scrollTo({ top: pre.scrollHeight })
  const onScroll = () => {
    if (pre) setPinned(pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40)
  }

  // Reset container + previous toggle whenever the target pod changes.
  createEffect(
    on(
      () => props.name,
      () => {
        setContainer(props.containers[0] ?? '')
        setPrevious(false)
        setFilter('')
      },
    ),
  )

  createEffect(() => {
    // Re-subscribe whenever the target resource, container, or previous toggle changes.
    const ns = props.namespace
    const kind = props.kind
    const name = props.name
    const c = container()
    const prev = previous()
    setLines([])
    setError(false)
    setPinned(true)
    const close = streamLogs(
      ns,
      kind,
      name,
      { tailLines: 200, container: c || undefined, previous: prev },
      (entry) => {
        setError(false) // a line arriving means the stream recovered
        setLines((prev) => (prev.length > 2000 ? [...prev.slice(-2000), entry] : [...prev, entry]))
        if (pinned()) queueMicrotask(toBottom)
      },
      () => setError(true),
    )
    onCleanup(close)
  })

  return (
    <div class="logs">
      <div class="logs-header">
        <span>Logs</span>
        <Show when={!props.aggregated && props.containers.length > 1}>
          <select class="logs-container" value={container()} onChange={(e) => setContainer(e.currentTarget.value)}>
            <For each={props.containers}>{(c) => <option value={c}>{c}</option>}</For>
          </select>
        </Show>
        <Show when={!props.aggregated && props.restarts > 0}>
          <button class="logs-prev" classList={{ active: previous() }} onClick={() => setPrevious((p) => !p)} title="Logs from the previous (crashed) container">
            previous
          </button>
        </Show>
        <Show when={lines().length > 0 || filter()}>
          <input
            class="logs-filter"
            placeholder="filter…"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </Show>
        <span class="logs-right">
          <Show when={filter()}>
            <span class="logs-count" classList={{ none: visibleLines().length === 0 }}>
              {visibleLines().length}/{lines().length}
            </span>
          </Show>
          <Show when={error()}>
            <span class="logs-error" classList={{ notice: gentle() }}>
              {gentle() ? 'no logs yet' : 'stream interrupted'}
            </span>
          </Show>
          <Show when={visibleLines().length > 0}>
            <CopyButton text={() => visibleLines().map((l) => l.line).join('\n')} title="Copy logs" />
          </Show>
        </span>
      </div>
      <pre ref={pre} class="logs-body" onScroll={onScroll}>
        <For each={visibleLines()}>
          {(l) => (
            <div class="log-line">
              <Show when={props.aggregated}>
                <span class="log-pod" style={{ color: podColor(l.pod) }} title={l.pod}>
                  {middleTruncate(l.pod, 20)}
                </span>
              </Show>
              {l.line}
            </div>
          )}
        </For>
        {visibleLines().length === 0 && !error() && (
          <div class="logs-waiting">{filter() ? 'no lines match the filter' : 'waiting for log output…'}</div>
        )}
      </pre>
      <Show when={!pinned()}>
        <button
          class="logs-jump"
          onClick={() => {
            toBottom()
            setPinned(true)
          }}
        >
          ↓ Latest
        </button>
      </Show>
    </div>
  )
}

// podColor maps a pod name to a stable hue so interleaved lines from different pods are easy to
// tell apart at a glance (the same pod is always the same color).
function podColor(pod: string): string {
  let h = 0
  for (let i = 0; i < pod.length; i++) h = (h * 31 + pod.charCodeAt(i)) % 360
  return `hsl(${h}, 70%, 70%)`
}
