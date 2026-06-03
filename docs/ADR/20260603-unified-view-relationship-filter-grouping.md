---
date: "2026-06-03"
author: "@motoki317"
status: "accepted"
---

# Context

kd originally exposed six hardcoded topology **views** (Ownership, Network, Nodes, Volumes, RBAC,
All) as mutually-exclusive tabs. Each view was the pairing of (a) a server-side `Filter(view)` that
projected the relationship graph onto a fixed subset of edge types — keeping only the kinds and edges
that view cared about, with a couple of edges reversed (`refers` → referenced-as-parent) — and
(b) a client layout function. See the resource-relationship-graph ADR for the underlying graph.

That model was rigid in two ways. An operator could not see two relationship dimensions at once
(e.g. ownership *and* network arrows on the same canvas); and the layout strategy was welded to the
relationship set, even though "how resources are arranged" (a tree vs host containers vs kind boxes)
is conceptually independent of "which relationships are drawn". The view list was also a closed enum
the server had to know about.

# Decision

Replace the six fixed views with two **orthogonal, composable, client-side** controls, and have the
server stream the **full** graph (every relationship) with no per-view projection.

- **Group-by** (`GroupBy` = `relationship` | `nodes` | `kind`, default `relationship`): the layout
  strategy. `relationship` → depth-column relationship tree (`layoutGraph`, LR); `nodes` →
  host containers (`layoutGraphByHost`); `kind` → per-kind boxes (`layoutGraphByKind`).
- **Relationship filter** (`RelCategory` = ownership / network / volumes / rbac / scheduling): a
  composable set of toggle chips, each mapping to one or more `EdgeType` (`web/src/relationships.ts`).
  Several can be active at once. The client's `projectEdges(edges, relFilter)` keeps the matching
  edges (reversing `refers`) and that projection drives the **layout only**; selection-spotlight
  (`related()`) and owner-prefix name shortening (`ownerName()`) keep walking the full edge set, so
  they stay relationship-agnostic. Resources untouched by the active relationships fall out as
  per-kind orphan blocks (the existing fold machinery), so the canvas stays a complete inventory.

The server's `graph.View` / `viewSpec` / `viewSpecs` / `ParseView` / `Filter` are removed; the SSE
stream and `/graph` endpoint always return `Build(...)` unfiltered. Both controls persist to
`localStorage` (`kd:groupBy`, `kd:rels`) and the URL (`?group=`, `?rels=`; an explicit empty
`?rels=` is a real "no relationships" state).

# Consequences

- Relationships compose: ownership + network + RBAC arrows can share one canvas.
- Grouping and relationships vary independently — 3 × 2⁵ combinations from two small controls,
  versus six fixed points.
- The server is simpler (one graph shape, no view enum); all projection logic lives in one place
  (`relationships.ts`) on the client, next to where it is rendered.
- Toggling a relationship re-projects the *same* already-streamed graph with no resubscribe.

# Impact

- Client: `App.tsx` (state, topbar group-by control, URL/localStorage, keyboard 1–3, help),
  `Topology.tsx` (`displayEdges` projection, `groupBy` dispatch, relationship toolbar chips,
  auto-fit), new `relationships.ts`, `types.ts` (`GroupBy`/`RelCategory` replace `View`), `api.ts`
  (drop the `view` param). Server: `filter.go`, `sse.go`, `api.go`.
- Auto-fit risk addressed: a relationship/group-by change does **not** resubscribe SSE, so unlike a
  namespace switch there is no empty frame to gate the fit on. The fit effect keys on `scope`
  *and* a client `layoutKey` (`groupBy` + sorted `relFilter`); a client-only restructure fits the
  next frame immediately rather than waiting for a graph reset that never comes.
- Node visibility in relationship grouping is "show all, orphans folded" — the same complete-
  inventory behavior the old Ownership view adopted, now applied for any relationship selection.

# Alternatives

- **Raw edge-type toggles** (8 buttons) instead of semantic categories: rejected as too granular and
  jargon-heavy; categories match the operator's mental model and stay composable.
- **Server-side projection per request**: rejected — relationship toggles are interactive and
  composable, so round-tripping every toggle is wasted latency when the full graph is already small
  and already streamed for the old All view.
- **Keep grouping welded to the relationship set** (just allow multi-select edges): rejected — the
  two axes are genuinely independent and separating them is what unlocks the combinations.

# Notes

Supersedes the per-view `Filter` portion of the resource-relationship-graph ADR; the graph *model*
(typed `{nodes, edges}`) is unchanged. The empty-relationship state degenerates to a per-kind folded
inventory, which is a legitimate "just the resources" view rather than an error.
