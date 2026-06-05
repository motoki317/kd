# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks — so they
survive across agent sessions and are visible to human contributors. This is the durable home for
such tasks; `docs/plans/` is gitignored single-session scratch and must **not** hold the backlog.

How to work it: the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`) describes how
to discover, adversarially verify, and ship items; the **`backlog-management`** skill describes the
format and lifecycle of this file. The per-item evidence (`file:line`) and the verdicts are what make
an entry actionable — keep them.

**Status (2026-06-05):** Both the **UX surface** and the **server surface** have been systematically
surveyed and are **mature** — at a mature surface ~94% of generated candidates get refuted, so source the
next batch from real user feedback or a new feature area, not filler re-surveys. Recent batches drained
the Open queue and hardened tests; the durable lessons are persisted in the `improvement-cycle` skill
(especially `dogfooding-kd-ui.md` "Measurement pitfalls"). **Do NOT redundantly re-verify** the surfaces
marked clean below — re-dogfood one only if its code changed.

Recent batches (newest first; `git log` has the commits):

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

- **A pressured-but-Ready Node reads "Ready" while its health dot is Degraded** — *found in code while
  surfacing pod triage info (2026-06-05); NOT yet verified live (couldn't safely induce node pressure /
  NotReady on docker-desktop — filling a disk or killing a kubelet is destructive).* `nodeHealth`
  (`health.go:87`) returns Degraded when `MemoryPressure`/`DiskPressure`/`PIDPressure` is True, but
  `nodeStatusSummary` (`status.go:138`) only ever returns `Ready`/`NotReady`(+`,SchedulingDisabled`) — so
  a node with DiskPressure=True but Ready=True shows a red/Degraded dot next to the text "Ready", and the
  *why* (which pressure, or the NotReady condition's reason like `KubeletNotReady`) is buried in
  `status.conditions`. Mirror the just-shipped pod fix: have `nodeStatusSummary` append the active
  pressure (e.g. "Ready · DiskPressure") and/or the NodeReady reason when NotReady, so the status text
  matches the health colour and explains it. **Before shipping, verify live against a genuinely
  pressured/NotReady node** (a real cluster that has one, or a kind/minikube node you can safely stress)
  — a status-string change alone is unit-testable, but the directive wants the real unhealthy-node render
  confirmed. Keep health classification unchanged (pressure already → Degraded; don't re-decide it).

- **`j`/`k` nav can select a folded node, which then has no on-canvas cue** — *verified live (cycle
  74, a remote staging cluster, a busy namespace: 132 nodes / 16 collapse pills folding ~70 Failed
  Workflows); the pill-badge omission is DELIBERATE — this is a narrow refinement, not a bug.*
  `orderedForNav` walks the FULL `props.nodes` (folded included) and `j`/`k` step "troubled first", so
  in a namespace whose troubled resources are mostly *folded*, `j` lands selection on a hidden node:
  the drawer opens (full info) and the spotlight fades the rest, but there's **no `.selected` marker**
  because the node isn't rendered (it's behind a "+N more" pill). Measured: visible nav target → 1
  on-canvas marker; folded target → 0. **Why this is mostly by-design:** the collapse-pill match badge
  (`collapseMatchCount`, `Topology.tsx:552-567`) *intentionally* fires only for an EXPLICIT query
  (search / health filter), NOT for selection — the comment spells out why: a selected resource lights
  its whole `related()` subtree, so badging every hidden sibling in it would read as a phantom search
  hit. So "nav doesn't badge the pill" is a considered choice, not an oversight. **The narrow residual:**
  badging the ONE pill that contains the *exact* selected node (≠ badging the whole subtree) would
  reveal where a nav-selected folded node lives without the phantom-hit problem — but that distinction
  may have been deliberately skipped for simplicity. **If reopened:** the only defensible change is a
  cue scoped to the single pill whose `meta.hidden` includes `selectedId` (e.g. an outline), wired
  where `selectedId` changes — NOT a `collapseMatchCount`-style badge (that path is correctly
  query-only). Low priority: the drawer already carries full info and the operator can expand the
  nearby pill. *Don't "fix" by making selection feed `collapseMatchCount` — that reintroduces the
  phantom-hit the comment guards against.*

- **Surface a degraded resource's status message for faster triage** — *verified live (cycle 44,
  a remote staging cluster, a busy namespace: a 21-day-old Failed Workflow), needs a scope/format
  decision.* When an
  unhealthy resource's Events have aged out (k8s events have a TTL — a 3-week-old failure shows "No
  recent events."), the only place the failure reason lives is the manifest's `status.message`, which
  the operator must open the Manifest tab and `⌘F "message"` to find. The card + drawer show the phase
  ("Failed") but not the *why*. `KNode` carries only `status?: string` (the phase, e.g. from
  `health_cr.go` `crPhase`); the server never extracts `status.message`. **What it takes:** a new
  `Node.Reason`/`Message` field populated for degraded resources (server: read `status.message` — present
  for Argo Workflows/Rollouts and many CRs, absent/irrelevant for Pods which use container statuses),
  thread through `diff.go` equality + `types.ts`, and show it in `ResourceSummary` for degraded nodes.
  **Why deferred (not a quick fix):** it's server+client across the user-iterated health pipeline;
  `status.message` format varies wildly by kind (some are long/multi-line) so it needs a per-kind or
  truncation policy; and whether the summary *should* carry it vs. keeping the manifest authoritative is
  a genuine design call (the phase-on-card + detail-in-manifest split may be deliberate). **Reopen:**
  when the user wants failure reasons in the drawer summary and states the kind/format policy.

- **Capacity bar `value / capacity` labels mix units, hurting at-a-glance comparison** — *verified
  live (cycle 22, a remote staging cluster Nodes view), needs a unit-policy decision before implementing.*
  `formatQuantity` (`web/src/capacityLayout.ts`, moved there from layout.ts in the cycle-36 split) picks a unit per value by magnitude, independently for the
  numerator and denominator. So a node's Use bar reads `85m / 1` (millicores / cores) while its Req bar
  right below reads `860m / 940m` (both millicores) — the two stacked capacities of ONE node (`1` =
  1000m total, `940m` allocatable) render in clashing units and don't visibly read as "both ≈1 core".
  Memory has the same straddle (`512Mi / 8Gi`). The bar LENGTH already encodes the ratio, so this is a
  label-readability refinement, not a correctness bug. **Why deferred:** the fix is a `formatPair(value,
  cap, res)` that formats both parts in the capacity's unit, but the unit policy is a genuine
  user-judgment call with real tradeoffs — always-millicores (`85m / 1000m`, kubectl-native but verbose
  `64000m` on big nodes) vs cores-for-≥1 (`0.09 / 1`, concise but lossy small decimals). The capacity
  view is a heavily-tuned, user-iterated surface (see the capacity-view ADR + `docs/frontend-internals.md`,
  which say don't reinterpret it without the user), so pick the unit policy WITH the user, then ship `formatPair` +
  tests. **Reopen:** when the user states a preferred unit policy for paired capacity labels.

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
| "Expanding a busy node in the Nodes view doesn't bring its pods into view" (viewport stays put, ~6/46 cards visible) | **harness artifact, NOT a real bug** (cycle 78, a remote staging cluster, a 46-pod node). Root-caused by instrumented logging: **`requestAnimationFrame` callbacks never fire in the headless agent-browser session** (proven: `requestAnimationFrame(cb)` leaves `cb` unrun after 3s while `document.visibilityState === 'visible'` and `setTimeout` works). EVERY non-initial viewport move in kd is rAF-driven (`animateTo`'s tick loop; `fitCapRowExpanded`/`fitCapBox`/selection-fit all `requestAnimationFrame(() => animateTo(...))`), so when an expand is driven via `agent-browser eval`-dispatched clicks the viewport CANNOT move — the only fit that lands is the very first one, because `firstFit` sets `scale/tx/ty` DIRECTLY (Topology.tsx, not via `animateTo`). The expand logic itself is correct (synchronous `capRows().find` returns fresh geometry; `fitCapRowExpanded` top-anchors a tall stack). Do NOT "fix" `toggleCapRow` with rAF deferrals — that was tried and reverted (equally invisible to the harness, and unnecessary). To verify any pan/zoom/fit/animation behaviour, assert the *computed target* in a unit test, or use a HEADED browser — never an agent-browser viewport measurement. See dogfooding skill "Measurement pitfalls" (rAF). |

## Done

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
