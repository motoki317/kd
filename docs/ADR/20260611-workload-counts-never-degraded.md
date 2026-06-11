---
date: "2026-06-11"
author: "motoki317"
status: "accepted"
---

# Context

Workload health derived Degraded from replica counts: a Deployment/ReplicaSet/StatefulSet with
`readyReplicas == 0` (and a DaemonSet with `numberReady == 0`) read Degraded on the grounds that
"no ready pods = total outage, there is no partial service".

Dogfooding surfaced the false-positive side: those counts are identical during a perfectly normal
startup. A StatefulSet creates pods one at a time (OrderedReady), so its entire first rollout sits
at `ready=0` — the card glowed red while its pod was merely Progressing blue next to it. The same
shape appears on any deploy-from-zero (fresh Deployment, scale-up from 0, a DaemonSet pulling
images on every node). A read-only dashboard that flashes red on every healthy deploy trains
operators to ignore red.

The two states are genuinely count-indistinguishable per object. StatefulSets and DaemonSets carry
no failure conditions at all, and time-based discrimination ("not ready for >N minutes") would make
health a function of wall-clock that informer events don't re-evaluate.

# Decision

Replica counts alone never produce Degraded; anything between "fully rolled out" and "deliberately
scaled to zero" is Progressing. Degraded comes only from signals that declare an actual failure:

- a Pod's own failure reasons (CrashLoopBackOff, ImagePullBackOff, …) — the red lands on the pods,
  which sit beside their workload in every view and roll up into the namespace badge;
- a Deployment's `ProgressDeadlineExceeded` condition (the controller abandoned the rollout);
- a ReplicaSet's `ReplicaFailure` condition (pods cannot be created at all — quota, missing
  ServiceAccount, admission denial), newly handled, since that state has no pods to carry red.

This matches ArgoCD's health checks, which derive only Progressing from workload counts.

# Consequences

A normal first rollout, scale-up from zero, and single-replica restart read blue ("in motion"),
not red. A genuine outage still shows red where the evidence is — on the failing pods — and the
namespace attention badge still counts the trouble. The collapse-fold badge surfaces hidden
troubled pods even when a group is folded.

# Impact

`internal/kube/graph/health.go` (`replicaHealth`, `daemonSetHealth`, new `replicaSetHealth`).
A steady-state total outage whose pods are *deleted* rather than failing (e.g. evicted with
nothing rescheduling) now reads Progressing on the workload card until a pod exists to fail —
accepted: that window is short and the pending pods go Progressing→Degraded as soon as they err.

# Alternatives

- Keep `ready==0 → Degraded` but exempt "mid-rollout" objects: undecidable for StatefulSet and
  DaemonSet, which expose no rollout-failure conditions; a crashloop-from-birth never leaves the
  "mid-rollout" shape either.
- Time-based grace ("ready=0 for >5min → Degraded"): health would depend on wall-clock between
  watch events, so cards would show stale colors until the next status write re-triggered a diff.
- Rolling pod health up into the owner's health: re-introduces client/server aggregation kd
  deliberately removed (the deleted `rollupHealth`), and double-counts the same failure in the
  namespace digest.

# Notes

PodDisruptionBudget keeps its `currentHealthy < desiredHealthy → Degraded` rule: a dip below the
declared floor is the PDB's entire signal, not a startup artifact (a brand-new PDB observes the
already-running workload).
