---
name: backlog-management
description: >-
  Use when creating, grooming, or working a persistent improvement backlog — adding or triaging an
  item, recording why an idea was rejected, marking work done, deciding where a long-lived task should
  live, or grooming stale entries. For this repo the backlog is the git-tracked docs/backlog.md. Reach
  for this skill whenever you are about to write down a future task, a tech-debt note, or a "we should
  eventually…" item, even if the user doesn't say the word "backlog" — durable tasks belong here, not
  in throwaway scratch. Pairs with the improvement-cycle skill, which discovers and ships the items
  this skill files.
---

# Backlog management

Owns the shape and hygiene of the persistent improvement backlog so longer-lived tasks survive across
agent sessions and stay visible to humans. The sibling **`improvement-cycle`** skill runs the
discover → verify → ship loop that *feeds and consumes* this file; this skill is only about the
file itself — where it lives, its sections, and how an entry moves through its lifecycle.

## Where the backlog lives — and why it matters

The backlog is **`docs/backlog.md`**, and it must be **git-tracked**. A backlog only earns its keep if
it outlives any single session (and any context compaction) *and* a human can read it in review. That
rules out gitignored scratch: `docs/plans/` is volatile single-session working space and must never
hold the backlog or any long-term task (see AGENTS.md "Where durable state lives").

Tracked is not automatic. A new `docs/backlog.md` shows up as untracked (`??`) until someone runs
`git add`, so the "git-tracked" claim is aspirational until the file is actually staged. If you create
or first populate it, confirm `git ls-files docs/backlog.md` lists it (and commit it when the user
asks) — otherwise the next session won't see it.

## The file is the template

Don't restate the schema here — read **`docs/backlog.md`** itself; its header documents the layout and
its live contents are the worked example. Describing the format in two places is exactly how the old
improvement-cycle skill drifted out of sync. The file has four sections, each used at a different
moment:

- **Open** — actionable items, as a table: `id | area | value/effort | status | evidence | proposal`.
  Every row carries `file:line` evidence and, once checked, a verifier verdict
  (`already-handled` / `wrong` / `risky` / `low-value` / `real`). The evidence and verdict are what
  make a row actionable — an entry without them is just a wish; don't add it.
- **Future / larger work** — prose bullets for items that each need their own design pass, not a quick
  cycle (e.g. a new push channel, an informer-lifecycle change). Keep these out of Open so the loop
  doesn't try to one-shot them.
- **Rejected — do not re-propose** — a `candidate | verdict` table of ideas refuted against the real
  code. This is the anti-rework memory: without it, future surveys regenerate the same losers (at a
  mature surface ~94% of generated ideas get refuted). Always record the one-line verdict.
- **Done** — a short headline pointer that **defers to `git log --oneline`** as the authoritative
  per-item "what + why." Don't recopy commit prose into the backlog; the commit already is the record.

## Lifecycle of an entry

- **Seed** Open from a discover + adversarial-verify pass (the improvement-cycle skill produces these).
  An idea reaches Open only after verify rules it `real`, with `file:line` evidence attached.
- **Work** top-down by value/effort (high-value / low-effort first).
- **Ship** → move the row to Done as a one-line headline; the git commit holds the durable detail, so
  don't duplicate it.
- **Refute** → move the candidate to Rejected with its verdict, so it's never re-proposed.
- **Groom** → when an Open item is overtaken by a code change, or a Future item is no longer wanted,
  remove or re-file it rather than leaving stale rows; a backlog people stop trusting is dead weight.

## Status / maturity line

Keep a dated **Status** line at the top recording when a surface is mature — e.g. kd's UX surface hit
16 candidates → 1 low-value at cycle 339. A fresh session reads this first and avoids grinding filler
re-surveys; it's the signal to source the next batch from real user feedback or a new feature area.

## Porting to another repo

The reusable part is the *shape*: git-tracked, triaged Open/Future/Rejected/Done, per-entry evidence,
a rejected-list, and a Done section that defers to the git log. The concrete path (`docs/backlog.md`)
and kd's focus areas are project-specific — keep the principle, swap the specifics.
