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

Use **Server-Sent Events (SSE)** over HTTP for both the resource watch feed and log
streaming.

- **Watch feed:** the client subscribes to a view (e.g. `GET /api/v1/namespaces/{ns}/graph/stream`).
  The server sends an initial `snapshot` event (full `{nodes, edges}`) then incremental
  `patch` events (added/updated/removed nodes and edges) sourced from informer change
  notifications. Heartbeat comments keep the connection alive through proxies.
- **Logs:** `GET /api/v1/namespaces/{ns}/pods/{pod}/log/stream?container=&follow=true` returns
  an SSE stream of log lines wrapping the Kubernetes `pods/log` follow stream.
- Every SSE request passes through the same auth + RBAC middleware as REST; the identity
  header is a normal request header, so no special handshake auth is needed.
- The server coalesces informer events over a short window before emitting patches, to avoid
  flooding the client during churn (e.g. a rollout).

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
