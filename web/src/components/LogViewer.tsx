import { createSignal, onCleanup, createEffect, For } from 'solid-js'
import { streamLogs } from '../api'

interface Props {
  namespace: string
  pod: string
}

// LogViewer tails a pod's logs over SSE, auto-scrolling to the newest line.
export default function LogViewer(props: Props) {
  const [lines, setLines] = createSignal<string[]>([])
  const [error, setError] = createSignal(false)
  let pre: HTMLPreElement | undefined

  createEffect(() => {
    // Re-subscribe whenever the target pod changes.
    const ns = props.namespace
    const pod = props.pod
    setLines([])
    setError(false)
    const close = streamLogs(
      ns,
      pod,
      { tailLines: 200 },
      (line) => {
        setLines((prev) => (prev.length > 2000 ? [...prev.slice(-2000), line] : [...prev, line]))
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
        <For each={lines()}>{(l) => <div class="log-line">{l}</div>}</For>
        {lines().length === 0 && !error() && <div class="logs-waiting">waiting for log output…</div>}
      </pre>
    </div>
  )
}
