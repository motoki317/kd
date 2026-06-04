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

A repeatable loop for finding and shipping improvements without a human spelling each one out. It
exists because a long UX-improvement campaign on kd (cycles 313–339) converged on this process. The
single most important lesson: **a generated idea is a hypothesis, not a fact — verify it against the
actual code before building.**

## The loop

`DISCOVER → VERIFY (adversarial) → RANK → IMPLEMENT one → VERIFY LIVE → TEST → COMMIT → LOG`

Run one improvement per commit. Don't batch. Keep a backlog so the loop survives compactions (see
"Backlog" below).

## 1. DISCOVER — generate candidates yourself

Two complementary sources; use both:

**Source code investigation** (primary, highest signal):
- Read the files for the focus area (for kd UI, the 5 areas: topology/layout, selection+edge
  highlighting, sidebar/health, drawer/nav, logs — see AGENTS.md for file map).
- Look for: UX gaps a user would feel, missing affordances, inconsistency with sibling features,
  duplicated logic / fragile coupling worth a refactor, missing a11y (focus rings, aria-live,
  keyboard paths), reactivity smells, dead controls, silent failures.
- Every candidate MUST cite `file:line` evidence that the gap is real.

**Web / docs research** (secondary, for "what good looks like"):
- Use Context7 MCP for current library/framework best practices (Solid, dagre, SVG, a11y APIs).
- Web search for UX patterns in comparable tools (e.g. how k9s / Lens / ArgoCD / Grafana solve
  the same problem) — then check whether kd already does it before proposing.

**Fan out with a Workflow** when the area is broad. The pattern that worked: one `Explore`-agent
per focus area returning structured candidates (`{title, area, files, problem, proposal, effort,
value, evidence}`), piped straight into the verify stage, each finding then handed to an independent
skeptic. Only run a Workflow when the user has opted into orchestration.

## 2. VERIFY — adversarial, before building anything

For each candidate, **try to refute it** against the real code. Default to rejecting. Open the
cited files and decide:

- `already-handled` — the code already does this (cite where).
- `wrong` — the premise misreads how the code behaves.
- `risky` — real, but the change would regress or fight an existing design choice.
- `low-value` — real, but a user wouldn't meaningfully feel it.
- `real` — genuine, correct, non-regressing, clearly felt. Only these get built.

This step is not optional. Empirically the false-positive rate was ~30% early and **~94% once the
surface matured** — most generated ideas do not survive contact with the code. Skipping verify
means building plausible-but-wrong changes. When fanning out, give each finding an independent
skeptic (or a panel) prompted to refute.

## 3. RANK

Sort surviving candidates by value×effort (high-value / low-effort first). Record adjusted
value+effort from the verifier (it saw the real code; the proposer guessed).

## 4. IMPLEMENT one cycle

Make the smallest change that delivers the improvement. Match surrounding code style. Comments
explain WHY (non-obvious), never WHAT — see AGENTS.md conventions. For any **visual** change, design
against the **four design principles** (proximity, alignment, repetition, contrast) + explicit-over-
implicit — see "UI design principles" in AGENTS.md.

## 5. VERIFY LIVE

Drive the **actual UI** with the **`agent-browser`** CLI (NOT playwright), not just tests — see
"Verifying UI changes live (agent-browser)" in AGENTS.md (build → run `./kd -dev-user dev -addr :8099`
→ `agent-browser open/eval/screenshot/close`). **Measure** the thing you changed (class applied,
computed fill, element in bounds, count, order) — a screenshot shows layout, an `eval` proves
behaviour. For kd-specific recipes (capacity-view expand/click/hover) and the **recurring bug classes**
caught live — fit-zoom direction, viewport-edge clipping of overlays/tooltips, SVG hit-targets — plus a
"don't re-propose" list of verified-risky Nodes-view changes, see **`dogfooding-kd-ui.md`** in this skill. **Dogfood against a real cluster** (`?ctx=<arn>`) for production-scale shapes a local
cluster can't reproduce — keeping the real name out of tracked files. Live verification has
repeatedly caught bugs unit tests could not (keyboard-zoom presses coalescing; toolbar overflow; a
min-segment overshoot that only shows with many tiny pods on one node).

## 6. TEST

Add/extend a unit test for the durable contract. Tests explain WHAT. Mind jsdom limits (AGENTS.md):
some behavior (focus traps, scroll, animation) isn't testable in jsdom — assert the DOM contract
that *enables* it and rely on live verification for the behavior.

## 7. COMMIT + LOG

One Conventional Commit per cycle (git ops only when the user has asked, or per the session's
standing permission). The commit message is the durable per-cycle "what + why" record — write it
well. Then reflect the result in the backlog: move the shipped item to Done (one line, no need to
repeat the commit prose), and move any refuted candidate to Rejected with its verdict.

## Backlog

The loop is fed and recorded by the persistent backlog at **`docs/backlog.md`** (git-tracked).
Seed it from a DISCOVER+VERIFY pass, work it top-down, re-survey when it empties. For the file's
sections, per-entry format, and lifecycle, defer to the **`backlog-management`** skill rather than
restating them here — keeping the schema in one place is what stops the two from drifting apart.
Note that `docs/plans/` is volatile single-session scratch (gitignored): fine for working notes
during a session, but the durable backlog and long-term tasks never live there.

## STOP condition

When a **strict** re-survey of the focus area yields ≈0 high-value `real` items (as happened at
kd cycle 339: 16 candidates → 1 low-value), the surface is mature. **Stop generating** — switch to
user-driven or new-feature-driven work. Do not grind filler cycles to hit a number; report the
maturity finding instead (record it in the backlog's Status line). Scale effort to the request: a
quick "find a bug" needs a small pass; an "exhaustively improve" request justifies a larger fan-out
with multi-vote adversarial verification.
