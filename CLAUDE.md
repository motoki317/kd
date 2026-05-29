# CLAUDE.md

Claude Code auto-loads this file. The full agent guide for this repo is **`AGENTS.md`** (the
cross-tool standard, also read by other agents); it is imported below so there is one source of
truth. Keep durable project rules in `AGENTS.md`, not here.

@AGENTS.md

## Self-directed improvement

For iterative, self-directed improvement work — "improve the UX", "find things to improve", running
improvement cycles, or building/working a backlog — follow the **`improvement-cycle`** skill
(`.claude/skills/improvement-cycle/`). Its core rule: a generated idea is a hypothesis — adversarially
verify it against the real code before implementing, and verify UI changes live (not just tests).
