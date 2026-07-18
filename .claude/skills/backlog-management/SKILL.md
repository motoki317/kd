---
name: backlog-management
description: >-
  Use when creating, grooming, or working a persistent improvement backlog — adding or triaging an
  item, refuting a candidate, deciding where a long-lived task should
  live, or grooming stale entries. For this repo the backlog is the git-tracked docs/backlog.md. Reach
  for this skill whenever you are about to write down a future task, a tech-debt note, or a "we should
  eventually…" item, even if the user doesn't say the word "backlog" — durable tasks belong here, not
  in throwaway scratch. Pairs with the improvement-cycle skill, which discovers and ships the items
  this skill files.
---

# Backlog management

Owns the shape and hygiene of the persistent improvement backlog. The sibling
**`improvement-cycle`** skill runs the discover → verify → ship loop that feeds and consumes the
file; this skill governs the backlog lifecycle and where refuted candidates go.

## Where it lives

**`docs/backlog.md`**, **git-tracked** — a backlog only earns its keep if it outlives any single
session and a human can read it in review. `docs/plans/` is volatile single-session scratch and
must never hold it. Tracked is not automatic: a new file is untracked until `git add` — confirm
with `git ls-files docs/backlog.md`, or the next session won't see it.

## The file is the template

Don't restate the schema here — `docs/backlog.md`'s header documents the layout and its live
contents are the worked example (describing the format in two places is how docs drift). Two
sections:

- **Open** — actionable items: `id | area | value/effort | status | evidence | proposal`. Every
  row carries `file:line` evidence and a verifier verdict — an entry without them is a wish; don't
  add it.
- **Future / larger work** — prose bullets that each need their own design pass, kept out of Open
  so the loop doesn't one-shot them.

## Lifecycle

- **Seed** Open from a discover + adversarial-verify pass — only `real`-verdict items, with
  evidence.
- **Work** top-down by value/effort. **Ship** → delete the row; the commit/PR is the record.
  **Refute** → add a terse constraint at the owning code site only for a durable invariant;
  otherwise drop the candidate. The survey or commit is the record.
- **Groom** — remove or re-file rows overtaken by code changes; a backlog people stop trusting is
  dead weight.

Keep a dated **Status** line at the top recording when a surface went mature — a fresh session
reads it first and skips filler re-surveys.

Porting to another repo: the reusable part is the shape (tracked, two sections, per-entry
evidence); the path and focus areas are kd-specific.
