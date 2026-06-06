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

**First successful production-scale dogfooding (2026-06-06, staging EKS — prior sessions hit API
timeouts):** drove a real 354-node namespace (57 Degraded: 54 failed Argo `Workflow` CRs + 3 `Error`
migrate Pods + 1 Unknown `VMServiceScrape`; 146 Workflows; 27 kinds). The UI's design **holds at scale**,
confirming behaviours docker-desktop's tiny data can't exercise: per-kind severity dots correctly flag
ONLY the troubled kinds (WF + PO red, VMServiceScrape gray-Unknown; all healthy kinds dotless — the
"where do I look first" aid scales); Kind-grouping tiles + "+ show N more" folds keep 354 nodes legible;
every failed Workflow carries its `status.message` ("child X failed") in the drawer (the CR `statusMessage`
path at scale); the Degraded spotlight reports "57 of 354" honestly. One hypothesis refuted live (Pod-hero
failed-container message — see Rejected). No scale-specific bug found; the surface is scale-robust.

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
  Progressing until it passed readiness, then converged — the readiness-gated health rendering live),
  **capacity-view accuracy at production scale** (a 1-vCPU EKS node's "0.94 cores" matches kubectl's
  `940m` allocatable — not a bug; the Use/Req bars carrying DIFFERENT denominators (`Use 1.1Gi/7.6Gi`
  over `Req 6Gi/7Gi`) is the intentional capacity-vs-allocatable design, documented `capacityLayout.ts`
  324-328/499-507; the CPU/Memory toggle is a correct `role=radiogroup`/`radio`+`aria-checked`+roving-
  tabindex, so its null `aria-pressed` is right, not missing), **relationship + kind-chip legibility at
  scale** (341-resource namespace lays out in readable columns, no overlap crisis; the `.topology-kinds`
  row is a purpose-built single-line `overflow-x:auto` scroller — no clipping at a 1180px viewport). Also shipped this
  campaign: **node status text explains its Degraded dot** (e6b9290), **MetaChip extraction** for the
  drawer's labelled-fact chips (9322c65), **asUnstructuredKind** CR-essence access helper (64ed4e2),
  **aggregated Logs for any pod-owning resource** incl. Argo Workflows (f34bee8), **DescendantPodNames
  built on DescendantIDs** (47868f0), **admission-webhook-config summary** (b206cc4 — a blank
  Validating/MutatingWebhookConfiguration now reads "N webhooks · Fail|Ignore"; verified live on staging:
  `aws-load-balancer-webhook` = "3 webhooks · Fail", the Fargate/pod-identity/vpc configs = "·Ignore",
  singular "1 webhook" — the same "surface the declarative essence, not a count" seam as the IngressRoute
  middleware / NetworkPolicy peers / policy-report cycles), **aggregated-APIService backend + unavailable
  reason** (2ba815f — a blank APIService now reads "→ ns/svc" when healthy and "Unavailable · <reason>"
  when Available=False; verified live on staging: only the 2 genuinely aggregated APIServices
  (`metrics.k8s.io` → "→ metrics-server/metrics-server", `metrics.eks.amazonaws.com`) surface a backend,
  the ~70 built-in/CRD-backed groups stay silent; health already rode the catch-all Available reader so an
  unavailable aggregated API — a real group-wide outage breaking HPA/`kubectl top` — now explains its red dot).
  **User-reported (dogfooding the volumes view):** the auto-injected **`kube-root-ca.crt`** ConfigMap —
  published into every namespace and auto-mounted into every pod's projected SA-token volume — emitted a
  mount edge per pod, becoming a star hub that dominated the volumes relationship view (955dc33). Suppressed
  that one edge in `edges.go` (`isAutoMountedRootCA`); the node still appears but folds among orphans.
  Verified live via the graph snapshot API on `team-a` (341 nodes, 20 pods): the node now carries **0
  incident edges** (was a 20-pod star). The same auto-mount-noise pattern may apply to other publisher-
  injected resources — watch for them. Also: **Karpenter NodeClaim capacity/instance type** (e98eedd — a
  blank NodeClaim now reads "spot · r5dn.large" from its resolved labels, or the Ready=False reason while it
  can't provision; verified live, all 9 staging claims read "spot · <type>", making spot/interruption
  exposure scannable).
  **User-reported batch (dogfooding logs + control bar + sidebar):** (1) **merged multi-container pod logs**
  (0c767a3 — a multi-container pod now defaults to "All containers": server fans out a streamer per app
  container tagging each line, client labels by container + orders the merged buffer by emission time so
  per-container tail dumps interleave; per-container filter chips generalize the per-pod mechanism. Verified
  live on an `alloy` 2-container pod: picker defaults `__all__`, 204 lines monotonically time-ordered across
  both containers, each labelled). (2) **bigger logs when expanded** (a84b7e6 — the drawer's expand-to-canvas
  mode already existed (icon button, 81% width), but the verbose resource summary ate ~half the height even
  expanded; cap it at 30vh + scroll when expanded so the active tab panel reclaims it. Verified live: a
  22-label ES pod's summary capped 345→240px, log body +35% to 403px; lean pods unaffected). (3) **fold
  secondary relationship lenses** (b92ce55 — the 6-chip relationship row read as a wall; mark RBAC/Disruption/
  Monitoring secondary + fold inactive ones behind a dashed "+N more" disclosure (persisted), keeping the 3
  core dimensions + any active lens inline. Verified live: team-a 6 chips → "Ownership/Network/Volumes/
  +3 more", expands in place, an activated Monitoring stays inline as it folds to "+2 more"). (4) **pod
  CPU/memory usage gauges** (3b5386e — the pod drawer now shows a compact gauge per resource: live usage
  fills toward the limit (or request) with a request tick, recolouring amber near-limit / red past-limit; a
  resource with no request/limit reads as a dashed "unset" track, not a misleading full bar; usage keyed from
  the capacity feed by UID == node.id. Verified live: ES pod "Mem 2.6Gi / 4Gi lim" @64%, "CPU 23m / unset").
  The batch's "declutter the sidebar" half is **left open pending the user's specifics** — ResourceSummary is
  already kind-gated (a Pod shows only pod-relevant blocks), so blindly removing facts risks dropping ones
  other operators rely on; the metrics gauge added the "nicest feature" half of the ask.
  **Dogfooding the monitor namespace:** **VictoriaMetrics operator CR health** (1e589dd — VMAgent/VMAlert/
  VMRule/VMServiceScrape/VMNodeScrape report `status.updateStatus` or a `<qualified>/Applied` condition, not
  Ready/Available, so the catch-all called all 49 of them Unknown — a whole-namespace gray false alarm.
  Mapped updateStatus→health + Applied fallback; verified live: monitor 49 Unknown → 0. Same class as the
  CRD/FlowSchema condition-less-config-CR fixes — **watch for other operators' non-standard status fields**).
  **HPA + ApplicationSet health** (e629880 — the last two Unknown kinds on staging. HPA's ScalingActive=False
  (silently stopped autoscaling, usually an unreadable metric) → Degraded, ScalingLimited=True (at a bound) is
  normal/ignored; ApplicationSet's ErrorOccurred=True → Degraded. Verified live: **the whole staging cluster
  now has 0 Unknown dots across every namespace** — the condition-less-control-CR false-alarm class is fully
  drained on this cluster).
  **Node usage gauges** (4ef6096 — the pod-gauge cycle left a gap: selecting a Node showed only static
  capacity, never live load, unless you switched to the Nodes layout. Generalized the gauge over its ceiling
  (Pod → limit/request, Node → allocatable); usage past allocatable flags as pressure. Verified live: a node
  drawer in cluster-scope shows "CPU 61m / 940m alloc", "Mem 1.1Gi / 7Gi alloc"). Pod-gauge configs all
  verified live too: unconstrained (dashed "unset"), request-only ("2m / 100m req"), request+limit (tick).
  **Gauge unit consistency** (1a96e68 — the gauges used formatQuantity, so a 1-core node's 940m allocatable
  read "940m" in the drawer but "0.94" in the capacity track: same number, two visual languages = Repetition
  broken. Switched to formatPair keyed on total capacity → node reads "0.05 / 0.94 alloc" matching its track;
  pods unaffected. Self-introduced inconsistency caught by dogfooding the node gauge against the capacity view).
  **Dogfooded mature (docker-desktop + staging), no gap:** the degraded-PDB flow (opa-b "0/3 healthy" is
  faithful — a real CalculateExpectedPodCountFailed misconfig; drawer surfaces the reason inline + Events badges
  it), the failed-Workflow triage (status→drilled message→aggregated step logs), the Manifest tab (YAML/JSON/
  find/copy), and the gauge on docker-desktop (metrics-server present). **Lesson: when adding a value display,
  reuse the existing formatter (formatPair) for the same quantity — don't reach for a different one.**
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

- **Triage-aware fold representatives in the connectivity/ownership view** — *follow-up to the
  kind-view fix (9d4438c); high value (default view), deferred on risk.* `layoutGraphByKind` now
  floats health-filter matches into a folded kind box's visible slots so the box's face shows the
  trouble. The connectivity view (`layoutGraph`) has the SAME gap in its three fold paths —
  `foldSiblingSubtrees` (explicitly "status-agnostic", layout.ts:166, the Workflows-under-
  WorkflowTemplate case), `orphanBlock`, and `collapseHubLeaves` (via `layoutComponent`). The
  `splitForFold` `prioritize` predicate already exists and caps visible at `COLLAPSE_VISIBLE` (no
  layout explosion); the work is purely plumbing it through those four functions, health-filter-gated
  in Topology's connectivity branch (a click → dagre relayout, acceptable; keep live search fade-only).
  **Why deferred:** 4× the plumbing of the kind-view fix, touching the most intricate dagre / subtree-
  dragging / hub-leaf edge-bundling code with the default view as blast radius — and the connectivity
  view already has the badge ("● N match") + Enter-cycle auto-expand + auto-fit mitigations, so the
  value/risk ratio is lower than the kind-view fix was. **Reopen as:** a dedicated cycle with live
  verification across all three fold paths (sibling subtrees, orphan blocks, hub leaves) on staging.

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

- **Container / step picker for multi-container pod logs** — *surfaced dogfooding the Workflow logs
  flow; medium value, deferred.* The server already accepts `?container=` and now defaults to `main`
  (bc94db7), but the client offers no UI to switch containers, so an operator can't read a pod's
  sidecar (istio-proxy, a log-shipper) or a specific Workflow step. The general fix is a container
  dropdown in the log toolbar. **Blocker for the aggregated/completed case:** the client can't populate
  it — a finished Workflow's pods are display-dropped, so their container names aren't in the client
  graph; needs the server to expose the available containers (pairs naturally with the per-node
  `hasLogs` flag below). **Reopen when:** an operator needs sidecar logs or to isolate one workflow
  step.

- **Logs tab for any workload CRD with only completed pods** — *follow-up to the completed-run-logs
  fix (e5c190c/e792b9d); low value, deferred.* The server (`BuildForLogs`) now reaches a finished
  resource's completed pods, and the client shows a Logs tab for `Workflow` via `LOGGABLE_KINDS`. But
  any OTHER pod-owning workload CRD whose pods all completed (Tekton `PipelineRun`/`TaskRun`, a custom
  operator's job CRD) still hides its Logs tab: `hasDescendantPod` can't see the display-dropped pods
  and the kind isn't in the hardcoded set. **Proper fix:** the server computes a per-node `hasLogs`
  (ownership over `BuildForLogs`) and the client gates on `node.hasLogs` instead of the kind list +
  client-side descendant walk. **Reopen when:** a non-Argo workload CRD with completed-only pods needs
  logs, or the hardcoded `LOGGABLE_KINDS` Argo entry feels too special-cased.

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

## Done

Shipped improvements, newest first. **git log is the authoritative per-change record** (Conventional
Commits carry the full WHY); these one-liners are just the index — the verbose rationale that used to
live here was redundant with the commits and is trimmed (2026-06-06 condensation). Hashes shown where a
single commit maps cleanly; otherwise search the title in git log.

### 2026-06-06 operator-dogfooding campaign
- The Nodes view now lets you click a node's NAME to open the Node's drawer (capacity, taints, conditions, labels), and shows the FULL node name (keeping the …compute.internal domain). Two operator-reported gaps: (1) the whole card was the expand target, so the Node resource itself was unreachable by click — only its pods were selectable; the name now selects the Node (stopPropagation keeps it apart from the body's expand), links on hover, and a selected node accents its name + frame like a selected pod segment. (2) The header truncated each node to its hostname to save width, but it sits on its own line above the bars so the FQDN never collides — an operator reads it end-to-end. Verified live on staging EKS: clicking ip-10-8-107-153.…compute.internal opened its drawer (940m vCPU, 110 pods); selected name+frame measured accent rgb(77,139,240) (749be8e, 8177eb8)
- A Service's pod selector is now shown in the drawer — the cause behind its most common failure ("no endpoints" = the selector matches no ready pod). kd surfaced selectors for NetworkPolicies and ServiceMonitors but not Services, so triaging "why no backends?" meant opening the manifest. Rendered as a labelled chip carrying the caution tint exactly when endpoints total 0 (the selector is then the suspect — a typo'd label / renamed workload); selectorless Services omit it. Found dogfooding a real scaled-to-zero Service on dev-cluster; verified live (c453dae)
- The legacy core/v1 Endpoints kind is now skipped like EndpointSlices already was. kd derives endpoint readiness from Service selectors and never reads the Endpoints object (no spec rendering for the kind), so each per-Service Endpoints surfaced only as an edgeless orphan card duplicating its Service — 6 cluttered one staging namespace, in every view. The same DefaultSkipKinds rationale that hides EndpointSlices applies verbatim. Verified live on staging (223→217 nodes; Service readiness unchanged at 2/2, selector-derived) (4315b4a)
- The combined "All containers" log view now shows the time column by default. A multi-container pod merges its containers' streams by emission time, but the column display gated on the manual timestamps toggle (off) — so the merge fetched + sorted by time yet hid it, leaving the operator with init/wait/main lines shuffled together with no anchor (read as an arbitrary jumble). Default timestamps ON when entering combined mode (honest in the toggle, still overridable). Found + verified live on staging on a 3-container pod (b34e695)
- A health/kind triage filter whose matches are scattered (e.g. 55 Degraded across a 340-resource namespace) now frames the SINGLE most-troubled match (severity-ordered) instead of bailing the auto-fit. The readability guard rightly refuses to fit-all to an unreadable ~0.04× speck, but leaving the viewport put stranded the operator on the faded healthy cards they happened to be on — every match off-screen, the Enter-cycle/clickable-count affordance being search-only and absent under a health filter. Now a triage filter always lands on a real result (the worst one). Found + verified live on staging team-a (flies to a Pod in Error at 2.5×); tight clusters still fit-all (24e231d)
- The auto-injected kube-root-ca.crt ConfigMap is now dropped from the graph entirely. The prior fix suppressed only its mount edges (killing the star hub) but left it as a lone orphan node floating atop every namespace view — still the verbosity it was flagged for. Dropped at the build filter (single source of truth); with no node its edges drop automatically (link skips unknown targets), so the two scattered per-edge guards became dead code and were removed. Verified live on staging team-b (orphan gone, counts 224→223) (df5ad8d)
- The drawer now rolls up a workload's live usage from its replicas: a Deployment/StatefulSet/DaemonSet has no metrics of its own, so the CPU/memory gauges were Pod/Node-only and an operator had to open each replica to answer "how much is this using vs reserving?". Pure client-side sum — walk descendant pods (mirroring the logs traversal), sum usage + requests/limits, gauge the total like a Pod with a "summed across N pods" caption; a bound stays defined only if some replica sets it, the rollup is suppressed until ≥1 replica has a reading, and the caption notes partial metering. Verified live on staging: coredns (2 replicas) read "CPU 3m / 200m req · summed across 2 pods" = exactly 2× a single pod's bounds (badaf12)
- Kyverno/wgpolicy policy reports (PolicyReport, EphemeralReport — 57 in one staging namespace) now classify by their result summary (fail/error > 0 → Degraded) and show the tally as status ("1 skip", "2 fail, 3 pass") instead of reading Healthy-by-existence with a blank status + opaque UUID name — a failing report (policy violation) was invisible in the health tally/Degraded filter. Handles both summary nestings (Kyverno spec.summary, wgpolicy top-level); the path was a live-only bug the unit test missed. Verified live (0cb87b8)
- A Traefik Middleware card/drawer now shows WHAT it does ("rateLimit 10/1s, burst 20", "forwardAuth → …", "redirect → https") instead of just kind+name+age — the complement to the IngressRoute "via <middleware>" chain, so clicking through to a middleware finally answers "what is this?"; common types enriched, others fall back to the bare type name. Verified live on staging (c810a3b)
- A NetworkPolicy now lists each rule's actual peers + ports ("Ingress 50051/TCP ← ui-a, team-b/api-b, workflows.argoproj.io/workflow exists, …") instead of a bare "Ingress: 1 rule" that answered nothing about "who can reach these pods" (and hid that an empty rule = allow-from-anywhere); cross-namespace peers ns-qualified, ipBlock as CIDR, empty peer list = "anywhere", deny-all preserved. Also drops selectorSummary's empty "()" for valueless Exists ops. Verified live on staging — api-a's "1 rule" was actually 6 sources (2bf0d78)
- A satisfied PodDisruptionBudget now reads "2 healthy" instead of "2/1 healthy" — the old form mirrored the replica "ready/desired" fraction, but a PDB has current ≥ floor (not ≤ target), so "2/1" read as an impossible "2 of 1" (Repetition violation). The fraction now shows only in deficit ("6/8 healthy"), where it reads correctly; the headroom is on the "can disrupt N" chip. Verified live on staging (171949f)
- A Traefik IngressRoute's routing row now shows its middleware chain (" · via ratelimit, team-b/auth-forward") in spec order, cross-namespace qualified — the auth/rate-limit/header-rewrite processing was invisible (operator had to open the manifest to answer "is this route authenticated?"), and a cross-namespace middleware can't appear as a same-namespace edge so the row is its only surfacing. Verified live on staging (7cf1c7d)
- The drawer's "Labels · N" disclosure now actually collapses: `.label-chips { display: flex }` on a direct child of `<details>` out-cascaded the UA `details:not([open]) > :not(summary){display:none}`, so the chips showed whether open or closed and a 22-label wall (ES pod operator-internals) sat above the tabs on every drawer open — the summary was a dead toggle. Re-hidden via `.drawer-labels:not([open])`. Found + verified dogfooding an ES pod on staging (c508760)
- The namespace Nodes (capacity) view now floats nodes running THIS namespace's pods to the top (alphabetical within each group) instead of sorting all cluster nodes alphabetically — on staging, 5 team-a nodes were buried among 9 tracks, so "where do my pods run" took a hunt; cluster scope stays plain alphabetical (every pod is own). Verified live (7e98d66)
- A failed Argo Workflow's hero status now ranks the PRIMARY step's failure above its onExit/hook handler's: a Slack-notify exit handler that itself failed (RBAC denied on workflowtaskresults) finished later and so won the most-recent tiebreak, showing the operator a red-herring instead of the real "main: Error (exit code 1)"; hooks (named `<wf>.onExit…`/`.hooks.…`) are now deprioritized vs primary steps. Found + verified dogfooding a real failed auth-sync Workflow on staging (d3ed4c9)
- Filtering the Kind view by a health legend (e.g. Degraded) now floats matching cards into each kind box's visible slots instead of the name-ordinal head+tail — a 145-Workflow box that read "2 succeeded + 1 failed" now shows 3 failed reps + "● 51 match" pill, so the box's face matches what the operator filtered for (splitForFold prioritize predicate, wired through layoutGraphByKind, health-filter-gated to keep live search fade-only); verified live on staging (9d4438c)
- A Terminating namespace now reads as Progressing health + "Terminating" status (matching kubectl's STATUS column) instead of a calm green Active — the "stuck namespace" blocked by a finalizer is exactly what an operator hunts for; verified live against a deliberately-wedged namespace (d3c5536). Closed a leftover test gap: nodesEqual's Scrapes comparison was uncovered (1b830e1)
- A StorageClass now surfaces its default marker (was invisible everywhere) + provisioner as the hero status, dropping the redundant provisioner chip so it reads as the headline; completes the cluster-scoped legibility set CRD/PriorityClass/IngressClass/StorageClass (fad924f)
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

