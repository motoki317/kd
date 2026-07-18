# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks, so they
survive across agent sessions and stay visible to human contributors. `docs/plans/` is gitignored
single-session scratch and must **not** hold the backlog. How to work it: the **`improvement-cycle`**
skill (discover → adversarially verify → ship) and the **`backlog-management`** skill (format +
lifecycle). The per-item `file:line` evidence and verdicts are what make an entry actionable — keep them.

**Status (2026-06-10):** The UX and server surfaces are **mature** — delegated re-surveys now refute
~94% of generated candidates. Source new work from real user feedback or a new feature area, not
filler re-surveys; do NOT re-dogfood a surface marked mature below unless its code changed. Durable
techniques live in `docs/live-debug.md` + the `improvement-cycle` skill (`dogfooding-kd-ui.md`),
client traps in `docs/client-gotchas.md`, and UI policy in `docs/design.md`; code traps live at their
owning sites.

**Verified mature (don't re-survey without code changes):** Events tab · Logs panel (incl. phone width)
· search + keyboard flows · help overlay · manifest find (term/marks survive format toggle) · Network +
Volumes projections · RBAC + Disruption + Monitoring projections (binding→role→SA spotlight; PDB
guards chain; scrape→service, all walked live 2026-06-10) · cluster scope at 666 resources · context
switching · churn pan-preservation · j/k triage flow · drawer expand mode · offline/dropped-stream trio
· capacity view at production scale (incl. node-name → drawer) · relationship/kind-filter compose ·
owner-chip navigation + Alt+Left · rollout rendering · scale robustness (354-node namespace, 57
Degraded) · client core (App.tsx/api.ts SSE wiring, surveyed 0/11) · canvas layout math
(layout.ts/capacityLayout.ts/Topology.tsx, surveyed) · light theme (all views + drawer, token-driven)
· first-run landing · the bootstrap-failure terminal states (unreachable context / no-access /
not-signed-in, each live-verified) · auth+rbac (security-lens survey, 0 real) · client utils
(logs/names/search/ansi/favicon/health/usageAggregate/resourceBars, surveyed 0/8) · beginner
emergency shapes (unschedulable, ImagePullBackOff, OOM crashloop, failed Workflow).

Small deferrals (reopen on operator ask): per-line truncation for multi-KB log
lines; logs-header chip stacking at phone width; co-routed multi-type edges draw identical paths;
drawer-overlay Tab-bleed at phone width + modal-help inert siblings; TopologyToolbar extraction;
manifest format-toggle drops the find scroll anchor; one unreproduced ghost-clear on SSE reconnect
(watch for it); Volumes-lens typed/depth-limited spotlight walk (regression risk to the ownership
spotlight).

## Open

- **Process memory — remaining levers** — *measured 2026-06-14 during the 2026-06 memory pass;
  deferred, diminishing returns.* Idle heap after the 2026-06 memory pass is ~39 MiB (≈21 MiB cached
  objects + ≈14 MiB client-go per-watch machinery
  across ~150 informers); alloc churn is ~76% `buildGraph`, dominated by the unstructured→typed
  conversion run per object per SSE rebuild. Levers, each measured-and-deferred: **memoize the typed
  conversion** (rejected for memory — retains both forms and raises steady heap; CPU-only play);
  **share one graph build across same-namespace SSE viewers** (~1.3 MiB/viewer peak; a concurrency
  change in the SSE hot path, ROI load-dependent); **elide informers for empty kinds** (sheds
  per-watch machinery but risks missing a kind's first object — architecture change); **strip Secret
  data VALUES from the cache** (kd never shows values; must compute per-key sizes at strip time or
  `dataKeys` in spec_storage.go shows "0 B"). Workload `spec.template` is NOT strippable —
  `fields.go` reads it for workload→ConfigMap/Secret/PVC edges. **Reopen when:** a cluster reports
  memory pressure after the 2026-06 memory pass, or many concurrent viewers of one namespace make
  build-sharing concrete.

- **Canvas card text under the design language (`docs/design.md`)** — *deferred (geometry retune).* Card names/kinds
  keep Plex Sans at pre-overhaul sizes (`.node-kind` 10px caps, `.node-name` 13px): the sizes are
  zoom-coupled to fixed card geometry, and mono (~7.8px/char vs sans ~6.1) would overflow the
  char-count-tuned card widths (`names.ts` CARD_* constants). Moving canvas names to mono needs a
  joint retune of card width + truncation counts + fold-pill width, verified at production scale.
  **Reopen when:** canvas card geometry is being touched anyway, or the sans/mono split on cards
  starts reading as inconsistent in practice.

- **Large-graph empty gutter after a window shrink** — *verified live (2026-06-05), deferred — touches
  heavily-tuned pan-clamp behaviour.* For a graph wider than the viewport, `clampTranslate`
  (`Topology.tsx`) guarantees only "≥60px of graph visible", not "viewport covered", so a shrink
  (1280→700) can leave a large empty gutter beside an overflowing graph. The fix (for
  `w ≥ rect.width`, clamp so the viewport stays covered) also changes how a large graph pans, and
  pan/zoom feel is user-iterated territory; window resizes mid-session are rare, and the dominant
  resize (drawer open) is owned by selection-fit. **Reopen when:** the user wants the graph
  re-anchored on resize, or confirms large-graph pan should never expose empty gutter; then split
  `clampTranslate` into small-graph (keep-visible) vs large-graph (keep-covered) bounds + tests.

- **GRPCRoute has routing edges but no drawer routing table** — *low value, deferred.*
  `gatewayRouteEdges` already emits `EdgeRoutes` for a GRPCRoute's `backendRefs`, but the drawer's
  `routes()` table only handles HTTPRoute; a faithful GRPCRoute table would render
  `helloworld.Greeter/SayHello → svc:port` from `spec.rules[].matches[].method`. Deferred because
  gRPC ingress is absent on the reachable clusters and the topology edge already lands. **Reopen
  when:** a cluster here adopts GRPCRoute — add a `grpcRouteMatches` branch mirroring
  `httpRoutePaths`, fixture-tested.

## Future / larger work — deferred (examined, not actionable now)

Each entry cites why it is longer-horizon and the signal that should reopen it, so a future agent
inherits the analysis.

- **SSE patch scaling** — *premature.* Patches recompute+diff on a 300 ms window; no observed pain.
  Field-selector informers / sharding would break the ride-along invariant the health rollup depends
  on, so they need an ADR. The real large-namespace bottleneck is client-side Dagre layout, not the
  server rebuild. *Reopen when:* a profiler shows the server rebuild as the bottleneck on a real
  workload.
- **EndpointSlice-based `selects` edges** — *real, high regression risk.* EndpointSlice is more
  accurate than label-selector matching (ready endpoints, named ports, selectorless services), but
  adoption needs three decisions first: eager vs lazy load (cardinality is 10–100× Services), legacy
  Endpoints v1 support, and whether the edge model grows a `port` dimension (backward-incompatible).
  *Reopen when:* operators on large clusters need accurate endpoint readiness — start with an ADR.
- **Timeline / history view** — *different product tier.* kd is a LIVE view on informer caches; a
  "when did it degrade" time axis needs historical-state persistence (store + retention + scrubber
  UI) — a new subsystem, not a cycle. A dashboard survey (2026-06-05) found this the ONE pattern kd
  lacks vs peers. *Reopen when:* the product wants post-mortem analysis; start from an ADR.
- **Last-Event-ID resume on the SSE feed** — *low value.* The reconnect path re-snapshots, which is
  idempotent (`graphState.fromSnapshot` + `reconcile`) and cheap (~100 ms); real resume needs a
  server-side patch ring buffer + overflow fallback for a payoff re-snapshot already delivers.
  *Reopen when:* a streaming-v2 effort is on the table anyway (e.g. exec/attach over WebSocket).
- **Manifest syntax highlighting** — *dependency/bug cost on a secondary view.* Needs a highlighter
  dependency (bundle cost) or a hand-rolled YAML+JSON tokenizer (real edge cases), for a
  drill-into-raw view where in-manifest find already locates fields and plain output matches
  `kubectl`. *Reopen when:* operators report the manifest is hard to scan — then prefer a
  dependency-free "dim the keys" pass, verified against the format toggle + find overlay.
- **Collapse non-leaf same-kind siblings** — *effectively absent in the model.* Connectivity collapse
  folds only degree-1 leaves; >8 subtree-owning same-kind siblings under one parent don't occur in
  kd's graph, and synthesizing bundle edges is real risk for no benefit. *Reopen when:* a concrete
  graph shape shows it.
