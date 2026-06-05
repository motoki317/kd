# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks — so they
survive across agent sessions and are visible to human contributors. This is the durable home for
such tasks; `docs/plans/` is gitignored single-session scratch and must **not** hold the backlog.

How to work it: the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`) describes how
to discover, adversarially verify, and ship items; the **`backlog-management`** skill describes the
format and lifecycle of this file. The per-item evidence (`file:line`) and the verdicts are what make
an entry actionable — keep them.

**Status (2026-06-06):** Both the **UX surface** and the **server surface** have been systematically
surveyed and are **mature** — at a mature surface ~94% of generated candidates get refuted, so source the
next batch from real user feedback or a new feature area, not filler re-surveys. Recent batches drained
the Open queue and hardened tests; the durable lessons are persisted in the `improvement-cycle` skill
(especially `dogfooding-kd-ui.md` "Measurement pitfalls"). **Do NOT redundantly re-verify** the surfaces
marked clean below — re-dogfood one only if its code changed.

The 2026-06-06 session added two genuine, previously-undocumented gaps — a degraded **PDB's
DisruptionAllowed reason** now shows inline (e84f8f6), and the breadcrumb no longer leaks the raw
**`__cluster__` sentinel** (c5bade5) — both found by driving real flows, not source reads. A subsequent
strict re-survey that turn (Alt+T trouble-cycle, KINDS scroll-fade, Volumes PVC→PV chain, `pvcHealth`
phase mapping, SSE-connection `aria-live`) found **only already-documented-mature handling** — i.e. ≈0
new high-value items, the improvement-cycle STOP signal. Per the standing rule, the next real value comes
from new user feedback / a new feature area, **not** further re-surveys of these mature surfaces.

Recent batches (newest first; `git log` has the commits):

- **2026-06-06 (operator-dogfooding campaign, IN PROGRESS)** — a directed campaign to mature the UX by
  running real human-operator flows via agent-browser (docker-desktop + a real EKS staging cluster), not
  source surveys. Re-confirmed the b1 lesson hard: the source surface read "mature", yet driving actual
  flows found a real, clearly-felt gap nearly every cycle. Shipped so far: Kinds-row overflow fade;
  drawer echoes the card's status string; PDB health rule (was bogus "Unknown"); filter overlay counts
  true matches (folded included), not just visible cards; **drawer surfaces a degraded resource's
  failure reason** (status.message, for aged-out events); **navigation reaches folded matches** (count
  unified + auto-expand the fold on select — closed two Open items); **log count covers level/pod
  filters**, not just text; **trouble badge/Alt+T cycle through all troubled namespaces**, not just the
  worst; **manifest find scrolls to the first match on type**; **structured `po/` search matches kind by
  prefix** (was substring — lit Endpoints/NetworkPolicy); **`y`-yank + log-line clipboard copy guarded
  in non-secure contexts** (threw uncaught TypeErrors); **image refs emphasise the tag, dim the registry
  prefix** (+ extracted a shared `ImageRef`). The four recurring shapes are persisted in the dogfooding
  skill's "UX-gap patterns" section, pitfall #8 (troubled-first nav masks fold-testing) in "Measurement
  pitfalls", and the clipboard non-secure-context gotcha in AGENTS.md — check them on any view. Surfaces
  found MATURE (don't re-survey unless code changes): Events tab (sort/filter/source-nav/aged-out),
  ContextSwitcher (no short-name collisions in the real kubeconfig), capacity per-pod expansion + Memory
  mode, rel-filter compose (every edge delta matches its badge count), Pod/Deployment/Service drawer
  layouts, **cluster-scope view** (long kind chips truncate + scroll with full-kind titles), **owner-chip
  navigation + Alt+Left history**, **narrow-viewport toolbar wrap** (760px — primary rows stay in
  bounds), **zero-match search empty-state** (clear-filters CTA), **drawer expand mode** (520→1050px,
  aria-pressed, focus-trap), **relationship-view selection highlighting** (connected nodes + `owner`
  edges lit, the rest `faded`/`owner faded` by class — verified 18/136 nodes + 17/88 edges lit on a
  selected Service), **multi-select kind-filter compose** (OR/union — PO+SVC lit 22 Pods + 7 Services;
  chips already carry `aria-pressed`), **help overlay** (`?` binding + button; complete and drift-free —
  every current shortcut listed incl. j/k, ⌘B, `[ ]`, 1/2/3, Esc-precedence, "Owns" edge gloss),
  **ConfigMap data-key list** (26-key argocd-cm — sorted, sized, long keys wrap with the size held
  right via `space-between`+`align-items:center`; a "Data ·N" header refuted — the hero kind + the
  header-less routes/rules blocks make it redundant), **Ingress/HTTPRoute/Traefik-IngressRoute routing
  tables** (single + 3-route `Host && PathPrefix → svc:port` render faithfully; keep the raw Traefik
  matcher — cleaning it loses fidelity), **offline/dropped-stream state** (EXEMPLARY — every surface
  speaks the drop: switcher "<ctx> — unavailable", red OFFLINE·RETRY pill, sidebar "Couldn't load
  namespaces/RETRY", canvas "Can't reach the cluster — use offline·retry above", ghost cards),
  **restart-triage degradation** (a 44-restart pod with an empty kubelet `lastState` correctly shows
  `↻44` and OMITS the absent exit reason — it surfaces lastTerminated only when present), **manifest
  find** (`.manifest-find-count` "1/7" on match, "no matches" on miss, Enter/Shift+Enter cycle, an
  `sr-only` live region, and the query + highlights persist across a YAML↔JSON format toggle), **aggregated
  log per-pod chips** (`.logs-pods` `flex-wrap:wrap` — a multi-step workflow's many source-pod chips wrap,
  never clip; each `aria-pressed` + colour-dot), **Events aggregate the owned subtree generically**
  (`events.go` `DescendantIDs`, the consistency the Workflow-Logs fix matched), **sidebar namespace
  filter + keyboard nav** (`/` focuses, type filters, `↑↓` highlights, `Enter` selects; `[cluster]` stays
  pinned), **kind-view selection contrast** (selected card opacity 1, the other 39/42 fade to 0.2),
  **Service endpoint health is false-positive-free** (selector-less ExternalName/manual services are
  EXCLUDED from annotation `edges.go:195` so a 0-endpoint provisioner svc reads `h-healthy`, verified
  live; and `ep.Ready` counts only `HealthHealthy` pods, which `podHealth` gates on `podReady`, so the
  count aligns with real Endpoints readiness — a not-Ready surge pod is Progressing, not a ready backend),
  **live rollout rendering** (a `rollout restart` showed the old pod Healthy + the new surge pod
  Progressing until it passed readiness, then converged — the readiness-gated health rendering live). Also shipped this
  campaign: **node status text explains its Degraded dot** (e6b9290), **MetaChip extraction** for the
  drawer's labelled-fact chips (9322c65), **asUnstructuredKind** CR-essence access helper (64ed4e2),
  **aggregated Logs for any pod-owning resource** incl. Argo Workflows (f34bee8), **DescendantPodNames
  built on DescendantIDs** (47868f0).
  The high-value finding rate is now clearly tapering —
  most flows verify mature; keep dogfooding for genuine gaps but do NOT manufacture filler. (Removed the
  Nodes-view Relationships facet + arrows and Kind-view arrows earlier per direct user request; see git
  log.)
- **2026-06-05 b5** — cluster-scoped drawer fetched an empty `{ns}` (`namespaces//…` → 307→404); fixed at
  the `key()` builder (repairs manifest+events+logs at once) → technique is bug-class #6. Also: a
  "relationships hidden" toast (empty relFilter looked like "no connections"); `prefixParentNames`→
  `names.ts`; GatewayClass status coverage. Clean (don't re-verify): drawer (ns + cluster-scope), search,
  capacity overshoot invariant + 58-card expansion, rel-filter compose, theme toggle, offline→retry.
- **2026-06-05 b4** — headline is a *harness limitation, not a feature*: the headless agent-browser
  compositor is FROZEN (rAF + CSS animations never advance), manufacturing fake fit/overflow/clip bugs.
  Two convincing fakes retracted, NOT "fixed" (would have broken real behaviour). Persisted as pitfalls
  #5/#6 + two do-not-re-propose rows. Hardened Go coverage on previously-0% pure logic.
- **2026-06-05 b3** — copy-success live region; **completed the single-select a11y sweep** (Manifest
  YAML/JSON → radiogroup, the last bare-`.active` pick-one). Mostly refutation (measurement artifacts) —
  surface thinning.
- **2026-06-05 b2** — found a real **a11y blind spot**: drawer tabs were `aria-pressed` not a tablist;
  Group/Resource were `role=group`+`aria-pressed` not radiogroups. Fixed both + a tested `rovingFocus`
  helper. Also: auto-frame-on-filter *with a readability floor* (naive fit zoomed scattered matches to a
  0.04× speck); help-legend de-drift; three pure-logic extractions slimming Topology.tsx. Lesson:
  "surveyed mature" ≠ mature — a *new audit lens* (ARIA) finds gaps prior lenses structurally missed.
- **2026-06-05 b1** — dogfooding found the maturity claim didn't hold for the fresh Nodes-capacity /
  viewport-edge / empty-data paths. Nine cycles, several high-impact: **edgeless namespaces hung on
  "connecting…"** (nil Go `Edges` slice → `"edges":null` → client `[...g.edges]` threw inside the SSE
  listener before `connState` went live); SSE capacity flood (~40KB re-sent on every Lease heartbeat);
  expand-fit & pod-click zoomed OUT; help overflow; tooltip edge-clip. Lesson: **a passing test suite is
  NOT a maturity signal for interaction/edge/empty paths — dogfood them.**
- **2026-05-29** — UX surface declared mature (16 candidates → 1 low-value); drained Open, deferred every
  Future item with a rationale + reopen trigger. Then surveyed the never-before-covered **server surface**
  (31 agents, mostly refuted) — shipped 3 (policy.csv re-parse/log-spam, auth groups-gating test, store
  teardown), rejected the rest (incl. "shutdown caches on SIGTERM" — Go reaps goroutines on exit).

---

## Open

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

- **GRPCRoute has routing edges but no drawer routing table** — *follow-up to the 2026-06-06 routing
  trio; low value, deferred.* `gatewayRouteEdges` already emits `EdgeRoutes` for a GRPCRoute's
  `backendRefs` (it's in the *Route kind list), so the Network view connects it — but the drawer's
  `routes()` table only handles HTTPRoute (path matches). A GRPCRoute matches on
  `spec.rules[].matches[].method.{service,method}` (gRPC service/method, not a URL path), so a faithful
  table would render e.g. `helloworld.Greeter/SayHello → svc:port`. **Deferred because** gRPC ingress is
  rare in this deployment (no GRPCRoute instances on either reachable cluster) and the edge — the
  topology-level answer — already lands. Build it if a cluster here adopts GRPCRoute: add a
  `grpcRouteMatches` branch to `routes()` mirroring `httpRoutePaths`, fixture-tested.

- **HPA: target metric + drop the "unknown state" status** — *follow-ups to the 2026-06-06 HPA chips;
  medium/low value.* (1) The drawer now shows replicas + bounds but not the metric driving the decision
  (e.g. `cpu 72% / 80%`). It needs parsing `spec.metrics[]` against `status.currentMetrics[]` — several
  metric types (Resource/Pods/Object/External/ContainerResource); start with the common Resource-CPU/mem
  `averageUtilization` case and render `cpu cur%/target%`. (2) An HPA falls to the generic CR status
  ("unknown state" — see crStatusSummary) which is misleading for a functioning autoscaler; either
  suppress it when `scaleReplicas` is set, or add an HPA rule keying on the `ScalingActive`/`AbleToScale`
  conditions. Needs a metrics-server-backed cluster to dogfood current-metric rendering (docker-desktop
  has none — the chips verified there but `cpu <unknown>`).

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
| Sort in-cluster `List()` context order; `defer debounce.Stop()` in sse.go | low-value — in-cluster has a single context (switcher hidden); the debounce timer is GC'd and is not a race |
| "A non-default relationship filter (e.g. RBAC) clutters the canvas with orphan cards" | working-as-designed (live-checked on a real 219-resource staging namespace, `rels=rbac`). kd shows ALL namespace resources regardless of the active rel-filter (commit `0143cea`); under RBAC only SA→RoleBinding→Role + Pod→SA edges are drawn, so non-RBAC resources become parentless — but `layoutGraph`'s `orphanBlock` folds any kind with ≥`FANOUT_MIN` (5) loose nodes into one collapsible "+N more" block (EPHR 88 / WF 48 folded → only 68 of 219 cards drawn), and sub-5 kinds stay as a short plain-card column by design. The RBAC trees render correctly (18 edges); the leftmost orphan cards are intended, not clutter. Do NOT hide nodes under a rel-filter — that re-introduces the "standalone ConfigMap vanishes" bug 0143cea fixed. |
| Light theme renders dark toolbar chips / fails AA contrast | refuted — a measurement artifact, not a bug. Runtime theme toggle leaves the chips' `transition: background` stale under headless Chrome (getComputedStyle returns the pre-toggle colour); a fresh load in the target theme reads correctly. The "sub-AA" numbers came from a naive parser mis-reading `color(srgb …/α)` backgrounds. Both themes are AA-compliant. See dogfooding skill "Measurement pitfalls". |
| Add a match-count / Enter-cycle hint to the topology search | already-done — the `.topology-matches` element shows "N of M"/"no matches" and the input + count titles already document Enter/Shift+Enter cycling (cycles 284–285). Verified live ("6 of 21"). The earlier probe just queried the wrong class |
| Make graph nodes keyboard-focusable (tabindex) for keyboard selection | wrong — 33+ tabbable SVG nodes would be tab-order noise. The keyboard path is search-cycling (⌘K → type → Enter/Shift+Enter steps matches → drawer → `[`/`]` tabs → arrow keys); verified end-to-end. Don't add per-node tab stops |
| Harden / improve the multi-cluster context-switch flow | already-robust — verified live on a 5-context kubeconfig: the `.ctx-switcher` native `<select>` shows friendly cluster names from ARNs (aria-label "Kubernetes context"), preserves the namespace across clusters, shows a clean Connecting→loaded transition (no hang on a ~15s EKS first sync), and a non-existent `?ns=` gracefully falls back to a real namespace (URL self-corrects, no empty strand). No change needed |
| "Drawer overflows the viewport / the × close button is clipped & unreachable at a 1280px width" | **harness artifact, NOT a real bug** (cycle 81). The drawer enters via `@keyframes drawer-in` (`translateX(32px)→0`, 0.28s, no fill-mode); the headless agent-browser compositor freezes it at the `from` frame, so a freshly-opened drawer measures `transform: translateX(32px)` and its right edge + × button sit 32px off-screen. Forcing the resting state (`drawer.style.animation='none'`) snapped it flush: `right == innerWidth (1280)`, gap to topology = 0, close button fully visible. In a real browser the 0.28s animation completes and the drawer rests flush. Same frozen-compositor root as the rAF entry. Do NOT "fix" the layout/keyframe. To check geometry of an animated-in element, kill its animation first (see dogfooding skill "Measurement pitfalls" #6). |
| "Selecting a PVC in the Volumes view lights ~11 unrelated pods, not just its mounter" | NOT a bug — the selection spotlight is `spotlightSubtree` (graphState.ts:16), which walks the whole UNDIRECTED connected component over the *displayed* edges, by deliberate design ("lights its whole related subtree"). In Volumes, pods share ConfigMaps/Secrets, so the component legitimately spans many pods. Verified the PVC's DIRECT connections are present (its mounter pod `shop-es-default-0` + its bound PV are both lit, edges traceable). Connected-component is the right choice for the PRIMARY ownership view (where the subtree IS the answer) and is applied uniformly for consistency; do NOT special-case it to 1-hop/directional — that's heavily-tuned, user-iterated territory and would regress ownership. (2026-06-06, live docker-desktop team-a.) |
| "An empty-selector PDB lights up / draws guard edges to unrelated pods" (Scheduling view, selecting opa-a PDB lit api-a & ui-a pods + a second PDB) | NOT a bug — working as designed (2026-06-06, live docker-desktop team-a). opa-a AND api-a-projector both have `spec.selector: {}` (the namespace-wide "protect everything" PDB pattern), so each genuinely guards EVERY pod in the namespace — the `EdgeGuards` edges to all those pods are correct (and empty-selector-guards-all is the deliberate fix for the opa-b dead-end; do NOT re-skip empty selectors). The two broad PDBs form a dense pod↔PDB guard mesh; the relationship spotlight then lights the connected neighborhood and the layout folds the crowded pods, so only the unfolded ones show. Verified the guard edges + drawer policy/can-disrupt chips render correctly. Density is inherent to the cluster's config, managed by folding. |
| Give long CRD kinds (e.g. `WorkflowTaskResult` → "WORKFLOW…") an unambiguous kind-chip short label / CamelCase-acronym fallback | low-value + risky (2026-06-06, live on staging team-a). The truncated KINDS-row chip already carries a disambiguating `title`/`aria-label` ("Click to toggle WorkflowTaskResult"), and the kind itself is a high-cardinality Argo-internal type operators rarely filter on. A broad `kind.toUpperCase()`→acronym fallback (the tempting general fix) REGRESSES single-word kinds (Workflow→"W", Secret→"S") and risks acronym collisions; curated `KIND_SHORT_LABELS` entries are for built-in k8s kinds, not cluster-specific CRDs. Not worth a broad label-scheme change for one rarely-filtered chip. |
| Surface a failed container's terminated reason+exit (e.g. "main: Error (exit 1)") as the **Pod's hero `message`** when no blocking-condition message exists | refuted via live dogfooding (2026-06-06, **staging** 354-node team-a, a real `Error` migrate pod: main exit 1, all pod conditions message-empty, so `statusMessage`→""). NOT buried: the failed container card is **red-tinted with a red left accent** (contrast), sits high in the drawer right under the hero (init/main/wait — the bad one stands out, no scan), and shows "Terminated: Error (exit 1)" + the image. `statusMessage`'s comment deliberately scopes the Pod message to "the Unschedulable detail the per-container statuses *can't* carry" — container termination IS carried by the (emphasized) container cards, so a hero message would duplicate the prominent red card. Don't add it. |
| Also surface the DisruptionAllowed reason on a **Healthy** PDB that reports `disruptionsAllowed: 0` (above its floor but blocked by SyncFailed) | low-value + risky (2026-06-06, live docker-desktop team-a: `opa-a` 10/8, `api-a-projector` 11/8, both `disruptionsAllowed=0` SyncFailed). The high-value case (a *Degraded* PDB's why) shipped in e84f8f6; extending it to Healthy PDBs would route an alarm-styled `.drawer-message` onto a **green** resource, fighting `statusMessage`'s deliberate "a healthy resource has no why worth the payload" gate. The blocked state is already flagged by the caution-coloured "can disrupt 0" chip, and the `CalculateExpectedPodCountFailed` warning is one click away in the Events tab. A drain-planning operator is already inspecting the PDB; not worth alarming every green at-floor PDB (where 0 is *correct* protective behaviour) to catch the rare above-floor-SyncFailed case. Do NOT extend the message gate to Healthy PDBs. |
| "An ECK `Elasticsearch` CR uses a non-standard `status.health: green/yellow/red` field, so kd falls through to Unknown" | already-handled (2026-06-06, live docker-desktop + kubectl). `crHealth` (`health_cr.go:221`) has a dedicated stack-health switch reading `status.health`: green→Healthy, yellow→Progressing, red→Degraded, unknown→Unknown, with `crHealthFromConditions` as the default fallback. `crStatusSummary` combines it with `crPhase` into "Ready · yellow" — the *same* "explain a non-green dot on an otherwise-Ready resource" pattern as the node-status pressure suffix. Confirmed against a real yellow Elasticsearch (`health=yellow phase=Ready` → kd shows `Progressing`, status "Ready · yellow"). Complete across all three colours; do NOT re-investigate the "stack CR health = Unknown?" hypothesis. |
| "Expanding a busy node in the Nodes view doesn't bring its pods into view" (viewport stays put, ~6/46 cards visible) | **harness artifact, NOT a real bug** (cycle 78, a remote staging cluster, a 46-pod node). Root-caused by instrumented logging: **`requestAnimationFrame` callbacks never fire in the headless agent-browser session** (proven: `requestAnimationFrame(cb)` leaves `cb` unrun after 3s while `document.visibilityState === 'visible'` and `setTimeout` works). EVERY non-initial viewport move in kd is rAF-driven (`animateTo`'s tick loop; `fitCapRowExpanded`/`fitCapBox`/selection-fit all `requestAnimationFrame(() => animateTo(...))`), so when an expand is driven via `agent-browser eval`-dispatched clicks the viewport CANNOT move — the only fit that lands is the very first one, because `firstFit` sets `scale/tx/ty` DIRECTLY (Topology.tsx, not via `animateTo`). The expand logic itself is correct (synchronous `capRows().find` returns fresh geometry; `fitCapRowExpanded` top-anchors a tall stack). Do NOT "fix" `toggleCapRow` with rAF deferrals — that was tried and reverted (equally invisible to the harness, and unnecessary). To verify any pan/zoom/fit/animation behaviour, assert the *computed target* in a unit test, or use a HEADED browser — never an agent-browser viewport measurement. See dogfooding skill "Measurement pitfalls" (rAF). |

## Done

**Breadcrumb showed the raw `__cluster__` sentinel instead of `[cluster]` (2026-06-06):** dogfooding the
cluster-scope view, the top breadcrumb read `__cluster__` — the internal URL/wire sentinel — while the
sidebar and document title already prettified it to `[cluster]`. The breadcrumb rendered `namespace()`
verbatim; its own comment describes an icon reinforcing a *bracketed* label, so the raw value was never
intended (a missed mapping, not a design choice). Fixed + centralized: extracted `namespaceLabel()` into
`ns.ts` (beside the other cluster-sentinel handling) so the sentinel can't leak into one surface while
another prettifies it, and pointed both the breadcrumb and the doc title at it. Verified live (breadcrumb
+ title now `[cluster]`, no `__cluster__` anywhere in the DOM); +2 `ns.test.ts` cases. (c5bade5)

**A degraded PDB now surfaces its DisruptionAllowed reason inline, not just "0/3 healthy" (2026-06-06):**
dogfooding `team-b` (the one Degraded namespace on docker-desktop): the Degraded-health spotlight
correctly isolated a single PDB `opa-b` ("0/3 healthy", "can disrupt 0"), but the drawer gave no
*why* — the actionable `DisruptionAllowed=False` condition ("workflows.argoproj.io does not implement the
scale subresource", reason `SyncFailed`) lived only in the raw manifest YAML. `statusMessage` already
surfaces the one-line WHY for unhealthy Pods/Deployments/CRs but had no PDB case. Added one
(`pdbBlockMessage`, message → reason fallback): the two common blocked states demand opposite operator
actions — `InsufficientPods` (app below floor → scale up before draining) vs `SyncFailed`
(controller can't evaluate → the PDB is misconfigured, drains block indefinitely). Health classification
unchanged (still keys on the floor, not the condition — see `TestPDBHealthIgnoresBenignDisruptionBlocked`);
this only adds explanatory text to an already-Degraded PDB. The message renders in the existing
`.drawer-message` hero slot (below status, above the policy chips — proximity). Verified live: the drawer
now shows the full reason; +2 `statusMessage` test cases. (e84f8f6)

**Drawer offers aggregated Logs for any pod-owning resource, not just built-in workloads (2026-06-06):**
dogfooding the real staging cluster surfaced 94 pods owned *directly* by Argo `Workflow` CRs — yet
opening a Workflow drawer showed no Logs tab (the client gated on a hardcoded built-in-kind set:
Pod/Deployment/StatefulSet/…), exactly when an operator debugging a failed/running pipeline wants its
pods' output. Adversarially verified the server already aggregates generically (`podsForResource` →
`graph.DescendantPodNames`, walking ownerReferences) and that `isHistorical` drops only *Succeeded* pods
— so Failed and Running workflow pods stay in the graph and have logs. Fixed at the client gate: a node
is loggable if it's a built-in workload OR owns Pods in the current graph (`hasDescendantPod` walks
`ownerUIDs` downward — the client mirror of the server), auto-covering Workflows and any future
pod-owning CRD without hardcoding an operator's kinds. New `web/src/loggable.ts` (+7 tests). Verified
live: a running Workflow now defaults to Logs and streams its pod's output (per-pod colour label);
a ConfigMap still shows only Events/Manifest (no regression). (f34bee8) **Generality re-confirmed
2026-06-06** on a structurally different operator: an ECK `Elasticsearch` CR (owns pods via a 2-hop
`Elasticsearch→StatefulSet→Pod` chain) now defaults to Logs and streams 200 lines from `shop-es-default-0`
— proving `hasDescendantPod`'s recursive walk covers any operator's pod-owning CRD at any depth, which a
hardcoded Argo-only list never would. This is exactly why the general fix beat hardcoding.

**Node status text now explains its Degraded dot (was a silent contradiction, 2026-06-06):** a node under
resource pressure or NotReady got a red dot from `nodeHealth`, but `nodeStatusSummary` only ever returned
`Ready`/`NotReady`(+`,SchedulingDisabled`) — so a pressured-but-Ready node read a bare "Ready" beside a red
dot with the cause buried in `status.conditions`. Mirrored the pod-status fix: append the active pressure(s)
("Ready · DiskPressure") on a Ready node, or the NodeReady reason ("NotReady · KubeletNotReady") when down.
The long-standing live-verification blocker (couldn't safely induce node pressure) was solved by **injecting
a DiskPressure=True condition on the disposable docker-desktop node via the status subresource** — the
kubelet self-reverts within ~10s, so it's non-destructive. Confirmed live: card → `h-degraded`, label
"Node docker-desktop Ready · DiskPressure", sidebar Degraded tally +1. (e6b9290)

**Nodes capacity view: a node's Use/Req CPU bars no longer clash units (live-found on staging, 2026-06-06):**
on a real multi-node EKS cluster the same node showed Use `0.06 / 1` (cores) above Req `480m / 940m`
(millicores) — same node, same resource, two units, impossible to compare at a glance. Root cause:
`formatPair` chose the unit from each bar's OWN cap; the Use bar's cap is total capacity (1000m → cores)
but the Req bar's cap is the ~940m allocatable, which judged alone fell under the 1-core line → millicores.
Fixed by deciding the unit ONCE per node from its total capacity (new `unitRef` param) and applying it to
both bars, while each still displays its own cap. Now both read cores (`0.06 / 1` over `0.48 / 0.94`), so
"88% reserved, barely used" reads instantly. **Hidden on docker-desktop** (its integer-core node has
allocatable==capacity, no straddle) — only real allocatable-shaved nodes exposed it: the real-data lesson.

**Cluster-scope health tally: CRDs + FlowSchemas no longer falsely "Unknown" (live-found, 2026-06-06):**
opening `__cluster__` read `Healthy 274 · Unknown 60` — alarming at a glance. Scoped the exact culprits:
49 CustomResourceDefinitions (conditions Established/NamesAccepted) + 11 FlowSchemas (condition Dangling)
= 60, all falling through the Ready/Available catch-all to Unknown. Added typed group rules (the *invited*
extension per the dogfooding doc, NOT a reinterpretation of the tuned catch-all): a CRD is Healthy when
Established with accepted names, Degraded on a name conflict / not-established; a FlowSchema is Degraded
only when Dangling=True (references a missing PriorityLevelConfiguration), else Healthy. Shared
`conditionStatuses` helper for named-condition rules. Verified live: the tally went from `274 · Unknown
60` to a clean `Healthy 334`, with honest Degraded preserved for genuinely-broken plumbing.

**StorageClass drawer shows provisioner, reclaim, binding, expansion (live-found, 2026-06-06):**
dogfooding cluster scope, a StorageClass — the class a PVC author clicks through to (after the PVC drawer
now names it) — showed only name + manifest. Added `provisioner` (its defining fact: which CSI driver
backs volumes), `reclaimPolicy` (Delete/Retain — does deleting a PVC destroy the data?, defaulting to
Delete), `volumeBinding` (Immediate / WaitForFirstConsumer, default Immediate), and an `expandable` flag
(allowVolumeExpansion), navigated as unstructured (StorageClass has no typed factory). Rendered as
labelled chips; expandable is a labelled flag pill (explicit, not a bare colour). Verified live on the
docker-desktop hostpath class (provisioner docker.io/hostpath · reclaim Delete · binding Immediate).
Completes the PVC → PV → StorageClass storage triad.

**A degraded CR now explains itself — surface its condition message (live-found via triage, 2026-06-06):**
continuing the triage flow onto a degraded CR (an ECK Elasticsearch "Ready · yellow"), the drawer gave
the colour but no "why". Root cause: `statusMessage` read only a top-level `status.message` for an
unstructured CR, but most controllers (cert-manager Certificate, external-secrets ExternalSecret, …) put
the reason in `status.conditions[].message`. Added `crConditionMessage` (the not-True Ready/Available
condition's message — mirroring `crHealthFromConditions` so message matches the health verdict), used as
a fallback in `statusMessage`. The drawer's existing message block renders it (no client change).
Verified live with a throwaway CRD + a `Ready=False` Widget — the identical path a real Certificate hits:
the drawer showed "backend datastore unreachable: connection refused" where before it was blank. (ECK ES
itself uses non-Ready/Available conditions, so it stays colour-only — honest; the win is the many CRs
that DO use Ready/Available.)

**PodDisruptionBudget → guarded-pods edges (live-found via triage dogfooding, 2026-06-06):** running the
real operator triage flow (land on most-troubled ns → filter Degraded → drill in) on a degraded PDB
("0/3 healthy") hit a dead-end: a PDB selects pods via spec.selector (like a Service) but kd drew no
edge, so nothing led from the PDB to the failing pods that explain it. Added `EdgeGuards` (PDB → pods),
matched through the full LabelSelector (matchExpressions, not just a map), placed in the **Scheduling**
relationship category (a node-drain/disruption concern, not Network). **Live-dogfooding caught a design
error:** the real PDB had an *empty* selector (the namespace-wide "protect everything" pattern); my first
cut skipped empty selectors as "too noisy" and so still dead-ended the actual case — fixed to guard every
pod in the namespace (the Scheduling filter is opt-in anyway). Verified live: the degraded PDB now links
to all 4 namespace pods and selecting it highlights them. New edge type wired through model.go /
relationships.ts (Scheduling) / edgeRender.ts / types.ts.

**PodDisruptionBudget drawer shows its policy + allowed disruptions (live-found, 2026-06-06):** a PDB's
status read "3/2 healthy" and went Degraded when under-provisioned, but two facts stayed manifest-only:
the configured policy (minAvailable/maxUnavailable — the intent) and `status.disruptionsAllowed` — *can I
drain a node right now?*, THE question during a cluster upgrade. Added `pdbPolicy` ("min 2" / "max 50%")
and `disruptions` (a string so the critical "0" isn't hidden by an omitempty zero), rendered as labelled
chips; `can disrupt 0` takes the caution (amber) colour — a drain blocks here, a heads-up rather than the
alarming degraded red. Verified live on docker-desktop: a min-2 PDB showed `can disrupt 1` (neutral), a
min-3 PDB `can disrupt 0` (amber). Completes the "surface each kind's declarative essence" sweep
(routing, ConfigMap/Secret, PVC/PV, Job/CronJob, HPA, PDB).

**HPA drawer shows replica state + min/max bounds (live-found, 2026-06-06):** a HorizontalPodAutoscaler
(an unstructured CR here — no typed factory) already linked to its scale target, but showed no
autoscaling essence: how many replicas it runs, whether it's mid-scale, and the min–max bounds it works
within ("is it pinned at the ceiling?"). Added `scaleReplicas` ("current" stable / "current → desired"
mid-scale) and `scaleRange` ("2–10", min defaulting to 1) via unstructured field-path helpers (keeping
the CR edge/health path untouched), rendered as labelled chips. Verified live on docker-desktop:
`replicas 3 · range 2–10`. diff.go repaints when the HPA scales. **Two follow-ups noted below**
(metrics target; the "unknown state" status wart).

**Job/CronJob drawer shows last-run, active, and failed counts (live-found, 2026-06-06):** the status
line gave a Job "succeeded/total" and a CronJob its schedule expression — but omitted the runtime
questions operators actually ask: *did my cron actually fire* (a schedule string doesn't say), *is
anything running now*, and *is a Job burning retries* (a Job at "0/1" with 5 failures looks merely
pending). Added `lastRun` (CronJob status.lastScheduleTime, RFC3339 → client `relativeAge`), `active`
(Job status.Active / CronJob len(status.active)), and `failed` (Job status.Failed) to the graph Node,
rendered as labelled chips beside the status — the failed chip in the degraded colour so it reads as
trouble (Contrast, matching the health vocabulary). Verified live on docker-desktop with a demo cron
(last run 32s ago), a sleeping Job (active 1), and a failing Job (failed 4, red). diff.go repaints on a
cron firing or a count changing. Continues the "surface each kind's declarative essence" theme.

**PVC/PV drawer shows access modes + storage class (live-found, 2026-06-06):** a PVC's status already
read "Bound 10Gi" (phase + capacity), but the rest of its essence was manifest-only: the access modes
(can more than one pod mount it — RWO vs RWX, the multi-attach answer) and the storage class (the
provisioner/tier — gp3 vs standard, the cost/perf answer). Added `accessModes` (abbreviated kubectl
form, de-duped, "/"-joined) and `storageClass` to the graph Node for both PVC and PV, rendered as
labelled `access`/`class` chips reusing the Service-address row idiom (explicit over implicit). Verified
live on docker-desktop: a Bound PVC showed `access RWO · class hostpath`. diff.go repaints when a binding
fills these in. Continues the "surface each kind's declarative essence" theme (ConfigMap/Secret, routing).

**ConfigMap/Secret drawer lists its data keys + a Secret's type (live-found, 2026-06-06):** kd surfaces
every other kind's declarative essence in the drawer summary (Ingress→routes, Role→rules,
Service→ports) but a ConfigMap/Secret showed only labels + the raw Manifest tab — so "what keys does
this hold?", the single most common question about these kinds, meant reading YAML. Added `dataKeys`
("key · size", sorted) and `secretType` to the graph Node (server-side, from the typed ConfigMap/Secret;
ConfigMap binaryData and Secret stringData included). The drawer renders them in the routes/rules visual
language (Repetition): a Secret leads with a labelled `type` row (the operational classifier — tls vs
dockerconfigjson vs Opaque), then keys with the size split into a dim, right-aligned suffix (Contrast +
Alignment — the node-bar value/capacity idiom). **Security:** only key NAMES + byte sizes are emitted,
NEVER values — strictly less than the (RBAC-gated) Manifest tab already shows. Verified live on
docker-desktop: coredns ConfigMap (Corefile · 420B) and a bootstrap-token Secret (type +
6 keys with sizes, no values). diff.go repaints on a key add/remove/resize.

**Traefik IngressRoute routing table + Service edges, like Ingress (live-found, 2026-06-06):** the real
clusters here run Traefik, yet a Traefik `IngressRoute` (a CRD) drawer showed only labels + raw manifest
and the node sat isolated in the Network view — no routing table, no edge to its backends. Added
`traefikIngressRouteRoutes` (renders each `spec.routes[].match` verbatim — Traefik's matcher DSL is
already readable — → its services) into the shared `routes()`, and `traefikIngressRouteEdges` emitting
`EdgeRoutes` for each route's Kubernetes Service (TraefikService backends named in the table but not
edged, as they aren't Service nodes). Covers both `traefik.io` and legacy `traefik.containo.us` groups,
int/named ports. Verified live on the real staging argo-workflows IngressRoute: drawer showed the
match → service row, Network category gained the routing edge. Highest-value of the routing trio for
this deployment (the others are Gateway API, not used here).

**Gateway API route → Service edges join the Network relationship (live-found, 2026-06-06):** an
Ingress links to its backends via `EdgeRoutes` (the Network category), but an HTTPRoute (a CRD) got
nothing usable: the convention scanner only links a backendRef that carries an explicit `kind`, and
Gateway API backendRefs default to `kind: Service` and omit it — so an HTTPRoute had *no* topology edge
to the Services it routes to, and the Network filter showed it as an isolated node. Added a dedicated
`gatewayRouteEdges` handler (HTTPRoute/GRPCRoute/TCPRoute/TLSRoute/UDPRoute) emitting `EdgeRoutes` for
each `spec.rules[].backendRefs` Service (cross-namespace refs honored), skipping the generic scanners for
those kinds so the explicit-kind case can't double-emit an `EdgeRefers`. Verified live on docker-desktop:
the "Network" chip counted 2, both edges rendered titled "HTTPRoute … routes to Service …".

**Gateway API HTTPRoute drawer shows its routing table, like Ingress (live-found, 2026-06-06):** a
legacy `Ingress` drawer parsed its rules into a "host/path → service:port" table (`ingressRoutes`), but
the modern Gateway API `HTTPRoute` — which kd already health-checks (`health_cr.go`) and is the Ingress
successor — fell to generic-CR treatment: only labels + raw manifest, no routing table. Added
`httpRouteRoutes` (unstructured, since HTTPRoute is a CRD) producing the same row format, dispatched
through a shared `routes(obj)` so the drawer renders both identically (Repetition). HTTPRoute hostnames
are route-wide (not per-rule), so each hostname pairs with every rule's path matches, host-major; a
RegularExpression path is prefixed `~`, a match-less rule reads `/`, weighted backends join with `, `.
Verified live on docker-desktop with a 2-hostname/2-rule HTTPRoute: 6 rows rendered correctly, no
drawer overflow. Fixture test covers PathPrefix/regex/default paths, multi-backend, int64+float64 ports.

**Logs empty-state names the hidden count + offers a one-click reset (live-found, 2026-06-06):** the
level filter persists across pods (`kd:logsHideLevels` — a deliberate triage habit), so opening a pod
whose output is entirely INFO/DEBUG after hiding those levels elsewhere showed an empty pane reading
"no lines match the active filters" with no recovery — looking like the pod was silent. Changed the
empty-state to name the count ("all 20 lines hidden by the active filters" — lines exist, just hidden)
and added a "show all" button that clears every log filter (text, case, levels incl. the persisted
pref, pods) in one click. Mirrors the topology empty-state's clear-filters affordance (Repetition).
Verified live with a persisted info/debug filter on an all-INFO Workflow pod: empty-state showed the
count + reset; "show all" restored 50 lines, re-lit every level chip, and cleared the localStorage pref.

**Image references emphasise the tag, dim the registry prefix (live-found, 2026-06-06):** every
container card and workload image rendered the full ref in one uniform `<code>` — so a long ECR/GCR
prefix (`111122223333.dkr.ecr.us-west-2.amazonaws.com/quay-io/argoproj/`, usually identical across
a pod's containers) carried the same visual weight as the operator's first question, the version. Added
`parseImageRef` (prefix / repo name / tag-or-digest, reusing isFloatingImageTag's path-first split so a
`registry:5000` port is never a false tag) and rendered the prefix at 0.55 opacity, the tag bright +
semibold — the same emphasise-what-matters / dim-the-context language as the capacity bars. Also
extracted the duplicated image markup (code + floating-tag badge + copy) into one shared `ImageRef`
component used by both sites. Copy still yanks the full ref; the title still shows it. Verified live on a
real pod: prefix dimmed (opacity 0.55), `:v4.0.5` at weight 600 / `--text`. Unit-tested the parse
(full ECR ref, digest pin, registry port, bare image).

**`y`-yank threw an uncaught TypeError in a non-secure context (found by code-read during dogfooding,
2026-06-06):** the shortcut did `navigator.clipboard?.writeText(ref).then(() => setCopiedRef(ref))`. The
`?.` guards only `clipboard`, so when `navigator.clipboard` is undefined — every non-secure context,
e.g. plain `http://<lan-ip>:port`, a real way operators reach a port-forwarded/LAN kd — `?.writeText(ref)`
is `undefined` and `.then(…)` throws an uncaught TypeError in the keydown handler. `CopyButton` is robust
(its `try/catch` around `await` swallows the same throw and is documented to silently no-op when the API
is unavailable); the yank wasn't. Optional-chained the whole promise chain
(`?.writeText(ref)?.then(…)?.catch(…)`) so it no-ops silently when unavailable and confirms only on a real
success. Verified live both ways: with a working clipboard stub it writes `Pod/…` and shows the "Copied …"
toast; with `clipboard` forced undefined it throws nothing, leaves the page responsive, and shows no false
toast. A sweep found the identical pattern in `LogViewer`'s alt-click line copy (the `.catch` there can't
catch a *synchronous* `undefined.then` throw either) — fixed the same way.

**Structured search `Kind/name` matches the kind by prefix, not substring (live-found, 2026-06-06):**
typing `po/ui-a` (the canonical Pod short name) lit Endpoints (end·**po**·ints), NetworkPolicy
(network·**po**·licy) and PolicyEndpoint alongside Pods, because the kind side of the structured
predicate was a substring test (`kind.includes("po")`). The documented uses are exact — the `y`-yank
round-trip pastes a full `Pod/name`, and operators type kubectl shorts like `po/`. Switched the kind
side (full name, compact label, aliases) to a PREFIX match: a strict subset of substring, so the
round-trip and short-name paths keep working while mid-word false hits drop out. Verified live: `po/ui-a`
went 6 → 4 matches, Endpoints and NetworkPolicy gone. Known residual: a genuinely "Po"-prefixed sibling
(PodDisruptionBudget, PolicyEndpoint) still matches — excluding it would need the server short-name map,
absent on first paint and in unit tests, so prefix is the right pragmatic scope. Regression-tested.

**Manifest find scrolls to the first match on type (live-found, 2026-06-06):** typing in the drawer's
"find in manifest" box highlighted matches and showed "1/3", but left the manifest pinned at the top
with the first hit below the fold (a 2886px manifest in a 395px viewport) — unlike the browser's own
Cmd+F, which scrolls as you type. Worse, because the cursor reset to match 0 without scrolling, the first
Enter advanced to "2/3", appearing to skip the very hit the count claimed you were on. Added a
scroll-to-first-match on every query change (microtask-deferred so the fresh `<mark>`s exist); moved the
query-reset effect below `scrollManifestMatch`/`manifestMatchCount` so the eager `on` doesn't hit the
TDZ. Verified live: typing scrolled `scrollTop 0 → 2253` with the "1/3" match in view. Matches the
browser-find muscle memory the field's "(Enter ↓ · Shift+Enter ↑)" hint already implies.

**Trouble badge / Alt+T now CYCLE through troubled namespaces (live-found, 2026-06-06):** the sidebar
badge ("N need attention") and Alt+T both jumped to the single most-troubled namespace and re-landed
there on every repeat — so on a real cluster with 6 troubled namespaces among 38 A→Z rows, reaching the
other 5 meant scanning the column for colored dots. Made the jump a triage cycle: `nextTroubled` steps
worst-first from the current selection and wraps, so repeated badge clicks / Alt+T presses visit every
troubled namespace (the badge flash marks each landing). Mirrors the topology Enter-cycle and `j`/`k`
troubled-first nav (Repetition). The cycle set uses the SAME Degraded/Progressing threshold the badge
counts, so count and jump set never disagree. Verified live: 6 clicks visited 6 distinct troubled
namespaces and the 7th wrapped to the first; title/aria updated to "Step through the N…". Unit-tested
worst-first order, wrap, and the Unknown/Suspended/cluster exclusions.

**Log line-count readout now covers level + pod filters, not just text (live-found, 2026-06-06):**
dogfooding a real pod's logs, dimming the INFO/DEBUG level chips subset the buffer (e.g. 150 of 200
lines) but showed NO "shown/total" count — the readout was gated on the text filter alone, while the
level and pod chips (and the empty-state message, already fixed in cycle 328) silently hid lines. An
operator dropping INFO noise to scan errors had no signal that 50 lines were hidden, so a short error
list could read as "the pod barely logged." Added a `filtering` predicate (text OR a hidden level OR a
hidden pod) gating the count and the copy-button's "filtered" wording, so all three filter kinds give
identical feedback. Verified live (count "150/200" with only a level filter active; clear hover title).
Same Repetition rationale the count's own cycle-318 comment states — extended to the sibling filters.

**Navigation now reaches folded matches — count unified + auto-expand-on-select (closed TWO Open items;
shipped 2026-06-06):** the toolbar `.topology-matches` counted `matches()` over `layout().nodes` (folded
excluded → "38") while the bottom overlay counted the full set ("158"), and `j`/`k`/Enter could land
selection on a node folded behind a "+N more" pill — the drawer opened but the card wasn't drawn, so
there was no on-canvas `.selected` marker. Both are "navigation must account for folds" and shared one
fix: (1) `matches()` now iterates `props.nodes`, so the toolbar count = the honest total and agrees with
the overlay, and the Enter-cycle / position indicator ("Match 3 of 158") cover every match; (2) a new
`createEffect` on `selectedId` finds the single pill whose fold hides the selection and expands just that
one, scoped to the EXACT node (not its `related()` subtree, so selecting a hub never unfolds every
sibling). Verified live on a real staging namespace (341 resources, 15 folds): toolbar "158 matches" ==
overlay "158 of 341"; selecting a known-folded pod by exact name rendered it with its `.selected` marker
(folded→rendered transition fired only on selection, not on search alone — confirming no over-eager
unfolding). Two unit tests lock the contract. This is the navigation-aware fix both Open items called for
(NOT the rejected `collapseMatchCount`-badge approach, which would reintroduce the phantom-hit).

**Surfaced a degraded resource's failure reason in the drawer (was an Open item; shipped 2026-06-06):**
when an unhealthy resource's Events had aged out (k8s event TTL — a 3-week-old failure shows "No recent
events."), the only place the *why* lived was the manifest's `status.message`, which the operator had to
dig out via the Manifest tab + `⌘F`. The card/drawer showed the phase ("Failed") but not the reason.
Added a `Message` field to `KNode`: the server extracts it only for non-Healthy resources
(`statusMessage` in `status.go` — unstructured `status.message`, Pod blocking-condition, Deployment
problem-condition), rune-truncated to 300, threaded through `diff.go` equality + `types.ts`, and shown
under the drawer hero (`.drawer-message`, red left accent, 3-line clamp, full text on hover via `title`).
Empty for Healthy resources so the drawer stays clean. Verified live on a real staging EKS cluster: a
Failed Workflow drawer surfaced `child '…' failed` with the full reason on hover and a red accent border.
Chose truncated-in-drawer over manifest-only: the reason is the first thing an operator needs and the
manifest stays authoritative for the untruncated text.

**Capacity node labels mixed units within one pair (was an Open item; shipped 2026-06-06):** a node's
Use bar read "876m / 16" (millicores over cores) while another node read "2.15 / 16" — independent
per-value `formatQuantity` picked the unit per number, so a single "value / cap" label clashed and the
unit varied node-to-node. Added `formatPair(value, cap, res)`: the capacity (denominator) picks the
unit and both parts follow — CPU cores when cap ≥1 core else millicores, memory in the cap's binary
unit. Applied to the node-row Use/Req labels. Verified live on docker-desktop ("0.89 / 16") and a real
EKS cluster with sub-core fargate nodes ("480m / 940m", both millicores) — zero mixed-unit labels.
Chose derive-from-cap over always-cores (the option preview hinted cores even for sub-core caps): it's
more precise for small nodes and still single-unit, the actual goal. *Per-pod bullet labels left as
formatQuantity — they show one `use` against two refs (limit/request), so a single per-card unit is a
separate follow-up; node-row was the felt complaint.*

**Filter count undercounted when matches were folded (live-found, 2026-06-06):** on a real staging
namespace (57 Degraded across 144 Workflows, most folded into "+N more" pills), clicking the Degraded
filter showed the bottom overlay "15 of 341" while the pill said "Degraded 57" — two numbers for one
filter. The overlay counted `layout().nodes.filter(!faded)` (rendered, unfolded) but the health pill /
kind chips count the full `props.nodes`, so folded matches vanished from the overlay. Switched it to a
true intersection count (search ∩ health ∩ kind) over props.nodes; reworded the sr-only noun "shown" →
"match" since folded matches aren't on canvas. Verified live: "57 of 341 resources match", agreeing
with the pill. *Lesson: every count over a foldable canvas must decide explicitly whether it counts
rendered cards or true matches — mixing the two across sibling indicators reads as a bug.*

**PodDisruptionBudgets read "Unknown" health — noise that hid violated budgets (live-found,
2026-06-06):** asking "what are the Unknown 3?" on `team-a` showed all three were PDBs with no
health rule, so they fell through the CR-conditions heuristic to Unknown (a PDB's condition is
`DisruptionAllowed`, not `Ready`/`Available`). That both polluted the health tally (Unknown reads as
"something's off") and hid the real signal: a PDB whose `currentHealthy < desiredHealthy` is below its
floor and blocks drains/rollouts. Added a typed `policy/v1` health+status rule keyed on the floor
(`currentHealthy >= desiredHealthy` → Healthy, below → Degraded), status `"10/8 healthy"` (drops the
`/0` when the floor is 0). Deliberately ignores `disruptionsAllowed`/the `DisruptionAllowed` condition —
verified live it goes False for a benign reason (a PDB over Argo-Workflow pods whose controller lacks
the scale subresource → SyncFailed) though the workload is fine. Verified live: the three PDBs flipped
to Healthy with real status; the namespace's Unknown pill disappeared (Healthy 120, Progressing 1).
*Lesson: a built-in kind landing in the CR catch-all is a smell — "Unknown" health is both noise and a
missed signal. Adding a typed rule (not reinterpreting a tuned one) is a safe, invited extension.*

**Drawer dropped the status string the card showed (live-found, 2026-06-06):** dogfooding the triage
flow — spotlight a Progressing resource, click it to ask "why" — showed the drawer header reduced the
card's status ("Ready · yellow", "Unschedulable", "1/1", "Running") to a bare health-tinted icon. For
non-pod resources (CRs, Deployments) there are no container cards, so the status vanished entirely on
drill-in and the operator had to open Manifest to recover what they'd just read on the card. Echoed the
status under the name in the drawer hero, health-coloured like the card (repetition) but kept dim for
Healthy (the hero icon tint already keeps healthy quiet — a green "Running" on every healthy resource
fights that). Verified live: Progressing CR → "Ready · yellow" in blue; Healthy pod → "Running" dim.
*Lesson: drilling in should never show LESS than the card — carry the same status language through.*

**Overflowing Kinds row had no scroll affordance (live-found, 2026-06-06):** dogfooding the landing
view on `team-a` (19 kinds, 1280px viewport) showed the Kinds filter truncating ~517px of chips at
a hard right edge — `overflow-x:auto` scrolls but macOS hides the scrollbar until use, so an operator
scanning "which kinds are here" can't tell 6 more chips (incl. Workflow) continue off-screen. Added an
edge fade (mask-image) toggled by scroll position via a pure `scrollEdges()` helper: fade right at the
start ("more this way"), flip to fade left at the end, both in the middle, none when it fits. Verified
live: `scroll-r` at start → `scroll-l` after scrolling to the end; a few-kind namespace shows no fade.
*Lesson: a horizontally-scrolling row needs an explicit overflow cue — a hard truncation reads as
"that's all there is", which on a legend ("what kinds are here") actively misleads. Found by USING the
app, not surveying code — the source looked complete (styled scrollbar present), but the OS hides it.*

**Restarted container hid WHY it restarted (live-found, 2026-06-05):** a pod that the cluster had
OOMKilled overnight and then restarted showed only "Running ↻1" in the drawer — the actionable reason
(OOMKilled, exit 137 → raise the memory limit) sat in `status.containerStatuses[].lastState.terminated`,
visible only by opening and scrolling the raw manifest. Found by dogfooding a real staging pod. Server
now reads `lastState.terminated` into `ContainerStatus.LastTerminated` ("OOMKilled (exit 137)"; bare
reason on a clean exit; "exit N" with no reason; empty when never terminated, so a clean container shows
nothing), and the drawer renders it as an amber (`--health-suspended`) sub-line under the container head —
a PAST termination is a caution that stands out from the live green "Running" without reading as a current
failure, sitting next to the ↻ count it explains. *Lesson: a now-Running container can still carry the
single most useful triage fact (its last crash reason) one level down in lastState — surface it inline,
don't make the operator read YAML.*

**The Events tab was empty for EVERY resource in production (live-found, 2026-06-05):** the single
biggest find of the campaign. Since the dynamic-informer refactor (f80bab1, May 28), `"events"` lived
in `DefaultSkipKinds` (correctly — high-cardinality, short-lived) with a comment that they'd be
"queried on-demand", but the `/events` handler kept reading them from the informer snapshot, which now
never holds them — so the drawer Events tab showed "No recent events." for everything and `/events`
returned `{"events":null}`, no matter how many events a resource had. **The handler test masked it
completely** by force-eager-loading events into the cache (`EagerKinds:["events"]`) — the one config a
real deployment never uses. Found by reproducing an ImagePullBackOff pod on docker-desktop, seeing
"No recent events" despite 6 live kubelet events, and confirming `{"events":null}` from the API. Fix:
fetch events live from the API server (kubectl-describe style) via `CoreV1().Events(ns).List()`; the
snapshot still supplies the UID + owned subtree for aggregation. Dropped the `EagerKinds` workaround so
the test now exercises the real production path. Verified live: the Events tab shows the 6 events incl.
"Failed to pull image … no such host" and gains its event-count badge. *Lesson: a test that opts into a
NON-DEFAULT config (here `EagerKinds`) to make a feature work is a red flag — it can be papering over a
default-config bug. Test the production default. Persisted as an AGENTS.md "Common surprises" entry.*

**Buried container/scheduling triage info surfaced (live-found, 2026-06-05):** a theme of three
fixes, each lifting the single most actionable fact out of the raw manifest into the visible UI.
(1) A restarted-but-now-Running container's last crash reason (see the lastState entry above).
(2) A **current** `Terminated` container showed bare "Terminated: Error" with no exit code — extracted a
shared `terminatedDetail()` so the live state and the lastState read identically ("Terminated: Error
(exit 137)"; 137=SIGKILL/OOM vs exit 1=app error point at different fixes; a clean "Terminated:
Completed" still omits the code). Found on a real failed Argo workflow pod (main container exit 137).
(3) An **Unschedulable** pod read a bare "Pending" — `podStatusSummary` never read the `PodScheduled`
condition, so the #1 "why won't my pod run" answer was hidden; now it surfaces the reason
("Unschedulable") like it already lifts `Init:<reason>` / Evicted. Health stays Progressing (a
transient scheduling gap during a node scale-up shouldn't flash Degraded). Verified live with a probe
pod requesting impossible CPU on docker-desktop (deleted after). *Lesson: a Pending/Terminated pod's
WHY lives one level down — in `status.conditions[PodScheduled]` or `state.terminated.exitCode` — and is
worth lifting into the compact status text, distinct from the user-blocked full `status.message` panel.*

**Cluster-scoped resource drawer fetched an empty namespace (live-found, 2026-06-05):** selecting a
Node / PriorityClass / ClusterRole (any cluster-scoped resource) showed "unavailable" for its manifest
and "Couldn't load events." — found by dogfooding docker-desktop cluster scope and reading the network
log, which showed `.../namespaces//resources/PriorityClass/...` (empty `{ns}`, double slash → server
307→404) while the same path with `__cluster__` returned 200. Such resources carry no namespace, so the
drawer's `key()` built an empty `ns`; now it substitutes the `CLUSTER_SCOPE` sentinel (the server
already unmaps it to ""), fixing manifest + events + logs in one place. A namespaced resource selected
in cluster scope still carries its real namespace. Regression test asserts the fetch URL uses
`/namespaces/__cluster__/` and never `/namespaces//`. *Lesson: the network request log is the fastest
way to spot a malformed-URL bug the rAF-frozen headless harness otherwise hides; dogfood the drawer in
**cluster scope**, not just a namespace.*

Cycles 313–339 plus the two direct user requests (U1: log-toolbar overflow fix; U2: per-container
drawer cards pairing status+image) all shipped and are committed. The authoritative per-cycle "what +
why" is the **git log** (`git log --oneline`). Headlines: per-level & per-pod log filters, keyboard
zoom (`=`/`-`/`0`), edge-hover endpoint halo, troubled-namespace jump pulse, jump-to-error (`Shift+E`),
help-overlay shortcut docs, aria-live match count, `boundingBox`/`fitNodeSet` refactor, pan momentum,
drawer Tab focus trap, log no-wrap toggle.

**A11y focus-ring sweep (supersedes B-001):** a full `cursor:pointer` audit found B-001 undercounted —
**three** HTML buttons lacked a `:focus-visible` ring, not one (`.sidebar-retry`, `.event-source`,
`.owner-chip`). All three now get a `2px var(--accent)` outline (chip-style buttons use `1px` offset to
match `.kind-chip`/`.label-chip`). Live-verified the owner-chip ring under keyboard modality.

**CRD-removal ghost cleanup (was "Per-CRD informer stop"):** deleting a CRD left its custom resources
as ghost nodes in the topology + health rollups until restart — the reflector's failing re-List never
clears the indexer, and `reconcile()` only ever *added* GVRs. Now the CRD informer's `DeleteFunc`
evicts the matching GVR (by group+plural) from `c.resources` so snapshots skip it. Acts on the explicit
delete event, **not** a discovery diff, because `Discover()` tolerates partial results (a flapping
aggregated API would otherwise masquerade as a removed resource). The informer goroutine still leaks
(client-go has no per-informer stop) — bounded at one per removed CRD, documented in code.

**Keyboard-operable collapse pills (cycle 41, was a deferred a11y item):** the "+N older / +N more"
pill is now a focusable `role="button"` (tabindex 0, `aria-label`, `aria-expanded`) that Enter/Space
toggles via `toggleCluster` — a keyboard-only user can expand/refold a fold without the mouse. Chosen
over wiring pills into `nav.ts`'s `orderedForNav` cycle (which walks `props.nodes` and has no synthetic
pills): an SVG action button with native tabindex + Enter/Space is the standard pattern and avoids
threading synthetic pill nodes through nav. Live-verified (cycle 45): Enter toggles `aria-expanded`
true↔false. **Measurement note that cost a re-check:** toggling re-renders the pill into a *new* SVG
node (Solid `<For>` reconciliation), so a held element reference goes detached — its attributes never
update and read stale. Re-query `.collapse-pill` by selector after a reactive toggle; never assert on a
ref captured before it.

**Server-side survey (2026-05-29)** shipped three items found by surveying the never-before-surveyed
server surface: (1) **rbac** — a malformed `policy.csv` was re-parsed and re-logged every poll (10 s)
forever because `lastSum` only advanced on success; now it advances on every attempt so the error
surfaces once and only a content change re-parses. (2) **auth** — a regression test pinning that a
spoofed `X-Forwarded-Groups` from an untrusted peer is rejected (the gate runs before any header read).
(3) **store** — the test helper now tears the cache down via `Shutdown()` for deterministic goroutine
teardown. See git log for the commits.
