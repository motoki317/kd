// Thin client over the kd HTTP API. Reads use fetch; live feeds use Server-Sent Events.
// The identity header is supplied by the forward-auth proxy (or the Vite dev proxy), so
// EventSource needs no custom headers. See docs/ADR/20260527-realtime-transport-sse.md.

import type { Capacity, Health, KGraph, Patch } from './types'

const base = '/api/v1'

// ctxBase scopes namespaced reads to one kubeconfig context. The /api/v1/contexts/<ctx>
// prefix is required by the server (no fallback), so callers always pass the context the UI
// is currently rendering.
const ctxBase = (ctx: string) => `${base}/contexts/${encodeURIComponent(ctx)}`

export type ContextStatus = 'pending' | 'syncing' | 'ready' | 'error'

export interface ContextInfo {
  name: string
  status: ContextStatus
  error?: string
}

export interface ContextsResponse {
  // enabled is false in in-cluster mode (only one cache, no kubeconfig) — the UI hides the
  // switcher in that case so deployed kd looks identical to the pre-multi-context UX.
  enabled: boolean
  default: string
  contexts: ContextInfo[]
}

export async function fetchContexts(): Promise<ContextsResponse> {
  const res = await fetch(`${base}/contexts`)
  if (!res.ok) throw new Error(`contexts: ${res.status}`)
  return (await res.json()) as ContextsResponse
}

export interface NamespaceInfo {
  name: string
  health: Health
  nonReady?: number // count of non-Healthy resources, the scale behind the health dot
}

export async function fetchNamespaces(ctx: string): Promise<NamespaceInfo[]> {
  const res = await fetch(`${ctxBase(ctx)}/namespaces`)
  if (!res.ok) throw new Error(`namespaces: ${res.status}`)
  const body = (await res.json()) as { namespaces: NamespaceInfo[] }
  return body.namespaces
}

// fetchKinds returns the cluster's kind → API short-name map (kubectl's SHORTNAMES, e.g.
// ConfigMap→"cm"), so cards label kinds with the cluster's own abbreviations — CRD shorts
// included — rather than a hardcoded guess. Keyed on context since CRDs differ per cluster.
export async function fetchKinds(ctx: string): Promise<Record<string, string>> {
  const res = await fetch(`${ctxBase(ctx)}/kinds`)
  if (!res.ok) throw new Error(`kinds: ${res.status}`)
  return ((await res.json()) as { shortNames?: Record<string, string> }).shortNames ?? {}
}

// CLUSTER_SCOPE is the sentinel namespace name kd uses in URLs for cluster-scoped resources.
// The client treats it as a pinned synthetic entry in the sidebar (FR-004); the server maps
// it to its cluster-scope snapshot. Underscores aren't valid in DNS-1123 namespace names, so
// it can never collide with a real namespace.
export const CLUSTER_SCOPE = '__cluster__'

export type ManifestFormat = 'yaml' | 'json'

// ApiError keeps the HTTP status on the thrown error so error states can distinguish "kd's policy
// denied this" (403 — actionable: ask an admin, not a kd fault) from a transport/server failure.
export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// isForbidden reports whether a resource fetch failed on kd's OWN authorization (the policy.csv) —
// the one failure that should never render as a generic "unavailable".
export const isForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403

// fetchResource returns the resource manifest already rendered as text by the server (YAML or
// JSON), so the client just displays it — the structure is never inspected on this path.
export async function fetchResource(
  ctx: string,
  ns: string,
  kind: string,
  name: string,
  format: ManifestFormat,
): Promise<string> {
  const res = await fetch(
    `${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}?format=${format}`,
  )
  if (!res.ok) throw new ApiError(`resource: ${res.status}`, res.status)
  return res.text()
}

export interface EventEntry {
  type: string // Normal | Warning
  reason: string
  message: string
  count: number
  last: string // RFC3339, formatted relative on the client
  source?: string // "Kind/name" of the involvedObject; shown for aggregated events from descendants
}

// fetchEvents returns the Kubernetes events about a resource, newest-first.
export async function fetchEvents(ctx: string, ns: string, kind: string, name: string): Promise<EventEntry[]> {
  const res = await fetch(
    `${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}/events`,
  )
  if (!res.ok) throw new ApiError(`events: ${res.status}`, res.status)
  return ((await res.json()) as { events: EventEntry[] }).events ?? []
}

// NamespaceSummary mirrors the server's graph.Summary: the namespace's worst health and the
// count of non-Healthy nodes, both computed from the UNFILTERED graph. The sidebar uses this
// instead of rolling up the filtered topology, so a degraded resource not in the current view
// (e.g. a Service with no endpoints while the user is in the ownership view) still surfaces.
export interface NamespaceSummary {
  health: Health
  nonReady?: number
}

export interface GraphStreamHandlers {
  snapshot: (g: KGraph) => void
  patch: (p: Patch) => void
  summary?: (s: NamespaceSummary) => void
  // capacity carries the cluster-wide Node + Pod set (with usage) the Nodes group-by draws —
  // independent of the namespace-scoped graph above. See the Capacity type.
  capacity?: (c: Capacity) => void
  error?: () => void
}

// streamGraph opens the SSE graph feed and returns a function that closes it. The server streams
// the full graph; the client projects relationship subsets and grouping itself.
export function streamGraph(ctx: string, ns: string, h: GraphStreamHandlers): () => void {
  const es = new EventSource(`${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns)}/graph/stream`)
  es.addEventListener('snapshot', (e) => h.snapshot(JSON.parse((e as MessageEvent).data)))
  es.addEventListener('patch', (e) => h.patch(JSON.parse((e as MessageEvent).data)))
  es.addEventListener('summary', (e) => h.summary?.(JSON.parse((e as MessageEvent).data) as NamespaceSummary))
  es.addEventListener('capacity', (e) => h.capacity?.(JSON.parse((e as MessageEvent).data) as Capacity))
  es.onerror = () => h.error?.()
  return () => es.close()
}

export interface LogEntry {
  pod: string
  container?: string // source container, set when a single pod's logs are merged across all containers
  time?: string // RFC3339Nano emission time, present only when timestamps were requested
  line: string
}

// streamLogs tails a resource's logs and returns a function that closes the stream. For a Pod this
// is the pod's own log; for a workload (Deployment, ReplicaSet, ...) the server merges every
// descendant pod's log into one stream, tagging each line with its source pod.
export function streamLogs(
  ctx: string,
  ns: string,
  kind: string,
  name: string,
  opts: { container?: string; tailLines?: number; previous?: boolean; timestamps?: boolean },
  onLine: (entry: LogEntry) => void,
  onError?: () => void,
  onDone?: () => void,
): () => void {
  const params = new URLSearchParams({ follow: opts.previous ? 'false' : 'true' })
  if (opts.container) params.set('container', opts.container)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  if (opts.previous) params.set('previous', 'true')
  if (opts.timestamps) params.set('timestamps', 'true')
  const es = new EventSource(
    `${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns)}/resources/${kind}/${encodeURIComponent(name)}/log/stream?${params}`,
  )
  es.addEventListener('log', (e) => onLine(JSON.parse((e as MessageEvent).data) as LogEntry))
  // The one-shot (previous-logs) dump emits `done` when it has streamed everything; the live follow
  // stream never does. Lets the viewer tell "nothing yet, still streaming" from "finished, empty".
  es.addEventListener('done', () => onDone?.())
  es.onerror = () => onError?.()
  return () => es.close()
}
