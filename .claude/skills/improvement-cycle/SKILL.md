---
name: improvement-cycle
description: >-
  Use when doing self-directed, iterative improvement of this codebase — "improve the UX",
  "find things to improve", "keep improving X", run improvement cycles, or generate/work a
  backlog. Encodes how to DISCOVER improvement points yourself (by investigating source code
  and the web), adversarially VERIFY them against the real code, and IMPLEMENT them one
  verified cycle at a time. Tuned for kd's UI/UX work but the loop is general.
---

# Improvement cycle

A repeatable loop for finding and shipping improvements without a human spelling each one out. The
single most important lesson: **a generated idea is a hypothesis, not a fact — verify it against
the actual code before building.**

## The loop

`DISCOVER → VERIFY (adversarial) → RANK → IMPLEMENT one → VERIFY LIVE → TEST → COMMIT → LOG`

One improvement per commit; don't batch. Keep the backlog current so the loop survives compaction.

## 1. DISCOVER — generate candidates yourself

Two complementary sources:

- **Source code investigation** (primary, highest signal): read the focus area's files (file map
  in AGENTS.md). Look for UX gaps a user would feel, missing affordances, inconsistency with
  sibling features, fragile coupling, missing a11y, reactivity smells, dead controls, silent
  failures. Every candidate MUST cite `file:line` evidence.
- **Web / docs research** (secondary, "what good looks like"): Context7 MCP for library best
  practices; comparable tools (k9s / Lens / ArgoCD / Grafana) for UX patterns — then check whether
  kd already does it before proposing.

**Fan out with a Workflow** when the area is broad (one Explore agent per focus area returning
structured candidates, each finding piped to an independent skeptic) — only when the user has
opted into orchestration.

**Decide directions yourself — don't ask the user.** When a candidate needs a design call, make
the best decision against the four design principles + the user's stated UX values, implement it,
and note the reasoning in the commit. Do NOT pause with AskUserQuestion for feature direction —
the user wants sustained autonomous progress; iteration after shipping is cheap. Reserve questions
for destructive/irreversible actions or a hard external blocker.

## 2. VERIFY — adversarial, before building anything

For each candidate, **try to refute it** against the real code. Default to rejecting:

- `already-handled` — the code already does this (cite where).
- `wrong` — the premise misreads the code.
- `risky` — real, but the change would regress or fight an existing design choice.
- `low-value` — real, but a user wouldn't meaningfully feel it.
- `real` — genuine, correct, non-regressing, clearly felt. Only these get built.

Not optional: the refute rate was ~30% early and **~94% on a mature surface** — most generated
ideas do not survive contact with the code.

## 3. RANK

Value×effort, high-value / low-effort first, using the verifier's adjusted numbers (it saw the
real code; the proposer guessed).

## 4. IMPLEMENT one cycle

The smallest change that delivers it. Match surrounding style; comments explain WHY. Any visual
change is designed against the four design principles + explicit-over-implicit (AGENTS.md).

## 5. VERIFY LIVE

Drive the actual UI per **`docs/live-debug.md`** (demo cluster, agent-browser, measurement
pitfalls) — **measure** the thing you changed; a screenshot shows layout, an `eval` proves
behaviour. kd-specific discovery recipes and recurring bug classes: **`dogfooding-kd-ui.md`** in
this skill. Live driving has repeatedly caught bugs unit tests could not.

## 6. TEST

Add/extend a unit test for the durable contract. Mind jsdom limits (AGENTS.md): assert the DOM
contract that *enables* a behaviour and rely on live verification for the behaviour itself.

## 7. COMMIT + LOG

One Conventional Commit per cycle (git ops only per the session's standing permission); the commit
message is the durable "what + why". Then update the backlog: shipped → Done (one line), refuted →
Rejected with its verdict.

## Backlog

`docs/backlog.md` (git-tracked) feeds and records the loop. Format + lifecycle: the
**`backlog-management`** skill — don't restate its schema here. `docs/plans/` is gitignored
single-session scratch, never the backlog.

## STOP condition

When a **strict** re-survey yields ≈0 high-value `real` items, the surface is mature: stop
generating, record the maturity in the backlog's Status line, and switch to user-driven or
new-feature work. Don't grind filler cycles. Scale effort to the request — a quick "find a bug"
needs a small pass; "exhaustively improve" justifies a fan-out with multi-vote verification.
