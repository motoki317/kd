# kd — Improvement backlog

Persistent, **git-tracked** backlog of improvement ideas, tech debt, and longer-term tasks — so they
survive across agent sessions and are visible to human contributors. This is the durable home for
such tasks; `docs/plans/` is gitignored single-session scratch and must **not** hold the backlog.

How to work it: the **`improvement-cycle`** skill (`.claude/skills/improvement-cycle/`) describes how
to discover, adversarially verify, and ship items; the **`backlog-management`** skill describes the
format and lifecycle of this file. The per-item evidence (`file:line`) and the verdicts are what make
an entry actionable — keep them.

**Status (2026-06-05, batch 3):** Continued a11y + dogfooding sweep. Shipped: copy-success live region
(`role=status`) so screen readers hear the CopyButton confirm; **completed the single-select a11y sweep**
by converting the drawer's Manifest YAML/JSON toggle to a `role=radiogroup` (the last bare-`.active`
pick-one control). The rest of the batch was **adversarial refutation** — most candidates this lens
surfaced were already-handled or measurement artifacts: a "light-theme renders dark chips / fails AA"
pair was two agent-browser measurement bugs (a `transition: background` reads stale under headless
getComputedStyle after a runtime theme toggle; a naive parser mis-reads `color(srgb …/α)` backgrounds),
both themes are AA-compliant; the topology search's Enter-cycle + "N of M" indicator already exist
(cycles 284–285); graph nodes are intentionally not per-node tabbable (search-cycling is the keyboard
path, verified end-to-end); the empty-state is already state-aware. Lessons persisted to
`dogfooding-kd-ui.md` ("Measurement pitfalls" section). Signal: the UI surface is genuinely thinning —
this batch was ~1 ship + 1 a11y completion per several refutations. The earlier same-day status follows.

**Status (2026-06-05, cont.):** A second dogfooding+refactor batch (cycles 12–18) shipped on top of the
pass below. Theme: the "UX surface mature" claim had a real **accessibility blind spot** — prior surveys
never audited ARIA roles, yet the drawer tabs were `aria-pressed` toggles (not a tablist) and the
single-select Group/Resource segmented controls were `role=group`+`aria-pressed` (not radiogroups). Fixed
both to the proper WAI-ARIA patterns with a tested `rovingFocus` arrow-key helper. Also shipped: **(a)**
auto-frame matches when a health/kind filter toggles — *with a readability-floor guard* found necessary
live (the naive fit zoomed scattered matches to a 0.04× speck); **(b)** completed+de-drifted the help edge
legend (was missing `usesServiceAccount`), derived from the edge taxonomy; **(c)** three pure-logic
extractions slimming the 2100-line Topology.tsx (`capacityTooltips`, `edgeRender`, `cardTitle`→`names`),
each now unit-tested. Knowledge persisted to `dogfooding-kd-ui.md` (new bug class: auto-fit-to-scattered →
speck; a11y control-role conventions). Lesson reinforced: "surveyed mature" ≠ mature — a *new audit lens*
(here, ARIA) finds real gaps the prior lenses structurally missed. Remaining a11y TODO logged in the
playbook (sidebar list, drawer action buttons, log controls, drawer focus-on-open). The earlier same-day
status follows.

**Status (2026-06-05):** A live-dogfooding pass (drive the real UI with agent-browser, not just tests)
found that the **maturity claim below did not hold for the fresh Nodes-capacity surface, viewport-edge
behaviour, or empty-data paths** — areas a test suite structurally misses. Nine cycles shipped, several
high-impact: **(1) namespaces with no edges hung forever on "connecting…"** — `graph.Build` returned a
nil Edges slice → `"edges":null` → the client's `[...g.edges]` threw inside the SSE listener before
`connState` went live (every system / standalone-resource namespace was unusable; fixed both ends).
**(2) SSE capacity flood** — the ~40KB cluster-wide capacity payload was re-sent on every store change
(Lease heartbeats!), ~280KB/7s on an idle namespace; gated on real graph change. **(3) Nodes expand
fit** zoomed OUT to 4px cards; **(4) pod-card click** zoomed OUT instead of onto the bars; **(5) help
overlay** overflowed the viewport with no scroll; **(6) capacity tooltip** clipped off-screen at edges;
plus a stale sidebar comment. Knowledge persisted to the **`dogfooding-kd-ui.md`** playbook (recipes +
recurring bug classes: fit-zoom direction, viewport-edge clipping, swallowed EventSource-listener throws,
nil-Go-slice→`null`). Lesson: a passing test suite is NOT a maturity signal for interaction/edge/empty
paths — dogfood them. See `git log` for the commits. The earlier (2026-05-29) status follows:

**Status (2026-05-29):** UX surface mature (cycle 339: 16 candidates → 1 low-value). This session
drained the backlog via the improvement-cycle: the **`Open` queue is empty**. The one Open item (B-001)
shipped as a 3-button a11y sweep, and one Future item shipped as a correctness fix (CRD-removal ghost
cleanup). Every remaining Future item was re-examined against the real code and **deferred with a
verified rationale + a reopen trigger** (see below) — they are genuine design-pass / deployment-pressure
work, not safe improvement-cycle slices. Two workflow-proposed "small wins" were refuted on inspection
(a store summary cache — regressive because `notify()` has no namespace granularity; a discovery-diff
CRD prune — unsafe because `Discover()` tolerates partial results).

A follow-up survey then covered the **server-side** surface (store/informer lifecycle, registry, rbac/auth,
api/sse, kubeconfig/bootstrap) — never systematically surveyed before. 31 agents, mostly refuted
(already-handled / wrong / low-value) = the same maturity signal. It shipped three real items (malformed
`policy.csv` re-parse/log-spam fix; an auth groups-gating regression test; deterministic store-test
teardown) and rejected the rest — notably "shut the caches down on SIGTERM," which one agent rated HIGH
but is in fact low-value (Go reaps background goroutines on process exit; the process-lifetime cache design
is intentional and documented). Both the UX and server surfaces are now surveyed and mature; the next batch
should come from real user feedback or a new feature area — don't grind filler cycles.

---

## Open

- **Capacity bar `value / capacity` labels mix units, hurting at-a-glance comparison** — *verified
  live (cycle 22, staging-cluster Nodes view), needs a unit-policy decision before implementing.*
  `formatQuantity` (`web/src/layout.ts:834`) picks a unit per value by magnitude, independently for the
  numerator and denominator. So a node's Use bar reads `85m / 1` (millicores / cores) while its Req bar
  right below reads `860m / 940m` (both millicores) — the two stacked capacities of ONE node (`1` =
  1000m total, `940m` allocatable) render in clashing units and don't visibly read as "both ≈1 core".
  Memory has the same straddle (`512Mi / 8Gi`). The bar LENGTH already encodes the ratio, so this is a
  label-readability refinement, not a correctness bug. **Why deferred:** the fix is a `formatPair(value,
  cap, res)` that formats both parts in the capacity's unit, but the unit policy is a genuine
  user-judgment call with real tradeoffs — always-millicores (`85m / 1000m`, kubectl-native but verbose
  `64000m` on big nodes) vs cores-for-≥1 (`0.09 / 1`, concise but lossy small decimals). The capacity
  view is a heavily-tuned, user-iterated surface (see the extensive CLAUDE.md note, which says don't
  reinterpret it without the user), so pick the unit policy WITH the user, then ship `formatPair` +
  tests. **Reopen:** when the user states a preferred unit policy for paired capacity labels.

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

- **Keyboard-operable collapse pills** — *deferred (a11y nicety).* The "+N older" pill is mouse-clickable
  but not in the `nav.ts` Tab/Enter cycle (`orderedForNav` walks `props.nodes`, which has no synthetic
  pills), so a keyboard-only user can't expand a fold. Low traffic (the data is still reachable by
  searching, which auto-badges hidden matches). *Reopen when:* a keyboard-nav a11y pass is on the table —
  then make pills focusable and Enter-toggle them, reusing `toggleCluster`.
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
| Shut registry/informer caches down on SIGTERM (call `Cache.Shutdown()` / thread the signal ctx) | low-value — Go reaps background goroutines on process exit, so there is **no** slow-shutdown/forced-kill (one agent's HIGH verdict was wrong); the process-lifetime cache is intentional + documented (`registry.go:240-241`). `Shutdown()` is now exercised by the store test helper instead. |
| Panic-recovery wrapper around SSE graph build / `superviseLogStreams` goroutines | wrong — HTTP handlers are already wrapped by `server.recoverer`; graph ops have no panic paths; a recover() would mask real bugs |
| Log/handle `json.Marshal` failure in `writeSSE` | low-value — Patch/Summary/Graph are all primitive-typed; marshal cannot fail. Real failures are network writes, already handled |
| `VisibleNamespaces` should gate on `*`/any-resource instead of hardcoded `pods` | already-handled — pods-as-namespace-visibility-gate is the documented RBAC design (ADR 20260527); operators grant blanket access in target namespaces |
| Validate `-addr` / invalid env durations in `config.Load` (fail earlier) | low-value — `ListenAndServe`/flag parse already give clear errors ~100 ms later; no operator pain |
| Sort in-cluster `List()` context order; `defer debounce.Stop()` in sse.go | low-value — in-cluster has a single context (switcher hidden); the debounce timer is GC'd and is not a race |
| Light theme renders dark toolbar chips / fails AA contrast | refuted — a measurement artifact, not a bug. Runtime theme toggle leaves the chips' `transition: background` stale under headless Chrome (getComputedStyle returns the pre-toggle colour); a fresh load in the target theme reads correctly. The "sub-AA" numbers came from a naive parser mis-reading `color(srgb …/α)` backgrounds. Both themes are AA-compliant. See dogfooding skill "Measurement pitfalls". |
| Add a match-count / Enter-cycle hint to the topology search | already-done — the `.topology-matches` element shows "N of M"/"no matches" and the input + count titles already document Enter/Shift+Enter cycling (cycles 284–285). Verified live ("6 of 21"). The earlier probe just queried the wrong class |
| Make graph nodes keyboard-focusable (tabindex) for keyboard selection | wrong — 33+ tabbable SVG nodes would be tab-order noise. The keyboard path is search-cycling (⌘K → type → Enter/Shift+Enter steps matches → drawer → `[`/`]` tabs → arrow keys); verified end-to-end. Don't add per-node tab stops |
| Harden / improve the multi-cluster context-switch flow | already-robust — verified live on a 5-context kubeconfig: the `.ctx-switcher` native `<select>` shows friendly cluster names from ARNs (aria-label "Kubernetes context"), preserves the namespace across clusters, shows a clean Connecting→loaded transition (no hang on a ~15s EKS first sync), and a non-existent `?ns=` gracefully falls back to a real namespace (URL self-corrects, no empty strand). No change needed |

## Done

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

**Server-side survey (2026-05-29)** shipped three items found by surveying the never-before-surveyed
server surface: (1) **rbac** — a malformed `policy.csv` was re-parsed and re-logged every poll (10 s)
forever because `lastSum` only advanced on success; now it advances on every attempt so the error
surfaces once and only a content change re-parses. (2) **auth** — a regression test pinning that a
spoofed `X-Forwarded-Groups` from an untrusted peer is rejected (the gate runs before any header read).
(3) **store** — the test helper now tears the cache down via `Shutdown()` for deterministic goroutine
teardown. See git log for the commits.
