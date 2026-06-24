---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

The dashboard must feel live: pod status, graph changes, and logs should update without
manual refresh. kd sits behind `traefik-forward-auth` and Traefik, so the transport must be
proxy-friendly and carry the identity header on every connection. Two data flows need
streaming: (1) resource/graph change feeds, and (2) pod log tailing. Both are
**server→client only**.

# Decision

Use **Server-Sent Events (SSE)** over HTTP for every live, server→client feed. The client does
**no timer-based polling**: anything that changes while the user watches arrives over an SSE
stream, and the only remaining `fetch` calls are one-shot, on-demand reads of effectively static
data (`/contexts`, `/kinds`, a resource manifest).

- **Watch feed:** the client subscribes to a view (e.g. `GET /api/v1/namespaces/{ns}/graph/stream`).
  The server sends an initial `snapshot` event (full `{nodes, edges}`) then incremental
  `patch` events (added/updated/removed nodes and edges) sourced from informer change
  notifications. Heartbeat comments keep the connection alive through proxies.
- **Logs:** `GET /api/v1/namespaces/{ns}/pods/{pod}/log/stream?container=&follow=true` returns
  an SSE stream of log lines wrapping the Kubernetes `pods/log` follow stream.
- **Resource events** (`.../resources/{kind}/{name}/events/stream`) and **sidebar namespace
  health** (`.../namespaces/stream`) replaced 8s and 15s client polls with SSE feeds that push
  the (diffed) list only when it changes. Both still expose the one-shot REST endpoint alongside
  the stream, mirroring `graph` / `graph/stream`.
- Every SSE request passes through the same auth + RBAC middleware as REST; the identity
  header is a normal request header, so no special handshake auth is needed.
- The server coalesces change before emitting, to avoid flooding the client during churn. The
  cadence is per-feed: the graph debounces a 300ms window (one namespace rebuilt per change);
  namespace health re-summarizes on a coarse ~15s tick gated by a change flag (it rolls up
  EVERY namespace, so per-change recompute would amplify constant lease churn); events re-list
  on a fixed interval. Each pushes only when the result differs from the last sent.

# Consequences

- Plain HTTP/1.1 + `text/event-stream`: passes through Traefik/forward-auth unchanged, with
  automatic browser reconnection (`Last-Event-ID`) and trivial server implementation
  (`http.Flusher`).
- Same auth path as REST — no second auth mechanism for sockets.
- Unidirectional fits both flows; no need for client→server messaging in v1.

# Impact

- SSE is one-directional; if a future feature needs client→server streaming (e.g. interactive
  exec/attach), that endpoint will use WebSocket specifically, not SSE.
- HTTP/1.1 limits concurrent connections per host (~6); with HTTP/2 (which Traefik terminates)
  this is a non-issue. Document that kd should be served over HTTP/2.
- Long-lived connections need sane server timeouts (disable write timeout on stream handlers,
  use heartbeats) and back-pressure handling.

# Alternatives

- **WebSocket for everything.** Rejected for v1: bidirectional capability is unused, adds
  framing/auth/reconnection complexity, and is more finicky through forward-auth.
- **Long polling.** Rejected: higher latency and overhead, worse UX.
- **gRPC-web streaming.** Rejected: extra toolchain/proto weight for a read-only feed; SSE is
  natively supported by browsers and `client-go`'s log stream maps cleanly.

# Notes

- The watch endpoint reuses the same graph model and views as the REST endpoint
  (resource-relationship-graph ADR); REST returns a snapshot, SSE returns snapshot + patches.
- Not every SSE feed is informer-driven. The graph and namespace-health feeds wake on the store's
  change signal (a cached, watched kind changed). Events are intentionally NOT cached
  (`store.DefaultSkipKinds` — too high-cardinality and short-lived), so their stream polls the
  live Events API server-side on a fixed interval and diffs. This still removes the *client* poll
  (one quiet connection, deltas only) — the goal is no client-side polling, not zero server-side
  timers; the log stream likewise re-resolves descendant pods on a server-side ticker.
