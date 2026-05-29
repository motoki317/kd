---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

The deployment environment (see `github.com/motoki317/manifest`) already authenticates every app at
the edge with `traefik-forward-auth` (OIDC). After the forward-auth middleware validates a
session, it injects the authenticated identity as an HTTP header (`X-Forwarded-User`) into
the upstream request — this is exactly how Grafana is wired (`grafana.ini`'s
`auth.proxy.header_name: X-Forwarded-User`) and how Gitea's reverse-proxy auth is wired.
kd should follow this established pattern rather than implement its own login.

# Decision

kd performs **no authentication of its own**; it **trusts an upstream-injected identity
header**.

- The trusted header name is configurable, defaulting to **`X-Forwarded-User`** to match
  the existing Grafana/forward-auth setup.
- An optional **groups header** (configurable, e.g. `X-Forwarded-Groups`, comma-separated)
  can carry group membership for RBAC subject matching.
- The extracted identity is `{username, groups[]}`. It is attached to the request context
  and consumed by the RBAC layer (see declarative-rbac-policy-csv ADR).
- **Trust boundary:** kd assumes it is only reachable through the forward-auth proxy. To
  prevent header spoofing when exposed directly, kd supports an allowlist of trusted proxy
  source IPs/CIDRs; if set, the identity header is honored only from those sources. When the
  required identity header is absent, the request is rejected (401) — except in dev mode.
- **Dev mode:** a `--dev-user` flag injects a static identity so the dashboard runs locally
  without a forward-auth proxy in front.

# Consequences

- Account management is entirely delegated to the existing OIDC/forward-auth stack — no user
  store, password handling, or session management inside kd.
- Operationally identical to Grafana: drop kd behind the same `auth-admin`/`auth-hard`
  Traefik middleware and it Just Works.

# Impact

- Security depends on the proxy being the only ingress path. The trusted-proxy allowlist and
  documentation must make this boundary explicit; a misconfiguration that exposes kd directly
  would let a client spoof `X-Forwarded-User`.
- kd cannot distinguish two users sharing one proxy identity; identity granularity is
  whatever the IdP/forward-auth emits.

# Alternatives

- **Built-in OIDC client in kd.** Rejected: duplicates infrastructure the cluster already
  runs; inconsistent with the Grafana pattern the user explicitly wants to mirror.
- **mTLS / client certs.** Rejected: heavier operationally, doesn't match the existing edge.
- **Kubernetes TokenReview / OIDC passthrough.** Rejected for identity (kept conceptually for
  the access model ADR); forward-auth already owns the user session.

# Notes

- Header default and proxy pattern verified against `github.com/motoki317/manifest`:
  `.common/traefik-forward-auth/values.yaml` emits `X-Forwarded-User` from the OIDC `name`
  field; `monitor/values-grafana.yaml` consumes it via `auth.proxy`.
