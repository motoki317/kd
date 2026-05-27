import { createSignal, onCleanup, createEffect, For, Show } from 'solid-js'
import { streamLogs, type LogEntry } from '../api'
import { middleTruncate } from '../names'

interface Props {
  namespace: string
  kind: string
  name: string
  // aggregated logs span several descendant pods, so each line is labelled with its source pod.
  aggregated: boolean
}

// LogViewer tails a resource's logs over SSE, auto-scrolling to the newest line. For workloads the
// server merges all descendant pods into one stream; the pod label disambiguates the lines.
export default function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<LogEntry[]>([])
  const [error, setError] = createSignal(false)
  let pre: HTMLPreElement | undefined

  createEffect(() => {
    // Re-subscribe whenever the target resource changes.
    const ns = props.namespace
    const kind = props.kind
    const name = props.name
    setLines([])
    setError(false)
    const close = streamLogs(
      ns,
      kind,
      name,
      { tailLines: 200 },
      (entry) => {
        setLines((prev) => (prev.length > 2000 ? [...prev.slice(-2000), entry] : [...prev, entry]))
        queueMicrotask(() => pre?.scrollTo({ top: pre.scrollHeight }))
      },
      () => setError(true),
    )
    onCleanup(close)
  })

  return (
    <div class="logs">
      <div class="logs-header">
        <span>Logs</span>
        {error() && <span class="logs-error">stream interrupted</span>}
      </div>
      <pre ref={pre} class="logs-body">
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
