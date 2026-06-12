---
date: "2026-06-12"
author: "@motoki317"
status: "accepted"
---

> Supersedes [Declarative RBAC via policy.csv](./_20260527-declarative-rbac-policy-csv.md).

# Context

kd's authorization was an ArgoCD/Casbin-style `policy.csv` (`p,`/`g,` lines). It met the
original "manage RBAC like ArgoCD" requirement, but it optimizes for ArgoCD familiarity, not
for the first-time human reader kd targets:

- `p`/`g` line types, the `role:` subject prefix, and positional fields are a grammar one must
  already know; nothing in the file teaches it.
- One subject string space mixes users, groups, and roles — a group named like a user silently
  matches both.
- One rule per line: scoping a team to three namespaces and four resources is twelve lines.
- A typo (`team-a` vs a misspelled role, a wrong field count only sometimes caught) tends to
  silently grant nothing rather than fail loudly.
- The "everyone gets readonly" default lived outside the file (a `-default-role` flag /
  `config.defaultRole` Helm value), so the policy file never told the whole story.

kd no longer needs ArgoCD compatibility — the requirement was revisited and dropped in favor
of "easy for a first-time human user".

# Decision

Authorization is a **declarative `policy.yaml`**, parsed and enforced by the same purpose-built
matcher in `internal/rbac`. No CSV compatibility is kept (clean break, pre-1.0).

**Format** — three concepts, no abbreviations:

```yaml
defaultRoles: [viewer]      # roles every authenticated user has; [] = lockdown

roles:                      # custom roles; viewer + admin are built in
  team-a:
    description: Read everything in team-a's namespaces, except pod logs.
    allow:
      - namespaces: [team-a-*]    # each field: a list of *-glob patterns
        resources: [pods, logs]   # omitted field = matches everything
        actions: [get, list, watch]
    deny:
      - namespaces: [team-a-*]
        resources: [logs]
  cluster-viewer:
    allow:
      - clusterScoped: true       # cluster-scoped resources (Nodes, PVs, CRDs, …)

users:                      # username (identity header) → roles
  alice: [admin]
groups:                     # group (groups header) → roles
  platform-team: [admin]

deny:                       # global guardrails — bind every caller, even admins
  - namespaces: [secure]
    resources: [logs]
```

**Evaluation** — for a caller `{user, groups[]}` the role set is
`defaultRoles ∪ users[user] ∪ groups[g…]`; a request is allowed iff some allow rule of
those roles matches it and NO deny rule (any role's, or the global block's) matches it.
Deny always beats allow, so holding an extra role can only narrow access, never widen
past another role's deny.

**Semantic changes** from the CSV model:

- **Users, groups, and roles are structurally distinct** — separate YAML maps replace the
  shared subject string space and the `role:` prefix.
- **Role-only grants.** Rules attach to roles only; users/groups are assigned roles (possibly
  several). The CSV's "attach a `p,` line directly to a user" becomes a small named role —
  same expressiveness, one concept fewer.
- **No role inheritance** (`g, role:a, role:b` is gone). Assigning multiple roles covers the
  same need without a transitive closure to reason about.
- **The global `deny` block** replaces the "attach a deny to `role:readonly` so it binds
  everyone" idiom, and binds even `admin`.
- **`defaultRoles` lives in the file**; the `-default-role` flag and `KD_DEFAULT_ROLE` are
  removed. No policy file → every authenticated user is a `viewer`. (Lockdown without a file
  is useless — nobody could see anything — so the file is the only place that needs it.)
- **Built-in roles renamed**: `role:readonly`/`role:admin` → `viewer`/`admin`.
- **Cluster scope is a first-class rule field.** `clusterScoped: true` targets cluster-scoped
  resources (Nodes, PVs, CRDs, …); combining it with `namespaces` is a load error (write two
  rules). A namespaces list — even `[*]` — never reaches cluster scope, while a rule with no
  scope field at all covers both worlds, so bare deny guardrails and the built-in roles stay
  airtight. The CSV-era implementation authorized cluster scope under the empty namespace
  `""` — unwritable in a CSV field and documented nowhere.
- **Parsing is strict and validating.** Unknown keys (typo'd field names), references to
  undefined roles, redefinition of built-in roles, and explicitly-empty pattern lists
  (`namespaces: []` would otherwise have to mean "all") are load-time errors. Hot reload keeps
  the last good policy on error, so a bad edit cannot silently change access.

**Unchanged**: the hand-rolled matcher (no Casbin/OPA), glob semantics, hot reload by content
hash, enforcement in API middleware, namespace-list filtering, the dual resource classes
(coarse class OR API group, deny-override across both), and the resource/action vocabulary.

The Helm chart carries the policy as **structured values** (`policy.defaultRoles`,
`policy.roles`, …) rendered via `toYaml` into the ConfigMap — schema-checked at install time
— instead of an opaque string block.

# Consequences

- A first-time reader can grasp a policy without a legend: `roles` / `users` / `groups` /
  `allow` / `deny` say what they are, and one rule covers many namespaces/resources/actions.
- Author mistakes fail loudly at load with actionable messages instead of silently granting
  nothing (or everything).
- The policy file is self-contained: the default role no longer hides in deployment flags.
- The breaking change is contained to deployments that mounted a `policy.csv`; the error
  message on startup makes the migration obvious (the file fails to parse as YAML).

# Impact

- kd's authz remains app-level and independent of Kubernetes RBAC (kubernetes-access-model
  ADR unchanged).
- Wrong globs can still over-grant; the test suite pins deny-override, lockdown, namespace
  scoping, and every validation error path.
- Existing `policy.csv` deployments must be rewritten by hand — deliberate; there is exactly
  one known deployment and the mapping is mechanical.

# Alternatives

- **Keep policy.csv and document it better.** Rejected: documentation cannot fix the
  one-subject-string-space ambiguity, the positional grammar, or the silent-typo failure mode.
- **Support both formats during a transition.** Rejected: two parsers and two doc sections
  forever, for one known deployment.
- **Scalar-or-list convenience fields** (`namespaces: team-a-*`). Rejected: two spellings for
  one meaning complicates the docs and the values schema; flow lists (`[team-a-*]`) are cheap.
- **Role inheritance / rules attached directly to users.** Rejected for v1: multiple role
  assignment covers the need with fewer concepts. Revisit if real policies grow unwieldy.
- **A pseudo-namespace token for cluster scope** (`namespaces: [cluster]`). Implemented
  first, rejected before release: it collides with a real namespace named `cluster` and
  smuggles a magic keyword into a field that otherwise holds plain namespace names. A
  schema-validated boolean is unambiguous and lets glob lists mean exactly what they say.
- **OPA/Rego, Casbin.** Still rejected for the same reasons as the original ADR — kd's caller
  is a set of principals with global deny-override; a ~150-line matcher is clearer and
  dependency-free.

# Notes

- Parser: `sigs.k8s.io/yaml` (already a dependency) with `UnmarshalStrict`.
- `viewer` = `get/list/watch` on everything; `admin` = `*` on everything. Actions beyond the
  read verbs exist only for future-proofing — kd is read-only today.
- The wire/API surface is untouched; only `internal/rbac`'s input format and the cluster-
  scope mapping in `internal/api` changed (`internal/api` passes `rbac.ClusterScope`, an
  impossible-as-namespace sentinel, never a policy-author-visible token).
