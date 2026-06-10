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
· first-run landing · unreachable-context diagnosis.

Recent batches (newest first; one line per slice — `git log` carries the full WHY per commit):

- **2026-06-10 b18 (dead-context offline; two repaint gaps; light-theme audit)** — dogfooding an
  unwalked error path (a kubeconfig context whose endpoint is dead, via a scratch kubeconfig) caught
  the canvas promising "connecting…" forever: the namespace-list failure meant no namespace was ever
  picked, the subscribe effect never ran, and nothing moved connState — it now goes offline, refetches
  the contexts list, and the existing canvas diagnosis names the cause; the offline pill's retry also
  refetches the list. Delegated graph-package survey (1 real / 9 refuted) caught Service.Selector
  missing from nodeEqual (stale "why no endpoints" chip on endpoint-neutral selector edits); following
  that thread found Allocatable/CapacityRes/Requests/Limits also uncompared (stale node size on a
  hot-resized VM) — fixed, and the diff test tables are now exhaustive with a reflective
  decides-every-field check so an undecided Node field can't ship again. Light-theme audit across all
  three views + drawer: clean (token-driven by construction; recipe recorded in the dogfooding skill;
  the log pane's deliberate dark ground now has its WHY in CSS). Client-core survey: 0 real / 11
  refuted — App.tsx/api.ts SSE wiring joins the mature surfaces. Layout survey: 2 nominal
  (gridDims(0)/blockDims(0) NaN) refuted as unreachable (every callsite filters non-empty first).
  First-run walk (cleared storage, bare URL): clean — lands on the most-troubled namespace by design.
  README + hero screenshot + AGENTS.md/frontend-internals pointers verified current.

- **2026-06-10 b17 (gauge ADR; store survey; goroutine-leak fix)** — the attribution-vs-totals gauge
  design arc recorded as an ADR (per-card self-gauging, plain-fill pod sum, by-pod workload split
  default, truthful-zero rule) so the next redesign starts from the rationale, not archaeology.
  Delegated adversarial survey of internal/kube/store+registry: 10 candidates, 8 refuted by the
  surveyor, 1 refuted on triage (CRD-reconcile capturing Start's ctx IS the intended teardown
  contract), 1 shipped — Start launched its ctx→stopCh watcher before Discover could fail, so each
  bad kubeconfig context (built exactly once, against Background) leaked one forever-parked
  goroutine; the launch now sits after the failure exit. LogViewer toolbar split rejected (no clean
  state seam — see Rejected). Favicon badge + Events tab re-verifies were probe bugs, not app bugs.

- **2026-06-10 b16 (ManifestPanel; finished-run logs honesty; emergency shapes re-verified)** — the
  manifest tab's whole fetch+find cluster (format radiogroup, keyed resource, query, match stepping,
  per-node reset) extracted into ManifestPanel (the KindFacts seam applied to DetailDrawer, 731→567;
  live-verified find count, format refetch, marks surviving the toggle). A finished run (Succeeded
  Workflow with GC'd pods) read "waiting for log output…" forever — terminal statuses now get "this
  run already finished — no log output remains" (exact-match statuses only; evicted pods carry
  free-text). Live walks: induced OOM crashloop reads "↻ 3 · 28s ago" + "Terminated: OOMKilled
  (exit 137)" on a red card with honest empty bars; the by-pod default split exposed a real 4×
  memory imbalance between two replicas of one workload; Kind view at 218 resources / 23 kinds;
  aggregated workload logs at 405 lines. Delegated adversarial survey of internal/api: 10
  candidates, 10 refuted (context propagation, ticker cleanup, RBAC, wire contract all pinned) —
  the server layer joins the mature surfaces.

- **2026-06-10 b15 (structure for future changes; secondary projections matured; URL alias)** — the
  drawer's per-kind facts blocks (300+ lines of Show blocks every spec-chip change touches) extracted
  whole into KindFacts.tsx with their MetaChip/KeyValRow idioms (pure move, live-verified identical);
  spec.go's routing extractors (Ingress/HTTPRoute/Traefik, the likeliest growth point — GRPCRoute
  pends) split into spec_routing.go; segment palette moved into UsageGauges with its consumers (the
  ContainerCards export was an inverted dependency). `rels=disruption` (the VISIBLE label) now
  aliases the stable `scheduling` id — a hand-edited URL guessed from the UI was silently dropped,
  PDBs read as plain orphans (cost a confused round live; parseRels moved to relationships.ts +
  tests). RBAC/Disruption/Monitoring projections all walked live against real shapes → mature list.
  Delegated adversarial survey of the fresh gauge code: 10 candidates, 8 refuted (4 by the surveyor
  itself), 2 small hardenings folded (keyed-Show OOM warning; caption-row flex-wrap). README names
  the workload rollup + split; AGENTS.md gains the gauge-modules row.

- **2026-06-10 b14 (pod summed gauge returns; workload split by pod/container — user-directed)** —
  the pod drawer shows the summed gauge again ABOVE the per-container cards (both reads matter: total
  at a glance + per-container attribution below; plain fill, no re-keying); the workload rollup's
  fill now splits one segment per POD by default (an uneven replica IS the finding — an 8-replica
  DaemonSet read one pod at 3-4× its siblings live; segments use the topology's "…-suffix" names so
  legend and canvas agree) with a persisted caption-row toggle to the per-container-name split
  (kd:workloadGaugeBy); stack aria prefix names the active split (ef9d163). Verified at phone width
  (toggle row + 8-item legend fit 390px) and across a context switch (pref survives). Earlier same
  day: induced near-OOM re-verified against the per-card design (91% Lim fill + hatched Req
  overshoot + amber words on the at-risk card only); near-OOM recipe expectation updated.

- **2026-06-10 b13 (per-container bars land on the cards — user-directed)** — a pod's gauges moved
  ONTO its container cards: each card gauges its own usage against ITS req/lim (a pod-summed gauge
  can't say which container is near the ceiling), retiring the bounds text row and the pod-level
  stack/swatches; stacks + legend stay workload-rollup-only; UsageGauges extracted to its own module
  (8ad8eb3). Restart counts date their last restart ("↻ 3 · 2h ago", 6f913a2). Follow-ons caught by
  re-reading the fresh code + live dogfooding: the host-node "Node" ceiling had silently become
  unreachable for running pods — restored per-card (7297211); a 2m reading under a cores-keyed
  ceiling rendered "0 / 1" — a non-zero side now borrows its natural unit instead of displaying as
  zero, both sides guarded (26d0e2c). Verified live on a real 2-container pod (per-card bars, near-
  request memory reads directly), a 1-container pod (pod-total fallback), and a workload stack +
  legend; frontend-internals gauge section rewritten to the new contract. Rejected: Req=Lim bar
  collapse (see below).

- **2026-06-10 b12 (saturation legibility; evicted pods; gauge internals doc)** — a saturated HPA's
  replicas chip reads "2 · at max" caution-tinted (ScalingLimited stays no health signal — only the
  TooManyReplicas reason marks it; TooFewReplicas idling at the floor stays unmarked; induced-verified
  live with a CPU-spin under maxReplicas:2, 3eca308). An evicted pod surfaces kubelet's status.message
  cause ("The node was low on resource: memory…") instead of a bare red "Evicted" (24b912f). Drawer
  gauge invariants (shared scale, segment stacks, workload remainder, spec-on-cards/usage-in-bars)
  documented in frontend-internals (one read for the next contributor). Saturated-HPA + stuck-rollout
  recipes added to the dogfooding catalogue. Flow-verified seamless: the right-sizing review — one
  click per workload shows summed usage vs req/lim ("2m / 20m" = over-provisioned at a glance), no
  fake bars for undeclared bounds. Refuted as already-handled: suspended CronWorkflow (Suspended
  health + status), paused Deployment ("Paused"/Suspended), pod-level scale chips on cards (drawer
  is the right home).

- **2026-06-10 b11 (segment vocabulary completed; ops-docs accuracy; stuck rollout)** — the workload
  gauge stacks fleet-summed per-container segments with an explicit dim "not yet attributed"
  remainder (6a70c7a) and a swatch+name legend, since no cards follow it to key the colours
  (f44d452); stacks carry a per-container aria-label (shares were hover-only — a11y regression of
  the redesign, 253296b); rendered sha256 digests truncate to 8 hex chars (a config-reloader ref
  wrapped 3 lines, 4b895c2). Chart docs: the narrow-RBAC example silently killed every usage gauge
  (no metrics.k8s.io rule — added) and the eagerKinds example claimed events could be cache-fed
  (they can't, always live; README + values.yaml, 2 commits). Stuck-rollout shape (induced
  progressDeadlineSeconds + failing probe): the Available tautology beat "ReplicaSet … has timed
  out progressing" on array order — ranking now explicit, Available last (405ae6b). Delegated
  re-survey of every changed drawer/log file: 4 candidates, 3 refuted on read (swatch flex:none IS
  0 0 auto; drawer-status sits inside the hero's padding; gone-signal reset is pre-paint and a
  closed EventSource delivers no late events), 1 folded as a one-line wrap-defence on legend items
  — the ~94% refutation rate holds even on freshly-changed code.

- **2026-06-10 b10 (per-container display matures user-directed; container-card module)** — the pod
  gauge's fill now stacks one coloured segment per container (hover names the share; total width
  unchanged), keyed to each card by a square swatch, and cards show declared bounds with every
  number labelled ("cpu req 10m | mem req 128Mi · lim 128Mi") instead of repeating live usage —
  user-directed redesign in two rounds of feedback (3825567; the earlier text-row form: 921406f →
  1bd2349 → 7be4aa4, whose live round caught the smaller-side unit rule rendering "320Ki/65536Ki").
  The OOM alarm survives as words on the at-risk card (≥90% of its own memory limit; induced-shape
  verified end-to-end with a 91%-of-limit pod — recipe added to the dogfooding catalogue). Container
  cluster + image-ref helpers extracted to ContainerCards.tsx / ImageRef.tsx (the drawer's hottest
  evolution spot now lives in a 165-line module; pure move, 069's commit). README caught up
  (monitoring category, per-container usage). Refuted: "HPA floats as an island" — the convention
  ref-scanner already links HPA -[refers]-> its scale target (verified against a live graph).

- **2026-06-10 b9 (WCAG contrast pass + per-container usage)** — a computed-luminance walk over
  every visible text element found the dark theme's lighter accent (#4d8bf0) sinking white control
  text to 3.35:1; new `--on-accent` token flips to near-black on dark (5.6:1) across the four
  text-bearing accent fills, and `.log-json-extra` lifts 4.14→5.2:1 on the fixed-dark log pane
  (b1bd510). The audit's off-screen sibling: white on vivid `--health-degraded` badges measured
  3.7:1 at 10px bold — `--degraded-badge` (#c73e36, the existing degraded-text ink) carries the
  sidebar trouble count + warning-events tab at 5.0:1, vivid hue kept for dots/borders/fills
  (088fb42). User-requested: a pod's container cards now show each container's live cpu/mem share
  (joinUsage keeps metrics-server's per-container breakdown for multi-container pods; client joins
  by name) — "which container is eating the memory?" without `kubectl top --containers`; verified
  live, shares sum exactly to the pod gauge (921406f). Deferred idea (needs a dependency): CronJob/
  CronWorkflow "next run" chip — no cron-expression parser in go.mod; reopen only if a parser
  arrives for another reason or the ask recurs from a user.

- **2026-06-10 b8 (storage/DS shapes, triage flow, RBAC flow)** — a Released+Retain PV reads
  Suspended (amber, waits on an operator forever) instead of Progressing (promised motion that
  never comes), and names the stale claimRef blocking any new bind (22f17a7). A DaemonSet shows its
  node selector as a chip, caution-tinted at 0/0 — "which nodes does this run on" lived only in the
  manifest, and a selector matching nothing is exactly why a DS shows a contented 0/0 (35049d4).
  A URL-seeded namespace that can't open (RBAC-denied / deleted / absent from a switched context)
  now says so in a transient dismissible strip instead of silently landing the operator on the
  fallback view (9f03da1; found by driving kd under a restrictive policy.csv with -default-role "").
  Flow-verified mature (no seams): the morning-triage journey on a real cluster — trouble badge →
  worst namespace → j → Degraded pod drawer → owner chip to the failed Workflow (its real deadline
  message in the headline) → Alt+Left back → j onward; zero mouse trips after the badge click.
  Restricted-operator view verified: sidebar lists only permitted namespaces, no [cluster] row.

- **2026-06-10 b7 (HPA, STS chain, logs-gone, API survey)** — a broken HPA explains itself: its
  fault lives in ScalingActive/AbleToScale, neither of which the generic CR condition reader scans,
  so a non-functioning autoscaler was a red card with no words; also "1 → 0" (desiredReplicas=0 =
  "couldn't compute") no longer renders as an impossible scale-to-zero (5fa839c). Logs viewer says
  when the tailed resource was deleted — supervisor signals `gone` once per transition (zero-pod
  mid-rollout gaps stay silent by design), viewer renders a terminal notice or an end-of-stream
  marker at the tail; verified live with a delete-while-tailing round (e5a5a7b; the lines-on-screen
  case was caught live — a final kubelet noise line had defeated the empty-state-only first cut).
  Delegated API error-path survey: graph-SSE stale-out judged a deliberate trade-off (selection/
  filter preservation beats disconnecting); events 502 wording left as-is (8s repoll masks
  transients); 403 naming, context-unreachable, deleted-manifest, empty-slice contracts all verified
  handled. Verified already-handled shapes: broken sidecar (right container red, "not ready" named),
  STS + unbindable PVC chain (pod points at the PVC, PVC events name the missing class), event ×N
  gloss live (coalesced BackOff ×5). Docs drift fixed: frontend-internals capacity scale rule
  (7ec575e); induced-failure recipes catalogued in the dogfooding skill (b0ff111, b6).

- **2026-06-10 b6 (correctness under induced shapes + refactor/survey wave)** — biggest catch: a
  typo'd NAMED targetPort showed a false "1/1 ready" (readiness derives from selector matches since
  Endpoints objects are deliberately uncached) — pods now count Ready only when a port resolves, and
  the service says `targetPort "http" matches no container port name…` (f209067; regression-scanned
  39 staging namespaces: zero false flags). A pending pod requesting more than the biggest node drew
  its Unscheduled track kilopixels off-canvas and poisoned auto-fit — the scale now keys on
  max(capacity, demand), node rows shrink proportionally, which IS the honest 1:4 picture (839d392).
  A cordoned node row says "· cordoned" in amber with a gloss — bar-wise it looked identical to a
  healthy node (b611788). Failed-Job/finalizer/tautology slices continued b5. Event "×N" gets a
  plain-words hover (59bb2a2, the Manifest+Events survey's sole survivor — that surface verified
  mature otherwise). Refactor survey (narrow lens, last 30 commits): one real seam — the quota chip
  had copied the data-keys " · " split renderer; extracted KeyValRow (7c5f861); status.go per-kind
  condition scans judged genuinely different (no helper), theme tokens mirrored, server/client
  defaultLogContainer in lockstep. Induced-failure recipes catalogued in the dogfooding skill doc
  (b0ff111). Verified already-handled: unschedulable pod headline (full scheduler message survives
  the ContainersNotReady filter); PVC/OOM shapes (b5).

- **2026-06-10 b5 (induced-failure shapes + drawer width)** — drove the failure states a beginner
  actually hits, against live induced resources. Quota-blocked Deployment: headline now shows the
  ReplicaFailure cause ("exceeded quota: …") instead of the Available tautology ("does not have
  minimum availability") that array-order picked (ad07a1a); the red RS card beside it explains itself
  too — RS ReplicaFailure surfaced, its only condition type (206d7c2); clicking the quota itself now
  answers "how much room is left" — ResourceQuota drawer shows used/hard per resource via the data-key
  chip idiom, ResourceQuota registered in typedFactories (bdfebc1). Readiness-probe failure: a Running
  container failing its probe says "Running · not ready" in words + a probe hover, where only the dot
  hue changed before (b74e348). **User-reported fix:** drawer header action icons (expand/share/close)
  overlay on a surface pill instead of flexing beside the summary — every summary row (bars, chips,
  container cards) regains ~100px; only the hero reserves clearance (239864d); regression-passed on
  production shapes (long names, init containers, scrolled summary, both themes). Delegated
  first-load/sidebar survey: [cluster] row hover now explains "Resources outside any namespace —
  Nodes, PersistentVolumes, ClusterRoles" (69c1e46); refuted: breadcrumb placeholder during connect
  (low-value — conn pill + canvas already say "connecting…", crumb appears on the fast namespace-list
  fetch); empty-ns ServiceAccount wording expansion (current text already names it as Kubernetes-added);
  offline selection-loss warning (selection IS preserved when the resource survives); "(default)"
  context-switcher gloss (self-evident to its multi-context audience).
  Second wave (same induced-shape method): failed Job headline says it has given up — the Failed
  condition message ("reached the specified backoff limit") replaces ambiguity about retrying
  (67d416e); a pod stuck Terminating names the finalizer holding it, the "kubectl delete hangs"
  dead end (ab9a375); the ContainersNotReady tautology ("containers with unready status: [main]")
  is suppressed from pod headlines — status summary + container cards say it better (70eea09).
  Verified already-handled: Pending PVC (drawer opens on Events showing "storageclass not found" +
  class chip); OOMKilled (CrashLoopBackOff status + "last exit: OOMKilled (exit 137)" chip + restart
  badge, one click from the canvas).
- **2026-06-10 b4 (beginner first-run dogfooding)** — fresh namespace says "this namespace is empty"
  plainly instead of the unconnected-orphan riddle (4af7105); drawer gauge rows stop printing their
  bound name twice ("Req — / 25m req" → bare value/bound, capacity-view repetition) (d869e92); Nodes
  view Req/Use axis labels gain hover glosses + "(+59 other-ns)" speaks plainly (c3b7ee8); Kind view
  shows full pod names — the tree's "…-suffix" parent dedup leaked into a view with no parent context,
  making api/web pods indistinguishable (875a179). Delegated URL/deep-link survey: ~all refuted —
  bogus `?kinds=` lands on the existing "No resources match" overlay + clear button (verified live);
  unmatched `?sel=` auto-degrades (prior verdict); orphans/capRes/sel-mangling are hand-edit-only
  shapes on machine-written URLs (low). URL surface verified mature.
  Also: a waiting container's state now carries its root-cause message — "Waiting: ErrImagePull —
  …not found" instead of the bare reason; CrashLoopBackOff keeps reason-only (its message is backoff
  mechanics, the cause lives in the last-exit chip) (dbb5822, induced ImagePullBackOff flow).
  Waiting-message re-verified on the second key shape: CreateContainerConfigError reads
  `…— configmap "missing-config" not found` live (the beginner's most common config mistake names
  its missing object in one click). Refuted: "Nodes view misleads with 0-usage when metrics-server
  is absent" — already-handled, the `hasUsage:false` canvas hint says "metrics-server unavailable —
  bars sized by requests" (CapacityView.tsx honesty hint).
  Delegated refactor survey: **0 qualifying candidates — internal organization verified healthy.**
  The per-kind accretion in spec.go/ResourceSummary.tsx is intentional (5 small places per kind, the
  build.go inventory stays at-a-glance; a registry would obscure it); selector/CR-essence logic
  already centralized (selectorSummary, asUnstructuredKind, MetaChip); Topology.tsx is large because
  it IS the orchestrator — no seam extracts without prop-drilling (CapacityView was the clean one,
  done). Source future refactors from a concrete blocked change, not re-surveys.
- **2026-06-10 b3 (beginner-first structural sweep)** — three delegated audits (UI text, docs, feature
  surface) + first-run dogfooding. Shipped: backlog condensed 718→366 lines (519210e); 40+ tooltips/
  hints/help entries rewritten to beginner-plain English, jargon dropped ("solo", "yank", "SSE")
  (a965c9c); README hero screenshot from fictional demo data, TODOs dropped (2831e75); deleted-banner
  text halved. **Feature-surface audit verdict: already restrained** — controls are contextual (kind
  chips/health pills/orphan toggle appear only when relevant; secondary rels already fold), and the
  audit's fold candidates (level chips → dropdown, severity dots removal, theme/share/JSON demotion)
  each trade away an explicit affordance for little chrome; kind abbreviations are kubectl-canonical
  short names (PO/SVC/DEPLOY/CM). Do not prune features without a concrete beginner-felt pain. Docs
  audit: README/charts/ADRs/internals all appropriately sized; the bloat was backlog-only (fixed). — light-theme troubled-text contrast: --degraded-text /
  --progressing-text inks + healthTextColor, statuses/reasons now ≥4.5:1 in light (6f46508);
  ExternalName service's inert selector no longer fakes "no endpoints" Degraded (cd61d25) + address-chip
  title made type-neutral (21ca62e); "headless" address sentinel explains itself, no bogus copy
  (bbe7502); long chip values wrap inside the chip instead of escaping the drawer (16b8ef9).
- **2026-06-10 b1 (phone/touch + a11y + folds)** — phone overlays inert the covered canvas (890429a);
  NARROW_SCREEN_QUERY consolidated into screen.ts; deleted-resource drawer banner + ghost selection
  no longer fades the canvas (e6b2901); drawer full-width phone overlay (b2cb445); topbar fits 375px
  (50d3c07); two-finger pinch zoom (d2654f6); sidebar toggle + phone sidebar overlay (d5d3489);
  capacity Fit frames the drawn layout, not hit-boxes (14b4db3); triage-aware fold representatives in
  the connectivity view (c15ab85); workload gauge sums its bound over the metered pods (24b240a);
  filtered count pill doubles as a frame-the-matches button (5291ac7); Alt-click copies an event;
  policy 403s name themselves; pending LB external address explains itself; HPA "metric" chip + ArgoCD
  Application dest/rev chips; offline context shows the cache-build error; near-limit notch survives
  tiny segments; aggregate-fold tooltips name the click action; capacity hover-spotlight recedes whole
  node rows (7f18088); CapacityView extracted from Topology.tsx; favicon badge reflects the whole
  cluster; sidebar trouble-count aria-live; share URL round-trips Nodes-view pods (3-part sel);
  Service selector copyable; finished-but-empty previous logs end with a `done` event, not a spinner;
  Nodes-view count speaks pods · nodes.
- **2026-06-06→09 (operator-dogfooding, drawer/CR legibility)** — merged multi-container logs with
  per-container chips (0c767a3); drawer expand reclaims summary height (a84b7e6); secondary
  relationship lenses fold behind "+N more" (b92ce55); pod CPU/memory usage gauges (3b5386e) → node
  gauges (4ef6096) → unit consistency via formatPair (1a96e68); VictoriaMetrics operator CR health
  mapped (1e589dd); HPA ScalingActive + ApplicationSet ErrorOccurred → Degraded (e629880; 0 Unknown
  dots cluster-wide); kube-root-ca.crt mount-edge star suppressed (955dc33) then the node dropped
  entirely (df5ad8d); Karpenter NodeClaim "spot · type" (e98eedd); admission-webhook-config summary
  (b206cc4); aggregated-APIService backend + unavailable reason (2ba815f); usage-gauge overshoot laps
  (c87185a→82b3655); Nodes view clickable node names + full FQDN (749be8e, 8177eb8); Service pod
  selector chip, caution at 0 endpoints (c453dae); legacy Endpoints kind skipped (4315b4a); combined
  log view defaults timestamps on (b34e695); scattered triage filter frames the worst match (24e231d);
  workload usage rollup across replicas (badaf12); wgpolicy/Kyverno reports classify by summary
  (0cb87b8); Traefik Middleware says what it does (c810a3b); NetworkPolicy lists real peers + ports
  (2bf0d78); PDB "2 healthy" not "2/1" (171949f); IngressRoute middleware chain (7cf1c7d); labels
  disclosure actually collapses (c508760); this-namespace nodes float first in Nodes view (7e98d66);
  failed Workflow ranks primary step over exit-handler (d3ed4c9); Kind-view health filter floats
  matching cards into visible slots (9d4438c); Terminating namespace reads "Terminating" (d3c5536).
- **2026-06-05 b1–b5 + 2026-05-29** — edgeless namespaces hung on "connecting…" (nil edges → client
  throw); SSE capacity flood fix; expand-fit zoom direction; ARIA tablist/radiogroup sweep + rovingFocus;
  copy-success live region; cluster-scope drawer `{ns}` 404 fix; frozen-compositor harness pitfalls
  persisted (rAF, drawer-in keyframe); server-surface survey (policy.csv re-parse, auth groups test,
  store teardown). Lessons live in the skills; per-fix detail in git log.

Small deferrals from these batches (reopen on operator ask): per-line truncation for multi-KB log
lines; logs-header chip stacking at phone width; co-routed multi-type edges draw identical paths;
drawer-overlay Tab-bleed at phone width + modal-help inert siblings; TopologyToolbar extraction;
manifest format-toggle drops the find scroll anchor; one unreproduced ghost-clear on SSE reconnect
(watch for it).

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

