// Thin client over the kd HTTP API. Reads use fetch; live feeds use Server-Sent Events.
// The identity header is supplied by the forward-auth proxy (or the Vite dev proxy), so
// EventSource needs no custom headers. See docs/ADR/20260527-realtime-transport-sse.md.

import type { Health, KGraph, Patch, View } from './types'

const base = '/api/v1'

export interface NamespaceInfo {
  name: string
  health: Health
}

export async function fetchNamespaces(): Promise<NamespaceInfo[]> {
  const res = await fetch(`${base}/namespaces`)
  if (!res.ok) throw new Error(`namespaces: ${res.status}`)
  const body = (await res.json()) as { namespaces: NamespaceInfo[] }
  return body.namespaces
}

export type ManifestFormat = 'yaml' | 'json'

// fetchResource returns the resource manifest already rendered as text by the server (YAML or
// JSON), so the client just displays it — the structure is never inspected on this path.
export async function fetchResource(ns: string, kind: string, name: string, format: ManifestFormat): Promise<string> {
  const res = await fetch(
    `${base}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}?format=${format}`,
  )
  if (!res.ok) throw new Error(`resource: ${res.status}`)
  return res.text()
}

export interface GraphStreamHandlers {
  snapshot: (g: KGraph) => void
  patch: (p: Patch) => void
  error?: () => void
}

// streamGraph opens the SSE graph feed and returns a function that closes it.
export function streamGraph(ns: string, view: View, h: GraphStreamHandlers): () => void {
  const es = new EventSource(`${base}/namespaces/${encodeURIComponent(ns)}/graph/stream?view=${view}`)
  es.addEventListener('snapshot', (e) => h.snapshot(JSON.parse((e as MessageEvent).data)))
  es.addEventListener('patch', (e) => h.patch(JSON.parse((e as MessageEvent).data)))
  es.onerror = () => h.error?.()
  return () => es.close()
}

export interface LogEntry {
  pod: string
  line: string
}

// streamLogs tails a resource's logs and returns a function that closes the stream. For a Pod this
// is the pod's own log; for a workload (Deployment, ReplicaSet, ...) the server merges every
// descendant pod's log into one stream, tagging each line with its source pod.
export function streamLogs(
  ns: string,
  kind: string,
  name: string,
  opts: { container?: string; tailLines?: number },
  onLine: (entry: LogEntry) => void,
  onError?: () => void,
): () => void {
  const params = new URLSearchParams({ follow: 'true' })
  if (opts.container) params.set('container', opts.container)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  const es = new EventSource(
    `${base}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}/log/stream?${params}`,
  )
  es.addEventListener('log', (e) => onLine(JSON.parse((e as MessageEvent).data) as LogEntry))
  es.onerror = () => onError?.()
  return () => es.close()
}
