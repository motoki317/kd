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

// BuildInfo is the running binary's identity, shown in the About card. version is git-describe
// output ("v0.3.0" on a tag, "v0.3.0-5-gabc1234[-dirty]" off it); commit is the full SHA.
export interface BuildInfo {
  version: string
  commit: string
}

export interface ContextsResponse {
  // enabled is false in in-cluster mode (only one cache, no kubeconfig) — the UI hides the
  // switcher in that case so deployed kd looks identical to the pre-multi-context UX.
  enabled: boolean
  default: string
  contexts: ContextInfo[]
  // Rides the bootstrap response so the About card needs no extra request (server piggybacks it).
  build: BuildInfo
}

export async function fetchContexts(): Promise<ContextsResponse> {
  const res = await fetch(`${base}/contexts`)
  // ApiError so the bootstrap path can tell "no identity / denied" (401/403) from an outage.
  if (!res.ok) throw new ApiError(`contexts: ${res.status}`, res.status)
  return (await res.json()) as ContextsResponse
}

export interface NamespaceInfo {
  name: string
  health: Health
  nonReady?: number // count of non-Healthy resources, the scale behind the health dot
}

export interface NamespacesStreamHandlers {
  // namespaces carries the full per-namespace health list each time it changes (the server diffs and
  // pushes only on change), so the handler replaces the list wholesale.
  namespaces: (list: NamespaceInfo[]) => void
  error?: () => void
}

// A silently stalled SSE connection — a proxy or NAT half-closing a long-lived stream — delivers no
// data AND fires no `error`, so EventSource's built-in reconnection never triggers and readyState
// stays OPEN forever. The namespaces and graph feeds both remain open while an operator stays in the
// same context or namespace, so a silent stall would freeze health or topology without looking
// disconnected. Log streams deliberately stay unwrapped because reconnecting replays tailed lines.
//
// watchedEventSource is the backstop: the server sends a `ping` event every ~15s, so if NOTHING (ping,
// data, or open) arrives within SSE_STALE_MS the connection is presumed dead and the EventSource is
// transparently re-created in place — no app-state reset; the server re-sends its authoritative
// snapshot on reconnect. A native `error` is left to EventSource's own retry (the detectable case);
// the timer stays armed as a backstop in case that retry itself silently stalls.
const SSE_STALE_MS = 40_000 // ~2.5 heartbeat intervals: survives two missed 15s pings before giving up
const SSE_BACKOFF_MAX_MS = 120_000 // ceiling on the gap between reconnect attempts during an outage

function watchedEventSource(
  url: string,
  handlers: { events: Record<string, (e: MessageEvent) => void>; onError?: () => void },
): () => void {
  let es: EventSource | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let gen = 0 // bumped per (re)connect; guards a late handler from a superseded source
  let backoff = SSE_STALE_MS
  let closed = false

  const arm = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(reconnect, ms)
  }
  // A real signal proves the connection is alive: reset backoff and the staleness deadline.
  const alive = () => {
    backoff = SSE_STALE_MS
    arm(SSE_STALE_MS)
  }
  function reconnect() {
    if (closed) return
    backoff = Math.min(backoff * 1.5, SSE_BACKOFF_MAX_MS)
    // Jitter within the cap (so the ceiling stays literal) and re-arm as a backstop for the fresh
    // connection: if the replacement is also silent this fires again with the grown backoff.
    arm(Math.min(backoff * (0.8 + Math.random() * 0.4), SSE_BACKOFF_MAX_MS))
    connect()
  }
  function connect() {
    const myGen = ++gen
    es?.close()
    const src = new EventSource(url)
    es = src
    const fresh = () => !closed && myGen === gen
    src.addEventListener('open', () => fresh() && alive())
    src.addEventListener('ping', () => fresh() && alive())
    for (const [name, fn] of Object.entries(handlers.events)) {
      src.addEventListener(name, (e) => {
        if (!fresh()) return
        alive()
        fn(e as MessageEvent)
      })
    }
    src.onerror = () => fresh() && handlers.onError?.() // leave the timer armed; EventSource retries
  }
  // Background tabs throttle timers and may suspend the connection; re-arm on refocus so we grant a
  // fresh grace window instead of reconnecting the instant the tab returns.
  const onVisible = () => {
    if (!closed && document.visibilityState === 'visible') arm(SSE_STALE_MS)
  }
  document.addEventListener('visibilitychange', onVisible)

  connect()
  arm(SSE_STALE_MS)
  return () => {
    closed = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    es?.close()
  }
}

// streamNamespaces tails the cluster's per-namespace health over SSE, returning a function that closes
// the stream. The server rolls up every visible namespace's worst health and pushes the (small) list
// on connect and whenever it changes — so the sidebar holds one quiet connection instead of polling
// /namespaces every 15s. The watched wrapper recovers this quiet, context-long connection from a
// silent stall.
export function streamNamespaces(ctx: string, h: NamespacesStreamHandlers): () => void {
  return watchedEventSource(`${ctxBase(ctx)}/namespaces/stream`, {
    events: {
      namespaces: (e) => h.namespaces((JSON.parse(e.data) as { namespaces?: NamespaceInfo[] }).namespaces ?? []),
    },
    onError: () => h.error?.(),
  })
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

export interface EventStreamHandlers {
  // events carries the full, newest-first list each time it changes (the server diffs server-side and
  // only pushes on change), so the handler replaces the list wholesale.
  events: (list: EventEntry[]) => void
  error?: () => void
}

// streamEvents tails a resource's Kubernetes events over SSE, returning a function that closes the
// stream. The server lists events live (they aren't cached) and pushes the subtree-aggregated list
// only when it changes — so the drawer holds one quiet connection instead of polling every 8s.
export function streamEvents(ctx: string, ns: string, kind: string, name: string, h: EventStreamHandlers): () => void {
  // A cluster-scoped resource has an empty namespace; substitute the scope sentinel so the URL
  // doesn't collapse to `namespaces//…` (which the server 307→404s) — same rule as logs/manifest.
  const es = new EventSource(
    `${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns || CLUSTER_SCOPE)}/resources/${kind}/${encodeURIComponent(name)}/events/stream`,
  )
  es.addEventListener('events', (e) =>
    h.events(((JSON.parse((e as MessageEvent).data) as { events?: EventEntry[] }).events) ?? []),
  )
  es.onerror = () => h.error?.()
  return () => es.close()
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
  return watchedEventSource(`${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns)}/graph/stream`, {
    events: {
      snapshot: (e) => h.snapshot(JSON.parse(e.data)),
      patch: (e) => h.patch(JSON.parse(e.data)),
      summary: (e) => h.summary?.(JSON.parse(e.data) as NamespaceSummary),
      capacity: (e) => h.capacity?.(JSON.parse(e.data) as Capacity),
    },
    onError: () => h.error?.(),
  })
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
  onGone?: () => void,
): () => void {
  const params = new URLSearchParams({ follow: opts.previous ? 'false' : 'true' })
  if (opts.container) params.set('container', opts.container)
  if (opts.tailLines != null) params.set('tailLines', String(opts.tailLines))
  if (opts.previous) params.set('previous', 'true')
  if (opts.timestamps) params.set('timestamps', 'true')
  // A cluster-scoped resource (a Node aggregating its static pods' logs) has an empty namespace;
  // interpolating it raw yields `namespaces//…` which the server 307→404s. Substitute the scope
  // sentinel the server unmaps — same rule as the manifest/events fetches.
  const es = new EventSource(
    `${ctxBase(ctx)}/namespaces/${encodeURIComponent(ns || CLUSTER_SCOPE)}/resources/${kind}/${encodeURIComponent(name)}/log/stream?${params}`,
  )
  es.addEventListener('log', (e) => onLine(JSON.parse((e as MessageEvent).data) as LogEntry))
  // The one-shot (previous-logs) dump emits `done` when it has streamed everything; the live follow
  // stream never does. Lets the viewer tell "nothing yet, still streaming" from "finished, empty".
  es.addEventListener('done', () => onDone?.())
  // The follow stream's supervisor reports the tailed resource being deleted — distinct from a
  // connection error and from a mid-rollout zero-pod gap (which stays silent).
  es.addEventListener('gone', () => onGone?.())
  es.onerror = () => onError?.()
  return () => es.close()
}
