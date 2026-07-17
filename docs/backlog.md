# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks, so they
survive across agent sessions and stay visible to human contributors. `docs/plans/` is gitignored
single-session scratch and must **not** hold the backlog. How to work it: the **`improvement-cycle`**
skill (discover → adversarially verify → ship) and the **`backlog-management`** skill (format +
lifecycle). The per-item `file:line` evidence and verdicts are what make an entry actionable — keep them.

**Status (2026-06-10):** The UX and server surfaces are **mature** — delegated re-surveys now refute
~94% of generated candidates. Source new work from real user feedback or a new feature area, not
filler re-surveys; do NOT re-dogfood a surface marked mature below unless its code changed. Durable
techniques live in the `improvement-cycle` skill (`dogfooding-kd-ui.md`), recurring traps in AGENTS.md.
**Current focus (user-set, 2026-06-10): beginner-first** — short UI texts, prune excess features/docs,
structural cleanup over micro-edits.

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

Batch history: ~39 dogfooding/refactor batches (2026-05-29 → 2026-06-15) shipped through this file.
Their narratives live in the `docs(backlog)` commits and the git log; their walked-surface evidence
is in "Verified mature" above; their refuted ideas are in Rejected below. Do not regrow a batch list
here.

Small deferrals from those batches (reopen on operator ask): per-line truncation for multi-KB log
lines; logs-header chip stacking at phone width; co-routed multi-type edges draw identical paths;
drawer-overlay Tab-bleed at phone width + modal-help inert siblings; TopologyToolbar extraction;
manifest format-toggle drops the find scroll anchor; one unreproduced ghost-clear on SSE reconnect
(watch for it); Volumes-lens typed/depth-limited spotlight walk (regression risk to the ownership
spotlight — see the PVC-spotlight row in Rejected).

## Open

- **Process memory — remaining levers** — *measured 2026-06-14 (b36); deferred, diminishing returns.*
  Idle heap after b36 is ~39 MiB (≈21 MiB cached objects + ≈14 MiB client-go per-watch machinery
  across ~150 informers); alloc churn is ~76% `buildGraph`, dominated by the unstructured→typed
  conversion run per object per SSE rebuild. Levers, each measured-and-deferred: **memoize the typed
  conversion** (rejected for memory — retains both forms and raises steady heap; CPU-only play);
  **share one graph build across same-namespace SSE viewers** (~1.3 MiB/viewer peak; a concurrency
  change in the SSE hot path, ROI load-dependent); **elide informers for empty kinds** (sheds
  per-watch machinery but risks missing a kind's first object — architecture change); **strip Secret
  data VALUES from the cache** (kd never shows values; must compute per-key sizes at strip time or
  `dataKeys` in spec_storage.go shows "0 B"). Workload `spec.template` is NOT strippable —
  `fields.go` reads it for workload→ConfigMap/Secret/PVC edges. **Reopen when:** a cluster reports
  memory pressure after b36, or many concurrent viewers of one namespace make build-sharing concrete.

- **Canvas card text under the b35 design language** — *deferred (geometry retune).* Card names/kinds
  keep Plex Sans at pre-overhaul sizes (`.node-kind` 10px caps, `.node-name` 13px): the sizes are
  zoom-coupled to fixed card geometry, and mono (~7.8px/char vs sans ~6.1) would overflow the
  char-count-tuned card widths (`names.ts` CARD_* constants). Moving canvas names to mono needs a
  joint retune of card width + truncation counts + fold-pill width, verified at production scale.
  **Reopen when:** canvas card geometry is being touched anyway, or the sans/mono split on cards
  starts reading as inconsistent in practice.

- **Large-graph empty gutter after a window shrink** — *verified live (cycle 40), deferred — touches
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
  UI) — a new subsystem, not a cycle. A dashboard survey (cycle 59) found this the ONE pattern kd
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

## Rejected — do not re-propose

Generated and **refuted against the real code**; re-proposing them wastes a cycle. (~94% of generated
ideas get refuted once a surface matures — see Status.)

| Candidate | Verdict |
|---|---|
| Split LogViewer's toolbar (or panel) into its own component | rejected (2026-06-10) — the toolbar JSX reads 9+ signals of one cohesive stream/buffer state machine; extraction means ~18 drilled props. No clean state seam, unlike KindFacts/ManifestPanel |
| Hardcoded short labels for vendor CRDs without API shortNames | rejected (2026-06-10) — any code would be invented, a per-vendor list with no canonical source, and worse than the truncated real prefix; hover + drawer carry the full name |
| Collapse a container's identical Req+Lim bars into one "Req=Lim" bar | rejected (2026-06-10) — the 34px sublabel track can't fit it, variable row counts break the cross-card repetition idiom, and two equal bars already read "req = lim" |
| Flag an Unavailable APIService | already-handled (2026-06-06) — `crHealthFromConditions` reads `Available` (False → Degraded) and surfaces its message |
| Unknown `?ctx=` "silently shows another cluster's data" | refuted (cycle 26) — App.tsx validates ctx against the fetched list and falls back to the default; breadcrumb + URL self-correct (verified live) |
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
| Extract a `urlEnumPref` helper for the groupBy/capResource init pattern | premature (cycle 55) — only 2 non-identical instances, and the URL-write half is deliberately centralized. Rule-of-three unmet; revisit on a 3rd URL-backed enum pref |
| Shut registry/informer caches down on SIGTERM | low-value — Go reaps goroutines on exit (no slow-shutdown exists); the process-lifetime cache is intentional and documented (`registry.go:240-241`). `Shutdown()` is exercised by the store test helper |
| Panic-recovery wrapper around SSE graph build / log-stream goroutines | wrong — handlers are already wrapped by `server.recoverer`; graph ops have no panic paths; a recover() would mask real bugs |
| Log/handle `json.Marshal` failure in `writeSSE` | low-value — payloads are primitive-typed; marshal cannot fail. Real failures are network writes, already handled |
| `VisibleNamespaces` should gate on `*` instead of hardcoded `pods` | already-handled — pods-as-visibility-gate is the documented RBAC design (ADR 20260527) |
| Dim/disable/count log-level chips by which levels are present | wrong (2026-06-05) — the chips are a persistent HIDE-preference (`kd:logsHideLevels`), not a content indicator; streaming content would flicker and undermine set-once-persist. The "↧ N err" jump covers "is there an error" |
| Validate `-addr` / env durations in `config.Load` | low-value — `ListenAndServe`/flag parse already give clear errors ~100 ms later |
| Explicit `scrollIntoView` in the Kinds-row arrow-key handler | refuted live (2026-06-10) — native `.focus()` already scrolls the overflowing row; the only residual is the LAST chip's slightly-clipped right edge, a nicety. jsdom stubs scroll, so source surveys re-flag this — verify live |
| Events "Warnings only" filter needs a "shown / total" readout | already-mitigated (2026-06-10) — the tab badge always shows the total (`DetailDrawer.tsx`) and the chip shows the warning count; both numbers are visible |
| Events tab message search/filter box | refuted (2026-06-10) — the list is fully-rendered DOM bounded by the ~1h event TTL, so native Cmd+F searches it; Logs needed its own filter only because of the streaming buffer |
| Manifest in-pane find keyboard shortcut | superseded (2026-06-12) — the minimal-keyboard overhaul fixed the surface at FOUR bindings; do not add a shortcut without removing one in trade |
| Sort in-cluster `List()` context order; `defer debounce.Stop()` | low-value — in-cluster has a single context; the debounce timer is GC'd and not a race |
| "A non-default relationship filter clutters the canvas with orphan cards" | working-as-designed (live-checked, 219-resource namespace) — kd shows ALL resources under any rel-filter (0143cea); `orphanBlock` folds kinds with ≥5 loose nodes into "+N more". Do NOT hide nodes under a rel-filter — that re-introduces the vanishing-standalone-ConfigMap bug 0143cea fixed |
| Light theme renders dark toolbar chips / fails AA contrast | refuted — measurement artifact: a runtime theme toggle leaves `transition: background` stale under headless Chrome, and a naive parser misread `color(srgb …/α)`. Fresh loads in each theme are AA-compliant. See dogfooding "Measurement pitfalls" |
| Add a match-count / Enter-cycle hint to the topology search | already-done — `.topology-matches` shows "N of M" and the titles document Enter/Shift+Enter cycling (verified live); the probe queried the wrong class |
| Make graph nodes keyboard-focusable (tabindex) | wrong — 33+ tab stops would be tab-order noise; the keyboard path is search-cycling (`/` → Enter/Shift+Enter) |
| Harden / improve the multi-cluster context-switch flow | already-robust — verified live on a 5-context kubeconfig: friendly names from ARNs, namespace preserved across clusters, clean Connecting transition, bad `?ns=` self-corrects |
| "Drawer overflows the viewport / × unreachable at 1280px" | harness artifact (cycle 81) — the frozen headless compositor holds the `drawer-in` keyframe at its `from` frame, so a fresh drawer measures 32px off-screen; killing the animation snaps it flush. Do NOT "fix" the layout — kill animations before measuring (dogfooding "Measurement pitfalls" #6) |
| "Selecting a PVC in Volumes lights ~11 unrelated pods" | NOT a bug — `spotlightSubtree` deliberately walks the whole undirected component over displayed edges; pods sharing ConfigMaps/Secrets legitimately join. Do NOT special-case to 1-hop/directional — would regress the ownership spotlight |
| "An empty-selector PDB draws guard edges to unrelated pods" | NOT a bug — `spec.selector: {}` genuinely guards every pod in the namespace (the deliberate fix for the pdb-empty-sel dead-end; do NOT re-skip empty selectors); density is the cluster's config, managed by folding |
| Give long CRD kinds an acronym short-label fallback | low-value + risky (2026-06-06) — the truncated chip already carries a disambiguating title/aria-label; a CamelCase-acronym fallback regresses single-word kinds (Workflow→"W") and risks collisions. Curated labels are for built-in kinds only |
| Make the HEALTH filter multi-select like KINDS | low-value + risky (2026-06-06) — health is an ordinal severity ladder where triage focuses on ONE level, so single-select is principled (KINDS is nominal, hence multi); the refactor touches the core spotlight across App+Topology for niche value. Edge legibility confirmed mature at the same time (solid=owns / dashed=other, hover-disclosed `<title>` verbs) |
| Surface a failed container's exit as the Pod's hero `message` | refuted live (2026-06-06) — the failed container card is red-tinted directly under the hero and reads "Terminated: Error (exit 1)"; a hero message would duplicate it. `statusMessage` deliberately carries only what container statuses can't |
| Surface DisruptionAllowed reason on a **Healthy** at-floor PDB | low-value + risky (2026-06-06) — the Degraded case shipped (e84f8f6); alarming a green PDB (where 0 is correct protective behaviour) fights the "healthy has no why" gate, and the caution "can disrupt 0" chip + Events already flag it. Do NOT extend the message gate to Healthy |
| "ECK Elasticsearch `status.health` falls through to Unknown" | already-handled (2026-06-06) — `crHealth` has a dedicated green/yellow/red switch; verified live against a yellow cluster ("Ready · yellow" → Progressing) |
| "Expanding a busy node in the Nodes view doesn't bring its pods into view" | harness artifact (cycle 78) — `requestAnimationFrame` callbacks never fire in headless agent-browser and every non-initial viewport move is rAF-driven, so the viewport cannot move under eval-driven clicks; the expand logic is correct. Do NOT add rAF deferrals (tried, reverted). Assert computed targets in unit tests or use a headed browser (dogfooding "Measurement pitfalls", rAF) |
| Click-to-solo on log level chips | rejected (2026-06-10) — breaks the app-wide multi-toggle chip idiom for a 2-click saving; "↧ N err" already jumps to errors |
| Reorder relationship chips by edge count | rejected (2026-06-10) — stable chip order is muscle memory; a count-driven shuffle gains no triage |
| Drawer open at ~800px crushes the canvas to a sliver | working-as-designed (2026-06-10) — deliberate priority-ordered degradation (drawer keeps readable width; ⌘B recovers; ≤640px switches to overlays). Don't add a mid-width breakpoint |
| Dedicated icons for vendor CRD kinds | rejected (2026-06-11) — the deliberate line in `icons.tsx` is built-in kinds only; the fallback square + kind label already identifies a CRD, and one vendor icon opens per-vendor sprawl |
| Shrink the ~61 KB latin-font payload | rejected (2026-06-14 perf pass) — `font-display: swap` keeps fonts off LCP (measured); glyph-subsetting is unsafe for arbitrary log/manifest text; dropping a weight regresses the design language |
| Brotli for static assets; inline critical CSS | deferred (2026-06-14 perf pass) — both <0.1 s on top of gzip, each with a dependency/build cost; revisit only if the RTT-bound Slow4G LCP (2.2 s) becomes a real ask |
| Code-split CapacityView like the drawer | deferred (2026-06-14 perf pass) — `capacityLayout` is referenced synchronously in Topology's layout memo, so only the render component would split; smaller win than the drawer plus a Suspense flash on a one-click switch |
| Component tests for Topology / DetailDrawer | already-done (2026-05-29) — ~100 component tests ship via `@solidjs/testing-library`; the residual selection→drawer-centering gap is live-verification territory (jsdom rects are zeros — a mocked test validates the mock) |

## Done

**git log is the authoritative per-change record** (Conventional Commits carry the full WHY); this
section is only a coarse index, newest first.

### 2026-07 SSE robustness + server-computed Logs gate

- Per-node `loggable` now derives from viewer-authorized server log sources, covering completed workload CRDs and cluster-scope Nodes while retiring the client kind/descendant gate.
- Sidebar namespace health now streams over SSE, replacing the client's 15s `/namespaces` poll
  (aa91149, 7e0066d)
- Namespaces and graph streams self-heal from silently-stalled connections through the shared
  `watchedEventSource` 40s watchdog; graph metrics calls are capped at 10s so they cannot starve the
  15s heartbeat loop (051484b, 8e7aab6, de45502). *Known rolling-upgrade transient:* a new-JS tab
  pinned to an old pod without session affinity reconnects about every 40s until that pod drains;
  recovery stays correct, so no compatibility path
- Idle events stream stays silent (1a675e0); aggregated logs time-sort from the first line (ec44793);
  late-registered CRD kinds wake store subscribers (54c07bd); drawer sized viewport-relative
  (191af3f); container image shows the spec image (fc04107); plus smaller fixes + refactor passes —
  see git log

### 2026-06-14 frontend + network perf pass
- gzip middleware was the dominant first-paint win (Slow4G LCP 3.5→2.5 s, transfer 596→202 KB)
  (7b1023a); drawer subtree code-split (entry 84→69 KB gz, LCP →2.2 s; 0.7 s on a not-slow link)
  (61e794b)
- Measured non-issues (do not chase): graph render/update (folding caps visible DOM, 0 long tasks);
  fonts are the byte floor but `font-display: swap` keeps them off LCP. Rejected levers above

### 2026-05-29 → 2026-06-15 (batches b1–b39 + earlier cycles)
~200 shipped slices: operator-dogfooding campaigns (drawer/CR legibility, logs pipeline, usage
gauges, capacity view, a11y, phone/touch, light theme, beginner emergency shapes), the b35 design
overhaul, the b34 structure pass, the b36 memory pass, SSE robustness. The git log over that range
and each batch's `docs(backlog)` commit are the record.
