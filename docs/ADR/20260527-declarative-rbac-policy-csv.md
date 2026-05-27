---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

kd serves both cluster-wide operators and app developers. They need different scopes: an
operator sees everything, a developer sees only their team's namespaces. The user wants
**declarative RBAC managed like ArgoCD's `policy.csv`** — a single file, GitOps-friendly,
mountable from a ConfigMap, reviewable in PRs. ArgoCD's RBAC is built on **Casbin**.

# Decision

Authorization is a **declarative `policy.csv`** enforced by **Casbin**, modeled closely on
ArgoCD's scheme but specialized for Kubernetes scoping.

**Model** (`p` = permission, `g` = grouping):

```
p, <role/subject>, <namespace-glob>, <resource>, <action>, <effect>
g, <subject>, <role>
```

- `subject` is a username or group from the identity header (proxy-auth ADR), or a `role:*`.
- `namespace-glob` scopes the rule (`*` = all namespaces, cluster-scoped resources use a
  reserved key such as `cluster`). Glob matching, like ArgoCD.
- `resource` is a kd resource class: `namespaces`, `workloads`, `pods`, `logs`, `events`,
  `rbac`, `nodes`, `*`.
- `action` is `get` / `list` / `watch` (read verbs only in v1).
- `effect` is `allow` / `deny`; explicit `deny` overrides `allow`.

**Defaults & conventions** (mirroring ArgoCD):

```
policy.default = role:readonly        # fallback role for any authenticated user
# Built-in roles:
p, role:readonly, *, *, get,   allow
p, role:readonly, *, *, list,  allow
p, role:readonly, *, *, watch, allow
p, role:admin,    *, *, *,     allow
```

- `policy.csv` and `policy.default` are loaded from a file path (ConfigMap-mountable). The
  file is **hot-reloaded** on change (fsnotify) so RBAC updates need no restart.
- Enforcement happens in API middleware: every request resolves to
  `(subject, namespace, resource, action)` and is checked before the cache is read.
- Namespace **list filtering**: the namespace picker shows only namespaces the subject can
  `list` `workloads`/`pods` in, so the UI never surfaces unauthorized scopes.

# Consequences

- One reviewable file expresses the whole authorization policy; changes are GitOps PRs.
- Familiar to anyone who has used ArgoCD RBAC; the format and `role:readonly`/`role:admin`
  defaults match expectations.
- Decoupled from Kubernetes RBAC, so kd can grant fine-grained dashboard-only views without
  touching cluster RBAC.

# Impact

- kd's authz is **independent of** Kubernetes RBAC — see the kubernetes-access-model ADR for
  why app-level authz (not impersonation) is the v1 choice and the trust implications.
- A wrong glob can over-grant; tests must cover deny-override and namespace scoping.

# Alternatives

- **Kubernetes SubjectAccessReview / impersonation.** Deferred — discussed in the access-model
  ADR. Doesn't satisfy the "ArgoCD policy.csv" requirement and needs per-user cluster RBAC.
- **OPA/Rego.** Rejected for v1: more powerful but heavier and unfamiliar versus the explicit
  policy.csv the user asked for.
- **Hand-rolled matcher.** Rejected: Casbin is what ArgoCD uses, is well-tested, and supports
  glob + deny-override out of the box.

# Notes

- ArgoCD reference checked in `motoki317-manifest/argocd/values.yaml`:
  `policy.default: "role:readonly"` and `g, <uuid>, role:admin`.
- Casbin model file (`rbac_model.conf`) and the default `policy.csv` ship embedded; an
  operator overlays their own policy.csv via mount.
