---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

kd needs to read cluster state and stream pod logs. Two models exist for how a dashboard
talks to the Kubernetes API on behalf of users:

1. **App-level authz** — kd uses one ServiceAccount with broad read access, and enforces
   per-user visibility itself (this is how ArgoCD works).
2. **Impersonation / passthrough** — kd forwards each user's identity to the API server
   (`Impersonate-User`) or uses the user's own credentials, so Kubernetes RBAC decides.

The user explicitly wants ArgoCD-style declarative RBAC (policy.csv), which presumes model 1.

# Decision

kd uses **a single read-only ServiceAccount** and performs **all authorization at the
application layer** via policy.csv (see declarative-rbac-policy-csv ADR).

- The ServiceAccount is bound to a `ClusterRole` granting **read verbs only**
  (`get`/`list`/`watch`) on the resource types kd visualizes, plus `pods/log`. No mutating
  verbs in v1.
- Informers run under this ServiceAccount and populate the shared cache once; all users read
  filtered views of that cache, gated by policy.csv. This is what makes a single shared cache
  (architecture-overview ADR) possible.
- The ClusterRole is shipped as a manifest so operators can review and trim it.

# Consequences

- Enables the shared informer cache and the declarative policy.csv model the user wants.
- One predictable identity to audit in the cluster; kd's own access is easy to reason about.
- Developers get dashboard visibility without needing individual Kubernetes RBAC bindings.

# Impact

- **Confused-deputy risk:** kd can read anything its ServiceAccount can, so kd's own authz is
  the only thing protecting users from over-broad access. This raises the stakes on RBAC
  correctness (covered by tests) and on the proxy-auth trust boundary.
- kd's view can exceed any individual user's native Kubernetes permissions; this is by design
  (like ArgoCD) and must be documented for operators.
- Secret values are sensitive: v1 will **not** expose Secret `data` contents (only metadata),
  to limit blast radius of the broad ServiceAccount.

# Alternatives

- **Impersonation (`Impersonate-User`/`-Group`).** Rejected for v1: defeats the shared cache
  (per-user authz means per-user watches or per-request SAR), requires every user to have
  Kubernetes RBAC, and doesn't fit policy.csv. Strong candidate for a future "strict mode".
- **User-credential passthrough (OIDC token to API server).** Rejected: forward-auth holds an
  app session, not necessarily a token the API server trusts; couples kd to cluster OIDC.

# Notes

- Future "strict mode" could add SubjectAccessReview checks layered on top of policy.csv for
  defense-in-depth, or per-request impersonation for high-security clusters.
