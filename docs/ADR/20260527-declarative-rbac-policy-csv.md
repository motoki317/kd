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

Authorization is a **declarative `policy.csv` in the ArgoCD/Casbin grammar** (`p,`/`g,`
lines), enforced by a **purpose-built matcher** in `internal/rbac`, modeled closely on
ArgoCD's scheme but specialized for Kubernetes scoping.

The policy *file format* is the user-facing requirement and is kept ArgoCD-compatible. The
*engine* is hand-written rather than Casbin because kd's subject model — a caller is a
**user plus zero or more groups**, all first-class subjects, with **global deny-override**
across that whole set — is awkward to express in Casbin (which enforces one subject per call,
so cross-subject deny-override needs multiple `EnforceEx` passes and brittle matcher strings).
A small matcher that collects every rule matching any of the caller's principals and then
applies "allow if any allow-match and no deny-match" is clearer, dependency-free, and exhaustively
unit-testable.

**Model** (`p` = permission, `g` = grouping):

```
p, <subject>, <namespace-glob>, <resource-glob>, <action-glob>, <effect>
g, <subject>, <role>
```

- `subject` is a username or group from the identity header (proxy-auth ADR), or a `role:*`.
- `namespace-glob` scopes the rule (`*` = all namespaces; cluster-scoped resources are
  requested under the reserved namespace token `cluster`). Glob matching, like ArgoCD.
- `resource` is a kd resource class: `namespaces`, `workloads`, `pods`, `logs`, `events`,
  `rbac`, `nodes`, `*`. Glob-matched.
- `action` is `get` / `list` / `watch` (read verbs in v1), glob-matched.
- `effect` is `allow` / `deny` (empty defaults to `allow`, as in ArgoCD).

**Evaluation** — for a caller `{user, groups[]}`:

1. **Principals** = `{user} ∪ groups`, plus every role reachable through `g,` edges
   (transitive closure), plus the configured **default role** if non-empty.
2. **Match** all `p,` rules whose subject is a principal and whose namespace/resource/action
   globs match the request.
3. **Decide:** `deny` if any matched rule is `deny` (**global deny-override**); else `allow`
   if any matched rule is `allow`; else `deny` (no match).

**Built-in roles** (always defined, independent of the file):

```
p, role:readonly, *, *, get,   allow
p, role:readonly, *, *, list,  allow
p, role:readonly, *, *, watch, allow
p, role:admin,    *, *, *,     allow
```

**Defaults & conventions** (mirroring ArgoCD):

- `policy.default = role:readonly` — the fallback role applied to every authenticated user.
  Set it to empty for a locked-down cluster where access must be granted explicitly.
- `policy.csv` and `policy.default` are loaded from a file path (ConfigMap-mountable). The
  file is **hot-reloaded** on a polling interval (content-hash compare) so RBAC updates need
  no restart. Polling — rather than fsnotify — is robust to ConfigMap symlink-swap remounts and
  matches the kubelet's own minutes-scale mount propagation, so sub-second precision adds nothing.
- Enforcement happens in API middleware: every request resolves to
  `(subject, namespace, resource, action)` and is checked before the cache is read.
- Namespace **list filtering**: the namespace picker shows only namespaces the caller can
  `list` `pods` in (`VisibleNamespaces`), so the UI never surfaces unauthorized scopes.

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
- **Casbin.** Initially chosen (it is what ArgoCD uses) but reconsidered during implementation:
  kd's caller is a *set* of principals (user + groups) requiring global deny-override across the
  set, which Casbin's single-subject `Enforce` models awkwardly (multiple `EnforceEx` passes,
  brittle matcher strings). A ~150-line purpose-built matcher over the identical policy.csv grammar
  is clearer, dependency-free, and exhaustively unit-testable. The user-facing requirement (the
  ArgoCD-style declarative file) is fully met. Revisit Casbin if we need its richer model features.
- **Hand-rolled matcher.** Chosen — see above.

# Notes

- ArgoCD reference checked in `motoki317-manifest/argocd/values.yaml`:
  `policy.default: "role:readonly"` and `g, <uuid>, role:admin`.
- The default `policy.csv` and `policy.default` ship as built-in defaults; an operator overlays
  their own policy.csv via a mounted file path.
