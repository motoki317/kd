import { createSignal, onCleanup, createEffect, For, on, Show } from 'solid-js'
import { streamLogs, type LogEntry } from '../api'
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
  let pre: HTMLPreElement | undefined

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
        <span class="logs-right">
          {error() && <span class="logs-error">stream interrupted</span>}
          <Show when={lines().length > 0}>
            <CopyButton text={() => lines().map((l) => l.line).join('\n')} title="Copy logs" />
          </Show>
        </span>
      </div>
      <pre ref={pre} class="logs-body" onScroll={onScroll}>
        <For each={lines()}>
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
        {lines().length === 0 && !error() && <div class="logs-waiting">waiting for log output…</div>}
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
