# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks — so they
survive across agent sessions and are visible to human contributors. This is the durable home for
such tasks; `docs/plans/` is gitignored single-session scratch and must **not** hold the backlog.

How to work it: the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`) describes how
to discover, adversarially verify, and ship items; the **`backlog-management`** skill describes the
format and lifecycle of this file. The per-item evidence (`file:line`) and the verdicts are what make
an entry actionable — keep them.

**Status (2026-05-29):** The UX surface (topology, selection/edges, sidebar health, drawer/nav, logs)
is **mature** — a strict re-survey at cycle 339 yielded 16 candidates → 1 low-value (B-001). Blind UX
re-surveys now hit diminishing returns; the next batch should come from real user feedback or a new
feature area, not from re-surveying these five areas. Don't grind filler cycles — report maturity.

---

## Open

| id | area | value/effort | status | evidence | proposal |
|---|---|---|---|---|---|
| B-001 | sidebar / a11y | low / 3 lines | `real` (low-value) | `web/src/index.css` `.sidebar-retry` (~L810–827) | Add a `:focus-visible` ring — it's the lone interactive button without one (28 others have it; WCAG 2.4.7). Only reachable in the rare "couldn't load namespaces" error state. Fold into a future a11y sweep, not a standalone cycle: `.sidebar-retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }` |

## Future / larger work (not yet scheduled)

Longer-horizon items carried over from the original roadmap. Each needs its own design pass; none is a
quick improvement-cycle item.

- **Live per-namespace health for background namespaces.** The open namespace already updates from the
  SSE `summary` event (cycle 201). Background, non-selected namespaces still rely on the 15 s sidebar
  poll; scaling to thousands of namespaces would need a push channel or server-cached summaries.
- **SSE patch scaling.** Patches recompute+diff on a 300 ms window — fine today. A very large namespace
  may want field-selector informers or sharding; memory scales with object count.
- **EndpointSlice-based `selects` edges.** Currently a label-selector match; EndpointSlice would be
  more accurate.
- **Per-CRD informer stop on CRD removal.** The dynamic factory lacks per-informer stop in v1, so a
  removed CRD leaves a silently-throttled dead watch.
- **Component tests** (Vitest + `@solidjs/testing-library`) for Topology / DetailDrawer interactions —
  complements the pure-logic unit tests; would catch interaction regressions jsdom can partly cover.
- **Last-Event-ID resume** on the SSE feed; exec/attach would use WebSocket (per the SSE ADR).

## Rejected — do not re-propose

These were generated and **refuted against the real code**; re-proposing them wastes a cycle. (The
adversarial-verify step rejected ~94% of generated ideas once the surface matured — see Status above.)

| Candidate | Verdict |
|---|---|
| Persist substring filter + case-toggle across resource navigation | wrong (misreads Solid reactivity — components remount) |
| Export / download visible logs as text | low-value |
| Scroll-position bookmark on context/container switch | wrong |
| Lock aggregated pod set mid-stream; warn on new/removed pods | wrong |
| Container card click → auto-select in logs tab | low-value |
| Cmd/Ctrl+F search container cards within the drawer | low-value |
| Container state → inline health severity (restart badge as progressing) | risky |
| Container group collapse/expand | low-value |
| Multi-select resources with Shift+click, light edges between selections | risky |
| Distinguish direct vs indirect edges in selection highlight | wrong |
| Reversible/bidirectional edge hover for relationship traversal | wrong |
| Type-based edge opacity hierarchy | low-value |
| Move keyboard hints from placeholder to aria-description | low-value |
| Add modal semantics + focus trap to help overlay | wrong |
| `aria-current='page'` on active namespace button | low-value |
| Node CPU/mem allocation in the per-namespace graph | dead end — needs metrics-server + annotation scraping; not worth the coupling |
| LogViewer duplicate-tail dedup on SSE reconnect | dead end — lossy for aggregated streams (drops legitimate repeated lines) |

## Done

Cycles 313–339 plus the two direct user requests (U1: log-toolbar overflow fix; U2: per-container
drawer cards pairing status+image) all shipped and are committed. The authoritative per-cycle "what +
why" is the **git log** (`git log --oneline`). Headlines: per-level & per-pod log filters, keyboard
zoom (`=`/`-`/`0`), edge-hover endpoint halo, troubled-namespace jump pulse, jump-to-error (`Shift+E`),
help-overlay shortcut docs, aria-live match count, `boundingBox`/`fitNodeSet` refactor, pan momentum,
drawer Tab focus trap, log no-wrap toggle.
