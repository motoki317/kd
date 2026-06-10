# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks — so they
survive across agent sessions and are visible to human contributors. This is the durable home for
such tasks; `docs/plans/` is gitignored single-session scratch and must **not** hold the backlog.

How to work it: the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`) describes how
to discover, adversarially verify, and ship items; the **`backlog-management`** skill describes the
format and lifecycle of this file. The per-item evidence (`file:line`) and the verdicts are what make
an entry actionable — keep them.


**Status (2026-06-10):** The UX and server surfaces are **mature** — delegated re-surveys now refute
~94% of generated candidates. Source new work from real user feedback or a new feature area, not filler
re-surveys; do NOT re-dogfood a surface marked mature below unless its code changed. The durable
techniques live in the `improvement-cycle` skill (`dogfooding-kd-ui.md`), the recurring traps in
AGENTS.md. **Current focus (user-set, 2026-06-10): beginner-first** — short UI texts, prune excess
features/docs, structural cleanup over micro-edits.

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

Recent batches (newest first; **one line per batch** — `git log` carries the full WHY per commit, the
`docs(backlog)` commits hold each batch's original narrative, walked-surface evidence lives in
"Verified mature" above, refuted ideas live in Rejected below — do not regrow prose here):

- **b28 (2026-06-11, dogfooding D79–D90; next cycle: D91)** — the dead-credentials context switch
  (a real shape that day) caught two lies: the stale selection ghosted into the drawer under a false
  "Deleted from the cluster" banner (selection now clears on ctx change), and disabling the broken
  current context's option made the native select silently display a DIFFERENT cluster (current
  option never disabled; `selected` declared per option). A second reachable cluster opened fresh
  shapes: cert-manager Certificate drawer gained its essence chips (names / expires-in / issuer —
  the spec-chip pattern + a future-direction relativeUntil); real Degraded no-endpoints Service,
  ArgoCD app-of-apps, 544-resource cluster scope with zero Unknown noise, run-history CronJob
  (never-ran state correctly absent), 375px cert-chip wrap — all verified clean. Rejected: vendor
  CRD icons (built-ins-only line). GRPCRoute deferral re-verified (still no instances).
- **b27 (2026-06-11, dogfooding D61–D78)** — shipped: cluster-scoped log streams
  (a Node's static-pod logs — etcd/apiserver one click away on a beginner's Docker Desktop; client
  sentinel + server logSnapshot), single-slash search fallback (label keys / image fragments were
  unsearchable), never-run CronJob Logs honesty, drag-pan text-selection suppression, sidebar filter
  trim, README run-path completion, chart policy.csv group-token doc, backlog re-condensed 713→405.
  Verified clean: redeploy-while-tab-open recovery, finished-Workflow logs on real data, STS→PVC→PV
  chain, previous-logs kubelet passthrough, kube-system static-pod tree, dblclick-fit discoverability.
  Logged: cluster-scope Node Logs-tab gap (joins the hasLogs Open item).
- **b22–b26 (2026-06-10, operator-flow dogfooding D1–D60)** — sixty successive
  human-operator walks through the live UI (landing/triage, logs, capacity, lenses, keyboard, phone,
  deep links, rollouts, SSE churn, a11y, manifest find, folds, history). Two fixes shipped: macOS
  Option+T composing '†' so Alt+T never fired (e.code now matched); ⌘F on the Manifest tab fell
  through to browser find (now serves both panes). Everything else verified clean or already-handled.
- **b21 (2026-06-10)** — survey coverage complete: client utils 0 real / 8 refuted; full segment gate
  green (617 web tests + Go suites + `just check` + embed build).
- **b20 (2026-06-10)** — auth/rbac security survey 0 real; canvas empty state became a live region;
  beginner emergency shapes (unschedulable, failed Workflow) walked clean; 375px no-access state fits.
- **b19 (2026-06-10)** — every bootstrap failure now answers: no-access, no-identity, and dead-context
  each get a terminal state instead of "connecting…" forever (strict empty-state rung order); CLI `-h`
  and no-kubeconfig first-contact polished; gofmt gate added to `just check`.
- **b18 (2026-06-10)** — dead-context offline handling; nodesEqual gaps fixed (Service.Selector, Node
  resources) + a reflective decides-every-field diff test; light-theme audit clean; client-core and
  layout surveys clean.
- **b17 (2026-06-10)** — gauge-attribution ADR recorded; store survey shipped a Start goroutine-leak
  fix (watcher launched before Discover could fail); favicon/Events re-flags were probe bugs.
- **b16 (2026-06-10)** — ManifestPanel extracted (drawer 731→567); finished-run logs read "this run
  already finished" instead of waiting forever; internal/api survey 10/10 refuted.
- **b15 (2026-06-10)** — KindFacts.tsx + spec_routing.go extracted (pure moves); `rels=disruption`
  URL alias (visible label now parses); RBAC/Disruption/Monitoring projections matured.
- **b14 (2026-06-10)** — pod summed gauge returns above the container cards; workload rollup splits
  one segment per pod by default with a persisted by-container toggle (ef9d163).
- **b13 (2026-06-10)** — per-container bars moved onto the cards (8ad8eb3); restart counts dated
  (6f913a2); host-Node ceiling restored (7297211); non-zero side borrows its natural unit (26d0e2c).
- **b12 (2026-06-10)** — saturated HPA reads "2 · at max" (3eca308); evicted pods name kubelet's
  cause (24b912f); gauge invariants documented in frontend-internals.
- **b11 (2026-06-10)** — workload gauge per-container segments + legend + aria (6a70c7a, f44d452,
  253296b); sha256 digests truncate (4b895c2); chart docs: metrics RBAC rule + events-not-cacheable
  fixed; stuck-rollout condition ranking made explicit (405ae6b).
- **b10 (2026-06-10)** — pod gauge stacks per-container segments keyed to card swatches; cards show
  declared bounds with every number labelled (3825567); OOM alarm in words on the at-risk card;
  ContainerCards/ImageRef extracted.
- **b9 (2026-06-10)** — WCAG contrast pass: `--on-accent` + `--degraded-badge` inks (b1bd510,
  088fb42); per-container live usage joins the cards (921406f).
- **b8 (2026-06-10)** — Released+Retain PV reads Suspended + names its stale claimRef (22f17a7); DS
  node-selector chip (35049d4); URL-seeded namespace that can't open says so (9f03da1); morning-triage
  and restricted-operator flows verified seamless.
- **b7 (2026-06-10)** — broken HPA explains itself (5fa839c); logs viewer says the tailed resource was
  deleted (e5a5a7b); API error-path survey verified handled; docs drift fixed (7ec575e, b0ff111).
- **b6 (2026-06-10)** — typo'd named targetPort no longer reads "1/1 ready" (f209067); capacity scale
  keys on max(capacity, demand) (839d392); cordoned node row says so (b611788); KeyValRow extracted
  (7c5f861); event ×N hover gloss (59bb2a2).
- **b5 (2026-06-10)** — induced-failure beginner shapes: quota-blocked rollout cause (ad07a1a,
  206d7c2, bdfebc1), probe failure in words (b74e348), failed Job says it gave up (67d416e),
  finalizer-stuck delete named (ab9a375), ContainersNotReady tautology suppressed (70eea09);
  user-reported drawer header actions overlay fix (239864d).
- **b4 (2026-06-10)** — empty namespace says so plainly (4af7105); gauge label dedup (d869e92); Kind
  view full pod names (875a179); waiting containers carry root-cause messages (dbb5822); URL surface
  mature; refactor survey: 0 qualifying candidates, organization verified healthy.
- **b3 (2026-06-10)** — beginner-first structural sweep: backlog condensed 718→366 (519210e); 40+ UI
  texts rewritten beginner-plain (a965c9c); README hero from fictional demo data (2831e75);
  feature-surface audit verdict: already restrained — do not prune without a concrete beginner pain.
- **b2 (2026-06-10)** — light-theme troubled-text inks ≥4.5:1 (6f46508); ExternalName service no
  longer fakes "no endpoints" (cd61d25); "headless" address sentinel explains itself (bbe7502); long
  chip values wrap (16b8ef9).
- **b1 (2026-06-10, phone/touch + a11y + folds)** — phone overlays inert the canvas (890429a); drawer
  full-width overlay (b2cb445); pinch zoom (d2654f6); sidebar toggle (d5d3489); capacity Fit frames
  the drawn layout (14b4db3); triage-aware fold representatives (c15ab85); filtered count pill flies
  to matches (5291ac7); plus ~10 smaller slices (see git log 2026-06-10).
- **2026-06-06→09 (operator-dogfooding, drawer/CR legibility)** — multi-container logs, drawer
  expand, secondary-lens folds, usage gauges, CR health mappings, Nodes-view clickable names, log
  message-first rendering, scattered-triage framing — ~40 slices, all hashed in Done below.
- **2026-06-05 b1–b5 + 2026-05-29** — edgeless-namespace hang, SSE capacity flood, expand-fit zoom
  direction, ARIA sweep + rovingFocus, cluster-scope drawer 404, server-surface survey.

Small deferrals from these batches (reopen on operator ask): per-line truncation for multi-KB log
lines; logs-header chip stacking at phone width; co-routed multi-type edges draw identical paths;
drawer-overlay Tab-bleed at phone width + modal-help inert siblings; TopologyToolbar extraction;
manifest format-toggle drops the find scroll anchor; one unreproduced ghost-clear on SSE reconnect
(watch for it); Volumes-lens typed/depth-limited spotlight walk (regression risk to the ownership
spotlight — see the PVC-spotlight row in Rejected).

## Open

- **Toolbar vertical bulk at phone width** — *deferred (low value/risk ratio).* At 375px the topology
  toolbar's four facet rows consume ~250px of 667, leaving ~400px of canvas. Workable: the drawer and
  sidebar now overlay full-width, pinch zoom covers the cramped canvas, and the chips wrap correctly
  (no overflow). A "fold filters behind a disclosure at ≤640px, keep the search row" design would
  reclaim ~180px but touches the toolbar's roving focus / scroll-edge fades (the same delicacy that
  deferred the TopologyToolbar extraction). **Reopen when:** a phone operator actually reports the
  canvas too short, or the toolbar grows another facet row.

- **Large-graph empty gutter after a window shrink** — *verified live (cycle 40, docker-desktop
  kube-system), deferred — touches heavily-tuned pan-clamp behaviour.* Shrinking the window
  (1280→700) correctly preserves the operator's zoom and re-clamps via `clampTranslate`
  (`Topology.tsx`, cycle 294 resize handler + cycle 316 clamp), but for a graph **wider than the
  viewport** the clamp's upper bound (`rect.width - margin`) permits a large empty gutter: a graph
  fit-centred for 1050px stayed at `tx≈284` in a 470px viewport, leaving ~280px of empty canvas on the
  left while the graph overflowed the right. The clamp guarantees only "≥60px of graph visible", not
  "viewport covered when the graph is larger than it". **Why deferred:** the fix (for `w ≥ rect.width`,
  clamp so the viewport stays covered — no gutter) also changes how a *large* graph pans, and pan/zoom
  feel is user-iterated territory (many cycles). Impact is low (window resizes mid-session are rare;
  the dominant resize — drawer open — is owned by selection-fit). **Reopen when:** the user wants the
  graph re-anchored on resize, OR confirms the large-graph pan should never expose empty gutter; then
  split `clampTranslate` into small-graph (keep-visible) vs large-graph (keep-covered) bounds + tests.

- ~~Container / step picker for multi-container pod logs~~ — **resolved by the merged-logs work**
  (0c767a3/b34e695, re-verified 2026-06-10): `select.logs-container` exists with init/app optgroups +
  an "All containers" default, and the aggregated view gained per-container filter chips. The one
  residual — a finished Workflow's display-dropped pods have no container names client-side — is the
  same gap as the `hasLogs` item below; it lives there now.

- **Logs tab for any workload CRD with only completed pods** — *follow-up to the completed-run-logs
  fix (e5c190c/e792b9d); low value, deferred.* The server (`BuildForLogs`) now reaches a finished
  resource's completed pods, and the client shows a Logs tab for `Workflow` via `LOGGABLE_KINDS`. But
  any OTHER pod-owning workload CRD whose pods all completed (Tekton `PipelineRun`/`TaskRun`, a custom
  operator's job CRD) still hides its Logs tab: `hasDescendantPod` can't see the display-dropped pods
  and the kind isn't in the hardcoded set. **Proper fix:** the server computes a per-node `hasLogs`
  (ownership over `BuildForLogs`) and the client gates on `node.hasLogs` instead of the kind list +
  client-side descendant walk. **Reopen when:** a non-Argo workload CRD with completed-only pods needs
  logs, or the hardcoded `LOGGABLE_KINDS` Argo entry feels too special-cased. Same family
  (2026-06-11, D67): a Node selected in **cluster scope** shows no Logs tab (the cluster-scope display
  graph holds no pods, so `hasDescendantPod` is false) while the same Node in kube-system — its static
  pods riding along — streams fine. Don't fix by adding `Node` to `LOGGABLE_KINDS`: a podless worker
  node (every EKS node) would get a tab that waits forever; the per-node `hasLogs` is the fix here too.

- **GRPCRoute has routing edges but no drawer routing table** — *follow-up to the 2026-06-06 routing
  trio; low value, deferred.* `gatewayRouteEdges` already emits `EdgeRoutes` for a GRPCRoute's
  `backendRefs` (it's in the *Route kind list), so the Network view connects it — but the drawer's
  `routes()` table only handles HTTPRoute (path matches). A GRPCRoute matches on
  `spec.rules[].matches[].method.{service,method}` (gRPC service/method, not a URL path), so a faithful
  table would render e.g. `helloworld.Greeter/SayHello → svc:port`. **Deferred because** gRPC ingress is
  rare in this deployment (no GRPCRoute instances on either reachable cluster) and the edge — the
  topology-level answer — already lands. Build it if a cluster here adopts GRPCRoute: add a
  `grpcRouteMatches` branch to `routes()` mirroring `httpRoutePaths`, fixture-tested.

- ~~HPA: target metric + drop the "unknown state" status~~ — **shipped / refuted (2026-06-10).**
  (1) The "metric" chip now renders each Resource metric's current/target ("cpu 200% / 90%"; v2
  utilization + averageValue, v1 flat fields, unsampled current as "—"); dogfooded live against a real
  mid-scale HPA on docker-desktop (metrics-server reinstalled). (2) verified stale — e629880's
  condition rules classify a functioning HPA (status empty, health Healthy); no "unknown state" shows.

## Future / larger work — deferred (examined, not actionable now)

Re-examined on 2026-05-29 against the real code (each cites why). These are genuinely longer-horizon —
none is a safe, clearly-felt improvement-cycle slice today. Each lists what it would take and the signal
that should reopen it, so a future agent inherits the analysis instead of re-surveying from scratch.

- **Live per-namespace health for background namespaces** — *deferred (premature).* The open namespace
  is already live via the SSE `summary` event (cycle 201); background namespaces refresh on the 15 s
  sidebar poll, which re-summarizes every visible namespace (`api.go` `handleNamespaces` → a full
  `graph.Build` per namespace). A naive "cache summaries on store change" does **not** help: `notify()`
  (`store.go:185`) is a single coalesced signal with no namespace granularity, so recompute-all-on-change
  is *worse* than the poll for the common single-client / churny case; a correct per-namespace-dirty
  cache is a real design change with no user-felt benefit until thousands of namespaces × many clients.
  *Reopen when:* kd actually runs against a many-thousand-namespace cluster, or the product wants
  background namespaces to update live — then build a cluster-wide summary SSE stream (the per-ns dirty
  cache is one piece of it).
- **SSE patch scaling** — *deferred (premature).* Patches recompute+diff on a 300 ms window; fine today,
  no observed pain. Field-selector informers / sharding would break the ride-along invariant the health
  rollup depends on (cross-namespace ownerRef, Pod→Node, PVC→PV), so they need an ADR, not a cycle. The
  real large-namespace bottleneck is **client-side Dagre layout**, not the server rebuild. *Reopen when:*
  a profiler shows server rebuild (not layout) as the bottleneck on a real workload.
- **EndpointSlice-based `selects` edges** — *deferred (real, high regression risk).* Service→Pod edges
  use label-selector matching (`edges.go` `serviceEdges`); EndpointSlice is the more accurate source
  (ready endpoints, named ports, selectorless / cross-namespace, non-pod backends). Adopting it needs
  three decisions first: (1) eager-load EndpointSlice (today skipped for cardinality — 10–100× Services
  on big clusters) vs lazy/hybrid; (2) Endpoints v1 legacy vs EndpointSlice-only; (3) whether to add a
  `port` dimension to the graph model (a backward-incompatible edge-shape change). *Reopen when:*
  operators on large clusters need accurate endpoint readiness — start with an ADR answering the three
  questions plus a cardinality cap.
- **Timeline / history view ("where did it degrade over time")** — *deferred (different product tier).*
  A web survey of modern k8s dashboards (cycle 59) found kd already matches their topology/UX patterns —
  flat fewer-clicks navigation, namespace scoping, detail blades (manifest/events/related), CPU+memory
  requests-AND-limits visualization (the Nodes capacity view), service→pod→volume dependency graphs —
  with ONE pattern absent: a time-axis showing when a Deployment rolled out or a resource degraded.
  kd is fundamentally a LIVE view built on informer caches (current state only); the Events tab is the
  sole limited timeline (recent k8s events, which age out — see the cycle-44 status-message item). A real
  timeline needs **historical-state persistence** (a time-series/event store with retention), which is a
  new subsystem and arguably a different product, not an improvement-cycle slice. *Reopen when:* the
  product wants historical/post-mortem analysis — then it's a design effort (storage backend + retention
  + a time-scrubber UI), starting from an ADR, not a cycle.
- **Last-Event-ID resume on the SSE feed** — *deferred (low value).* The server emits no SSE `id:` today
  and the reconnect path already re-snapshots, which is **idempotent by design** (`graphState.fromSnapshot`
  + Solid `reconcile`) and cheap (~100 ms). Real resume needs a server-side patch ring buffer with TTL +
  overflow→snapshot fallback — a streaming-v2 design pass — for a payoff the idempotent re-snapshot
  already delivers. exec/attach would use WebSocket (per the SSE ADR). *Reopen when:* a streaming-v2
  effort is on the table for other reasons (e.g. exec/attach).

- **Manifest syntax highlighting** — *deferred (feature with dependency/bug cost, secondary view).* The
  Manifest tab renders raw YAML/JSON in a plain `<pre class="manifest">` (`DetailDrawer.tsx:597`), find-
  matches wrapped in `<mark>`; no key/value/string colouring. Highlighting would aid scanning a long
  manifest, and k9s/Lens do it — but it needs either a highlighter dependency (bundle cost on a tool that
  ships one embedded binary) or a hand-rolled YAML+JSON tokenizer (real edge cases: values with colons,
  block scalars, the YAML↔JSON format toggle), for a *secondary* drill-into-raw view where the existing
  in-manifest find already locates fields and plain output matches `kubectl`. Not a safe quick slice.
  *Reopen when:* operators report the raw manifest is hard to scan, or a highlighter is already pulled in
  for another reason — then prefer a tiny dependency-free "dim the keys" pass over full tokenisation, and
  verify it survives the format toggle + find-highlight overlay.

*Resolved this pass — "Component tests for Topology / DetailDrawer" (already done):* `Topology.test.tsx`,
`DetailDrawer.test.tsx`, `LogViewer.test.tsx`, `Sidebar.test.tsx`, and `CopyButton.test.tsx` already ship
~100 component tests via `@solidjs/testing-library` + `fireEvent` (227 web assertions total). The residual
gap — cross-component selection→drawer-centering — is **not** a jsdom unit test: jsdom returns zeros for
`getBoundingClientRect`, so a mocked test would validate the mock, not the coordinate math. It belongs to
live Playwright verification per AGENTS.md, not the backlog.

### Same-kind collapse — deferred follow-ups (shipped 2026-06-01)

The "+N older" same-kind collapse shipped across all views (commits `189c839` grid views, `d444086`
connectivity). Two scoped pieces were deliberately left out — each is real but low-value/high-risk today:

- **Collapse non-leaf same-kind siblings** — *deferred (effectively absent in the model).* Connectivity
  collapse only folds a hub's **degree-1** same-kind leaves (pods, configmaps, PVCs). Same-kind siblings
  that *own subtrees* and number >8 under one parent don't occur in kd's graph (controllers fan out to
  leaves), so the case is academic; pulling a subtree out of the Dagre skeleton + synthesizing
  multi-neighbor bundle edges is real risk for no real benefit. *Reopen when:* a concrete graph shape
  shows >8 non-leaf same-kind siblings under one parent.

## Rejected — do not re-propose

These were generated and **refuted against the real code**; re-proposing them wastes a cycle. (The
adversarial-verify step rejected ~94% of generated ideas once the surface matured — see Status above.)

| Candidate | Verdict |
|---|---|
| Split LogViewer's toolbar (or panel) into its own component | rejected (2026-06-10) — the toolbar JSX reads 9+ signals owned by the stream/buffer state machine (filter, levels, groups, wrap, timestamps, previous, container, case, lines); an extraction means ~18 drilled signal/setter props that scatter one cohesive state machine across files. File length alone doesn't justify it — unlike KindFacts/ManifestPanel, there is no clean state seam |
| Hardcoded short labels for vendor CRDs without API shortNames (e.g. a monitoring operator's kinds truncating to "VMSERV…") | rejected (2026-06-10) — those CRDs declare no shortNames, so any code would be invented: meaningless to a beginner, a per-vendor maintenance list with no canonical source, and WORSE than the truncated real prefix (which at least hints the kind; hover + drawer carry the full name). The fallback truncation is the design |
| Collapse a container's identical Req+Lim bars into one "Req=Lim" bar (Guaranteed QoS) | rejected (2026-06-10) — the sublabel grid track is a fixed 34px ("Req=Lim" can't fit), a variable row count per card breaks the Lim/Req repetition idiom across cards, and two equal bars already say "req = lim" in the established language |
| Flag an Unavailable APIService (broken aggregated API) | already-handled (2026-06-06) — `crHealthFromConditions` reads the `Available` condition (False → Degraded) and surfaces its message; no APIService-specific rule needed |
| Unknown `?ctx=` "silently shows another cluster's data" (trust problem) | refuted (cycle 26) — App.tsx:96-99 validates ctx against the fetched list and `setCtx(info.default)`; verified live the breadcrumb + URL self-correct to the real fallback context (no "bogus" anywhere), so there is no mislead |
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
| Extract a `urlEnumPref` helper for the groupBy/capResource URL+localStorage init pattern | premature (cycle 55) — only 2 instances and not byte-identical (capResource validates inline, groupBy uses `GROUP_IDS.includes`); the URL-*write* half is deliberately centralized in one effect, so the helper would cover only the read half and the name would overpromise. Rule-of-three unmet. Revisit if a 3rd URL-backed enum pref lands. (Contrast: toggleInSet in cycle 50 WAS byte-identical duplication — that one was worth extracting.) |
| Shut registry/informer caches down on SIGTERM (call `Cache.Shutdown()` / thread the signal ctx) | low-value — Go reaps background goroutines on process exit, so there is **no** slow-shutdown/forced-kill (one agent's HIGH verdict was wrong); the process-lifetime cache is intentional + documented (`registry.go:240-241`). `Shutdown()` is now exercised by the store test helper instead. |
| Panic-recovery wrapper around SSE graph build / `superviseLogStreams` goroutines | wrong — HTTP handlers are already wrapped by `server.recoverer`; graph ops have no panic paths; a recover() would mask real bugs |
| Log/handle `json.Marshal` failure in `writeSSE` | low-value — Patch/Summary/Graph are all primitive-typed; marshal cannot fail. Real failures are network writes, already handled |
| `VisibleNamespaces` should gate on `*`/any-resource instead of hardcoded `pods` | already-handled — pods-as-namespace-visibility-gate is the documented RBAC design (ADR 20260527); operators grant blanket access in target namespaces |
| Dim/disable/count log-level chips (ERR/WRN/INF/DBG) by which levels are currently present | wrong (cycle, 2026-06-05) — the chips are a **persistent HIDE-preference** (`kd:logsHideLevels`, `LogViewer.tsx:61-72`), not a content indicator: an operator sets "always hide DBG" once and it persists across pods. Logs STREAM, so a level empty now gets a line a second later; dimming/counting by transient content would flicker AND undermine the set-once-persist design. The chips are already explicit (text labels, severity colors matching the inline badges, `title="Hide X lines"`). The live "↧ N err" jump button already covers "is there an error to look at". |
| Validate `-addr` / invalid env durations in `config.Load` (fail earlier) | low-value — `ListenAndServe`/flag parse already give clear errors ~100 ms later; no operator pain |
| Add explicit `scrollIntoView` to the Kinds-row arrow-key focus handler (`onToolbarKey`) | refuted live (2026-06-10) — drove the roving arrow path through an 18-kind overflowing row (`scrollWidth 1585 > 980`): native `.focus()` already scrolls the row (verified it scrolled back to 0 when focus wrapped to early chips; chip mid-row landed visible). The only residual is the browser's `inline:'nearest'` leaving the very LAST chip's right edge slightly clipped after a direct focus — a native-scroll nicety, not a reachability bug; every chip is focusable, readable, and reachable. jsdom can't see this (stubs scroll), so it reads as a gap on a source survey — exactly why the chip-overflow rule says verify live. |
| Events "Warnings only" filter should show a "shown / total" readout like the Logs `X/Y` | already-mitigated (2026-06-10) — the Events TAB badge always shows the TOTAL event count (`DetailDrawer.tsx:431`, `events().length`, unaffected by the filter), and the chip shows the warning count, so an operator sees both 3 (warnings) and 33 (total) — the "this resource only had 3 events ever" misread the logs `X/Y` prevents doesn't occur here. An explicit "3 of 33" would be redundant clutter. (The Logs panel needs `X/Y` because it has no equivalent always-on total.) |
| Events tab message search/filter box | refuted (2026-06-10) — the events list is FULLY RENDERED DOM (plain `<ul><For>`, no cap or virtualization, bounded by the ~1h event TTL), so the browser's native Cmd+F already searches every message; the Logs panel needed its own filter only because a streaming buffer + level/pod filters make native find useless there. Warnings-only + newest-first covers triage; a search box would duplicate Cmd+F as clutter. |
| Manifest in-pane find needs a keyboard focus shortcut (e.g. `/` when the Manifest tab is active) | deferred (2026-06-10) — real keyboard-completeness gap (the find box is the one drawer action with no keyboard door), but the only natural key (`/`) is the established global namespace-filter focus; overloading it contextually (manifest-find when the drawer's Manifest tab is active) risks surprising muscle memory on a core shortcut, and needs App↔drawer coupling to know the active tab. Not shipping without the campaign owner's call on the interaction. Revisit if a non-conflicting affordance emerges. |
| Sort in-cluster `List()` context order; `defer debounce.Stop()` in sse.go | low-value — in-cluster has a single context (switcher hidden); the debounce timer is GC'd and is not a race |
| "A non-default relationship filter (e.g. RBAC) clutters the canvas with orphan cards" | working-as-designed (live-checked on a real 219-resource staging namespace, `rels=rbac`). kd shows ALL namespace resources regardless of the active rel-filter (commit `0143cea`); under RBAC only SA→RoleBinding→Role + Pod→SA edges are drawn, so non-RBAC resources become parentless — but `layoutGraph`'s `orphanBlock` folds any kind with ≥`FANOUT_MIN` (5) loose nodes into one collapsible "+N more" block (EPHR 88 / WF 48 folded → only 68 of 219 cards drawn), and sub-5 kinds stay as a short plain-card column by design. The RBAC trees render correctly (18 edges); the leftmost orphan cards are intended, not clutter. Do NOT hide nodes under a rel-filter — that re-introduces the "standalone ConfigMap vanishes" bug 0143cea fixed. |
| Light theme renders dark toolbar chips / fails AA contrast | refuted — a measurement artifact, not a bug. Runtime theme toggle leaves the chips' `transition: background` stale under headless Chrome (getComputedStyle returns the pre-toggle colour); a fresh load in the target theme reads correctly. The "sub-AA" numbers came from a naive parser mis-reading `color(srgb …/α)` backgrounds. Both themes are AA-compliant. See dogfooding skill "Measurement pitfalls". |
| Add a match-count / Enter-cycle hint to the topology search | already-done — the `.topology-matches` element shows "N of M"/"no matches" and the input + count titles already document Enter/Shift+Enter cycling (cycles 284–285). Verified live ("6 of 21"). The earlier probe just queried the wrong class |
| Make graph nodes keyboard-focusable (tabindex) for keyboard selection | wrong — 33+ tabbable SVG nodes would be tab-order noise. The keyboard path is search-cycling (⌘K → type → Enter/Shift+Enter steps matches → drawer → `[`/`]` tabs → arrow keys); verified end-to-end. Don't add per-node tab stops |
| Harden / improve the multi-cluster context-switch flow | already-robust — verified live on a 5-context kubeconfig: the `.ctx-switcher` native `<select>` shows friendly cluster names from ARNs (aria-label "Kubernetes context"), preserves the namespace across clusters, shows a clean Connecting→loaded transition (no hang on a ~15s EKS first sync), and a non-existent `?ns=` gracefully falls back to a real namespace (URL self-corrects, no empty strand). No change needed |
| "Drawer overflows the viewport / the × close button is clipped & unreachable at a 1280px width" | **harness artifact, NOT a real bug** (cycle 81). The drawer enters via `@keyframes drawer-in` (`translateX(32px)→0`, 0.28s, no fill-mode); the headless agent-browser compositor freezes it at the `from` frame, so a freshly-opened drawer measures `transform: translateX(32px)` and its right edge + × button sit 32px off-screen. Forcing the resting state (`drawer.style.animation='none'`) snapped it flush: `right == innerWidth (1280)`, gap to topology = 0, close button fully visible. In a real browser the 0.28s animation completes and the drawer rests flush. Same frozen-compositor root as the rAF entry. Do NOT "fix" the layout/keyframe. To check geometry of an animated-in element, kill its animation first (see dogfooding skill "Measurement pitfalls" #6). |
| "Selecting a PVC in the Volumes view lights ~11 unrelated pods, not just its mounter" | NOT a bug — the selection spotlight is `spotlightSubtree` (graphState.ts:16), which walks the whole UNDIRECTED connected component over the *displayed* edges, by deliberate design ("lights its whole related subtree"). In Volumes, pods share ConfigMaps/Secrets, so the component legitimately spans many pods. Verified the PVC's DIRECT connections are present (its mounter pod `sts-pod-0` + its bound PV are both lit, edges traceable). Connected-component is the right choice for the PRIMARY ownership view (where the subtree IS the answer) and is applied uniformly for consistency; do NOT special-case it to 1-hop/directional — that's heavily-tuned, user-iterated territory and would regress ownership. (2026-06-06, live docker-desktop app-ns.) |
| "An empty-selector PDB lights up / draws guard edges to unrelated pods" (Scheduling view, selecting pdb-wide-a PDB lit api-svc & ui-svc pods + a second PDB) | NOT a bug — working as designed (2026-06-06, live docker-desktop app-ns). pdb-wide-a AND pdb-wide-b both have `spec.selector: {}` (the namespace-wide "protect everything" PDB pattern), so each genuinely guards EVERY pod in the namespace — the `EdgeGuards` edges to all those pods are correct (and empty-selector-guards-all is the deliberate fix for the pdb-empty-sel dead-end; do NOT re-skip empty selectors). The two broad PDBs form a dense pod↔PDB guard mesh; the relationship spotlight then lights the connected neighborhood and the layout folds the crowded pods, so only the unfolded ones show. Verified the guard edges + drawer policy/can-disrupt chips render correctly. Density is inherent to the cluster's config, managed by folding. |
| Give long CRD kinds (e.g. `WorkflowTaskResult` → "WORKFLOW…") an unambiguous kind-chip short label / CamelCase-acronym fallback | low-value + risky (2026-06-06, live on staging app-ns). The truncated KINDS-row chip already carries a disambiguating `title`/`aria-label` ("Click to toggle WorkflowTaskResult"), and the kind itself is a high-cardinality Argo-internal type operators rarely filter on. A broad `kind.toUpperCase()`→acronym fallback (the tempting general fix) REGRESSES single-word kinds (Workflow→"W", Secret→"S") and risks acronym collisions; curated `KIND_SHORT_LABELS` entries are for built-in k8s kinds, not cluster-specific CRDs. Not worth a broad label-scheme change for one rarely-filtered chip. |
| Make the HEALTH filter multi-select (like KINDS) / "spotlight all non-healthy at once" for consistency | low-value + risky (2026-06-06). The apparent inconsistency is **principled**: health is an *ordinal* severity ladder (Healthy<Progressing<Degraded) where triage focuses on ONE level — the worst — so single-select fits; KINDS is *nominal*/categorical, where wanting several at once is natural, so it's multi-select. `aria-pressed` (a toggle that can be all-off → no spotlight) is also more correct for health than a radiogroup (which implies one-always-selected). A multi-select refactor would touch the signal type (`Health|null`→`Set`), `navCandidates`, `nodeFaded`, `filterMatchCount`, the Esc-clear, and the pill aria across App+Topology — moderate regression risk on the core spotlight — for the niche "mixed-severity spotlight" value the Degraded spotlight already mostly covers (and colored dots already mark all trouble without any filter). Don't pursue without a concrete operator ask. Edge legibility (same investigation): confirmed mature — solid=owns / dashed=other is a deliberate calm-canvas choice, each edge's type is hover-disclosed via a clear `<title>` verb ("pdb guards pod-x", "pod mounts cm"), and the filter isolates a category; "type-based edge opacity" was already rejected (above). |
| Surface a failed container's terminated reason+exit (e.g. "main: Error (exit 1)") as the **Pod's hero `message`** when no blocking-condition message exists | refuted via live dogfooding (2026-06-06, **staging** 354-node app-ns, a real `Error` migrate pod: main exit 1, all pod conditions message-empty, so `statusMessage`→""). NOT buried: the failed container card is **red-tinted with a red left accent** (contrast), sits high in the drawer right under the hero (init/main/wait — the bad one stands out, no scan), and shows "Terminated: Error (exit 1)" + the image. `statusMessage`'s comment deliberately scopes the Pod message to "the Unschedulable detail the per-container statuses *can't* carry" — container termination IS carried by the (emphasized) container cards, so a hero message would duplicate the prominent red card. Don't add it. |
| Also surface the DisruptionAllowed reason on a **Healthy** PDB that reports `disruptionsAllowed: 0` (above its floor but blocked by SyncFailed) | low-value + risky (2026-06-06, live docker-desktop app-ns: `pdb-wide-a` 10/8, `pdb-wide-b` 11/8, both `disruptionsAllowed=0` SyncFailed). The high-value case (a *Degraded* PDB's why) shipped in e84f8f6; extending it to Healthy PDBs would route an alarm-styled `.drawer-message` onto a **green** resource, fighting `statusMessage`'s deliberate "a healthy resource has no why worth the payload" gate. The blocked state is already flagged by the caution-coloured "can disrupt 0" chip, and the `CalculateExpectedPodCountFailed` warning is one click away in the Events tab. A drain-planning operator is already inspecting the PDB; not worth alarming every green at-floor PDB (where 0 is *correct* protective behaviour) to catch the rare above-floor-SyncFailed case. Do NOT extend the message gate to Healthy PDBs. |
| "An ECK `Elasticsearch` CR uses a non-standard `status.health: green/yellow/red` field, so kd falls through to Unknown" | already-handled (2026-06-06, live docker-desktop + kubectl). `crHealth` (`health_cr.go:221`) has a dedicated stack-health switch reading `status.health`: green→Healthy, yellow→Progressing, red→Degraded, unknown→Unknown, with `crHealthFromConditions` as the default fallback. `crStatusSummary` combines it with `crPhase` into "Ready · yellow" — the *same* "explain a non-green dot on an otherwise-Ready resource" pattern as the node-status pressure suffix. Confirmed against a real yellow Elasticsearch (`health=yellow phase=Ready` → kd shows `Progressing`, status "Ready · yellow"). Complete across all three colours; do NOT re-investigate the "stack CR health = Unknown?" hypothesis. |
| "Expanding a busy node in the Nodes view doesn't bring its pods into view" (viewport stays put, ~6/46 cards visible) | **harness artifact, NOT a real bug** (cycle 78, a remote staging cluster, a 46-pod node). Root-caused by instrumented logging: **`requestAnimationFrame` callbacks never fire in the headless agent-browser session** (proven: `requestAnimationFrame(cb)` leaves `cb` unrun after 3s while `document.visibilityState === 'visible'` and `setTimeout` works). EVERY non-initial viewport move in kd is rAF-driven (`animateTo`'s tick loop; `fitCapRowExpanded`/`fitCapBox`/selection-fit all `requestAnimationFrame(() => animateTo(...))`), so when an expand is driven via `agent-browser eval`-dispatched clicks the viewport CANNOT move — the only fit that lands is the very first one, because `firstFit` sets `scale/tx/ty` DIRECTLY (Topology.tsx, not via `animateTo`). The expand logic itself is correct (synchronous `capRows().find` returns fresh geometry; `fitCapRowExpanded` top-anchors a tall stack). Do NOT "fix" `toggleCapRow` with rAF deferrals — that was tried and reverted (equally invisible to the harness, and unnecessary). To verify any pan/zoom/fit/animation behaviour, assert the *computed target* in a unit test, or use a HEADED browser — never an agent-browser viewport measurement. See dogfooding skill "Measurement pitfalls" (rAF). |
| Click-to-solo on log level chips (click ERR = show only errors) | rejected (2026-06-10 b22 D2) — would break the app-wide multi-toggle chip idiom (every chip row composes via independent toggles) for a 2-click saving; the "↧ N err" jump button already covers "take me to the errors" |
| Reorder relationship chips by edge count (busiest lens first) | rejected (2026-06-10 b22 D16) — stable chip order is muscle memory; a count-driven reorder makes the toolbar shuffle between namespaces and sessions for no triage gain |
| Drawer open at a ~800px window crushes the canvas to a sliver | working-as-designed (2026-06-10 b25 D46) — deliberate priority-ordered degradation: the just-opened drawer keeps readable width (the operator's focus is the drawer), ⌘B or closing recovers the canvas, and ≤640px switches to full-width overlays. Don't add a mid-width breakpoint |
| Dedicated icons for vendor CRD kinds (cert-manager Certificate/Order, Argo Workflow, ArgoCD Application, …) | rejected (2026-06-11 D88) — the deliberate line in `icons.tsx` is built-in kinds only; every CRD gets the fallback square + its kind label (CERT, WF, APP), which already identifies it. One vendor icon opens per-vendor sprawl with no canonical source for the glyphs, and tiny-size legibility is the constraint that killed acronym labels too |

## Done

Shipped improvements, newest first. **git log is the authoritative per-change record** (Conventional
Commits carry the full WHY); these one-liners are just the index — the verbose rationale that used to
live here was redundant with the commits and is trimmed (2026-06-06 condensation). Hashes shown where a
single commit maps cleanly; otherwise search the title in git log.

### 2026-06-06 operator-dogfooding campaign
(Condensed 2026-06-10 — the per-item narrative was redundant with the commits; hashes are the record.)
- Usage gauges with escalating overshoot laps (c87185a → 82b3655)
- Nodes view: clickable node names, full FQDN kept (749be8e, 8177eb8)
- Service drawer pod selector, caution-tinted at 0 endpoints (c453dae)
- Legacy core/v1 Endpoints kind skipped like EndpointSlices (4315b4a)
- Combined "All containers" log view defaults the time column on (b34e695)
- Scattered triage filter frames the single most-troubled match (24e231d)
- kube-root-ca.crt ConfigMap dropped from the graph entirely (df5ad8d)
- Workload drawer rolls up live usage from its replicas (badaf12)
- Kyverno/wgpolicy policy reports classify by result summary (0cb87b8)
- Traefik Middleware card says what it does (c810a3b)
- NetworkPolicy lists each rule's real peers + ports (2bf0d78)
- Satisfied PDB reads "2 healthy", not the impossible "2/1" (171949f)
- IngressRoute routing row shows its middleware chain (7cf1c7d)
- Drawer "Labels · N" disclosure actually collapses (c508760)
- Nodes view floats this namespace's nodes to the top (7e98d66)
- Failed Workflow ranks the primary step's failure over its exit-handler's (d3ed4c9)
- Kind-view health filter floats matching cards into visible slots (9d4438c)
- Terminating namespace reads Progressing · "Terminating" (d3c5536); nodesEqual Scrapes test gap (1b830e1)
- An IngressClass card/drawer now shows its controller + default marker ("traefik.io/ingress-controller · default") — "which controller serves my Ingress" — completing the cluster-scoped legibility set with CRD + PriorityClass (7ea29b0)
- A PriorityClass card/drawer now shows its value (comma-grouped) + globalDefault + never-preempts, the preemption-debugging facts, instead of just age (9a20ff0)
- Persisted the display-vs-logs graph split (Build drops completed pods; use BuildForLogs) + main-container default in AGENTS.md "Common surprises" (36df784)
- A CRD's card/drawer now shows what it defines ("Kind · Scope · servedVersions", e.g. "Workflow · Namespaced · v1alpha1") instead of just its age — a cluster-scope CRD sweep now reads as what each operator enables (719bedf)
- The client log container picker now also prefers `main` (shared `defaultLogContainer` with the server), so a directly-selected step pod streams the same container as the aggregated workflow view — no longer `wait` vs `main` depending on how you reached it (59e3537)
- Pod logs now default to the `main` container instead of the `wait` executor sidecar, so an Argo Workflow run's logs show the step's real output (was 459/510 lines of executor noise) (bc94db7)
- Completed-run logs are now viewable: a finished Job/CronJob/Workflow's Logs tab aggregated zero pods (Build drops completed controller-pods) — added BuildForLogs that keeps them while still dropping superseded ReplicaSets (e5c190c), and Workflow now always offers a Logs tab since its finished pods are display-dropped (e792b9d)
- Collapse pills now fade during health/search triage when they hide zero matches, so only match-bearing pills ("● N match") stay bright — the empty folds no longer bury the one worth expanding (Contrast) (e4e3d71)
- ServiceMonitors/VMServiceScrapes now connect to the Services they scrape (EdgeScrapes, honoring namespaceSelector) under a new composable "Monitoring" relationship category — they were floating islands (8e3c3c1)
- A ServiceMonitor/VMServiceScrape drawer now shows its scrape target (selected services + endpoint port/path/interval) — "what does this scrape, how often", reusing the route-row idiom for both CRDs (4f01788)
- nodesEqual now repaints on NetworkPolicy-rule and Node-taint edits (the NetPol/Taints fields were added without a diff-compare, so the open drawer kept stale data) (7835c37)
- An Argo CronWorkflow's status text is now its schedule + timezone, and the CronJob "last run" chip is reused for status.lastScheduledTime — one visual language for both scheduled kinds, no new model fields (a174c88)
- Node headers (capacity view + drawer host) show the short hostname, dropping the repeated DNS domain; full FQDN on hover (d68f01a)
- Init-container restarts now count in a pod's restart total, so an init-crashloop shows the crash signal + gets the "previous logs" button (bed6cf4)
- A JSON log's level badge/filter/jump-to-error now works even when `level` trails a long message (message-first loggers like pino/bunyan) (6a5c5f3)
- Init-container logs are now reachable in the pod log picker (labelled optgroup) — the place a stuck-in-Init pod records WHY (e22c47f)
- JSON-object log lines (ES/zap/logrus/…) render message-first with dimmed extras instead of raw blobs; copy/grep stay on the raw line (6e353b9)
- Help overlay (`?`) flows into 2 columns ≥740px wide so the full reference card fits without an undiscoverable internal scroll (91986b4)
- Search match-count is now a button that flies to the matches on click (mouse path beside Enter; search doesn't auto-fit while typing) (e5c71f3)
- Dropped redundant pod→Node tree from the Relationship view; category relabelled "Disruption" (PDB-only) — pod↔node lives in the Nodes group-by (0f94f83)
- Error/warn log lines get a faint left-edge severity accent (2a3dee4)
- Health stripe floors its segments so trouble can't vanish at scale (7b91d33)
- Drawer hero now explains its health tint (the gray "Unknown" ambiguity) (d58dd63)
- Breadcrumb showed the raw `__cluster__` sentinel instead of `[cluster]` (c5bade5)
- A degraded PDB now surfaces its DisruptionAllowed reason inline, not just "0/3 healthy" (e84f8f6)
- Drawer offers aggregated Logs for any pod-owning resource, not just built-in workloads (f34bee8)
- Node status text now explains its Degraded dot (e6b9290)
- Nodes capacity view: a node's Use/Req CPU bars no longer clash units
- Cluster-scope health tally: CRDs + FlowSchemas no longer falsely "Unknown"
- StorageClass drawer shows provisioner, reclaim, binding, expansion
- A degraded CR now explains itself — surface its condition message
- PodDisruptionBudget → guarded-pods edges
- PodDisruptionBudget drawer shows its policy + allowed disruptions
- HPA drawer shows replica state + min/max bounds
- Job/CronJob drawer shows last-run, active, and failed counts
- PVC/PV drawer shows access modes + storage class
- ConfigMap/Secret drawer lists its data keys + a Secret's type
- Traefik IngressRoute routing table + Service edges, like Ingress
- Gateway API route → Service edges join the Network relationship
- Gateway API HTTPRoute drawer shows its routing table, like Ingress
- Logs empty-state names the hidden count + offers a one-click reset
- Image references emphasise the tag, dim the registry prefix
- `y`-yank threw an uncaught TypeError in a non-secure context
- Structured search `Kind/name` matches the kind by prefix, not substring
- Manifest find scrolls to the first match on type
- Trouble badge / Alt+T now CYCLE through troubled namespaces
- Log line-count readout now covers level + pod filters, not just text
- Navigation now reaches folded matches — count unified + auto-expand-on-select
- Surfaced a degraded resource's failure reason in the drawer
- Capacity node labels mixed units within one pair
- A failed Argo Workflow's drawer shows the leaf step's real error, not the child-node pointer
- A card's hover tooltip now carries the failure reason — zero-click triage of a degraded wall
- An aria-live region announces the current selection (kind/name/status/reason) as j/k steps
- logfmt log lines render message-first (msg emphasised, time/level dimmed) — like JSON
- Node drawer surfaces scheduling taints (caution chip) — why pods won't land here
- Empty events list explains the ~1h Kubernetes event TTL (aged-out ≠ never-happened)
- Wildcard-verb RBAC rules flagged (caution "wildcard" tag) — over-privilege stands out
- NetworkPolicy drawer summarizes target + per-direction rules (+ registered it in typedFactories)
- NetworkPolicy → pods "governs" edge (Network category) — no longer a disconnected island
- Light-mode caution TEXT readable (--caution-text, 4.71:1) — amber was ~1.85:1 on white
- O(1) edge endpoint lookup (memoized node map) — was O(edges×nodes) per render in fade+title

### Earlier cycles (2026-05 and before — see git log for detail)
- Filter count undercounted when matches were folded
- PodDisruptionBudgets read "Unknown" health — noise that hid violated budgets
- Drawer dropped the status string the card showed
- Overflowing Kinds row had no scroll affordance
- Restarted container hid WHY it restarted
- The Events tab was empty for EVERY resource in production (f80bab1)
- Buried container/scheduling triage info surfaced
- Cluster-scoped resource drawer fetched an empty namespace
- A11y focus-ring sweep
- CRD-removal ghost cleanup
- Keyboard-operable collapse pills
- Server-side survey

