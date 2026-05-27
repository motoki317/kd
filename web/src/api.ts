// Thin client over the kd HTTP API. Reads use fetch; live feeds use Server-Sent Events.
// The identity header is supplied by the forward-auth proxy (or the Vite dev proxy), so
// EventSource needs no custom headers. See docs/ADR/20260527-realtime-transport-sse.md.

import type { KGraph, Patch, View } from './types'

const base = '/api/v1'

export async function fetchNamespaces(): Promise<string[]> {
  const res = await fetch(`${base}/namespaces`)
  if (!res.ok) throw new Error(`namespaces: ${res.status}`)
  const body = (await res.json()) as { namespaces: { name: string }[] }
  return body.namespaces.map((n) => n.name)
}

export async function fetchResource(ns: string, kind: string, name: string): Promise<unknown> {
  const res = await fetch(`${base}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`resource: ${res.status}`)
  return res.json()
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

// streamLogs tails a pod's logs and returns a function that closes the stream.
export function streamLogs(
  ns: string,
  pod: string,
  opts: { container?: string; tailLines?: number },
  onLine: (line: string) => void,
  onError?: () => void,
): () => void {
  const params = new URLSearchParams({ follow: 'true' })
  if (opts.container) params.set('container', opts.container)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  const es = new EventSource(`${base}/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(pod)}/log/stream?${params}`)
  es.addEventListener('log', (e) => onLine((JSON.parse((e as MessageEvent).data) as { line: string }).line))
  es.onerror = () => onError?.()
  return () => es.close()
}
