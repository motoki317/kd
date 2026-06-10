# Dogfooding kd's UI with agent-browser — playbook

Concrete recipes + recurring bug classes for driving kd's **actual** UI, distilled from live
improvement cycles. Read this alongside `SKILL.md` step 5 (VERIFY LIVE) and AGENTS.md
("Verifying UI changes live"). The rule that makes dogfooding pay off: **measure the thing you
changed with `eval`, don't just eyeball a screenshot.** Unit tests miss what these catch
(viewport-edge clipping, fit-zoom direction, coalesced events, SVG hit-targets).

## Setup (once per change)

```bash
just build                                                  # MUST rebuild — embed_web bakes the client in
pkill -f 'kd -dev-user'; ./kd -dev-user dev -addr :8099 &   # then poll /healthz
```
Run agent-browser from a subshell so it never shifts the persistent cwd:
`(cd /tmp && agent-browser <cmd>)`. SSE settle: ~6 s local (docker-desktop), ~12–16 s a remote
EKS context's FIRST informer sync. JS for `eval --stdin` MUST be an IIFE `(() => { … })()`;
**each eval is a fresh scope only if you wrap it** — bare `const r = …` in two evals collides, so
always wrap. Dispatch real events on the element (`el.dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
`elementFromPoint(x,y)` returns null when the point is off-viewport or over the toolbar.

Session repair + regime switches (each cost real time to rediscover):

- **`screenshot` wedging on "Resource temporarily unavailable … daemon may be busy" while `eval`
  keeps working** → the screenshot pipe is stuck, not the page: `agent-browser close` then a fresh
  `open` fixes it for the rest of the session. The page may come back as `about:blank` after a
  wedge — check `location.href` before blaming your last click.
- **Phone-regime testing**: `agent-browser set viewport 375 667` (a `set` subcommand — there is no
  `--viewport` flag on `open`), then `location.reload()`. Reverse with `set viewport 1280 800`.
- **Touch gestures**: synthetic `new PointerEvent('pointerdown', {pointerId, pointerType: 'touch',
  clientX, clientY, bubbles: true})` drives kd's pointer handlers in the live page — measurable
  because the pan/pinch paths set tx/ty/scale signals synchronously (no rAF, unlike animateTo
  fits; see pitfall 5). Verifies handler logic only — browser-native gesture interception is
  covered by `touch-action: none`, not testable headless.
- **`kd:*` localStorage prefs persist across opens and poison "default state" tests** — a pref
  written by an earlier toggle (e.g. `kd:sidebarHidden`) masks the no-pref default you're trying
  to verify. `localStorage.removeItem('kd:…')` + reload before asserting defaults.

## Dogfood against real scale

`docker-desktop` (1 node, ~58 pods) exercises the many-pods-on-one-node path; a real EKS context
(`?ctx=<arn>`) gives production shapes (varied node sizes, near-zero usages, 9 nodes). **Never let a
real ctx/cluster/namespace/ARN name reach a tracked file** — keep it in the browser session only
(see AGENTS.md leakage rule). URL-encode an ARN ctx before putting it in the open URL.

### Safely inducing an unhealthy state to verify its render

Some health/status fixes can't be dogfooded because no resource on a reachable cluster is currently
unhealthy, and the "honest" way to induce it sounds destructive (fill a disk, kill a kubelet, OOM a
pod). Don't skip live verification — **inject the condition on the disposable `docker-desktop` cluster
via the `status` subresource**, which the controller self-reverts within seconds, so it's
non-destructive:

```bash
# Make a node read Degraded: flip its DiskPressure condition True (kubelet reverts in ~10s).
idx=$(kubectl --context docker-desktop get node docker-desktop -o json \
  | perl -MJSON::PP -0777 -ne '$j=decode_json($_);my@c=@{$j->{status}{conditions}};print$_ for grep{$c[$_]{type}eq"DiskPressure"}0..$#c')
kubectl --context docker-desktop patch node docker-desktop --subresource=status --type=json \
  -p "[{\"op\":\"replace\",\"path\":\"/status/conditions/$idx/status\",\"value\":\"True\"}]"
```

Because the kubelet/controller reverts it, **read the render in the same breath** — query
`/api/v1/contexts/<ctx>/namespaces/__cluster__/graph` for the server's `status`/`health`, or re-inject
right before an agent-browser `eval` that reads the card class (`g.node.h-degraded`) + label. This
solved the long-standing "can't safely test a pressured/NotReady node" blocker (node-status fix
e6b9290). The same subresource trick induces other rollup states (a Pod phase, a Deployment
unavailable-replica count) on docker-desktop — prefer it over a destructive real action, and over
shipping a status-string change on unit tests alone when the directive wants the render confirmed.

**Last verified clean at production scale (2026-06-05):** a real EKS staging cluster (72 nodes / 39
namespaces) — cluster-scope relationship layout had **0 overlapping node cards** (the `placeColumns`
depth-column layout holds), cluster- and namespace-scope capacity bars had **0 overshoot rows**
(Σuse-segments ≤ track width on every row; the namespace fold drew own/`other`/`small` aggregates
correctly), and a real multi-container pod's drawer rendered init-before-main container cards with no
width overflow. Also re-verified clean the same day: the **Logs viewer** controls all carry correct
`aria-pressed` (level filters ERR/WRN/INF/DBG = shown→`true`; timestamps/wrap/case/previous = `false`)
plus `title`/`aria-label` on every button; long **EKS node hostnames**
(`ip-10-…compute.internal`) don't overflow their `.cap-node-frame` (the char-count width reservation
holds); and **Kind pluralization** is centralized — `pluralizeKind` is the only Kind-pluralizing path,
every other `${…}s` pluralizes a regular English noun (pod/line/resource/node). So these surfaces are
mature — the bar to re-dogfood them is "did the layout / capacity geometry / drawer-card / logs-toolbar
code change", not "every cycle". Reusable overshoot check:
`for each .cap-track.use, assert max(.cap-seg.use at same y).right ≤ track.right`. Overlap check:
pairwise screen-rect intersection of `.node .node-bg` (>4px on both axes = a real overlap). Node-name
fit check: `getBBox().right` of each `.cap-row text` ≤ its `.cap-node-frame` right edge.

**Reaching a staging/EKS context (it starts `pending`).** kd lazy-loads each context's informer on
first access, so a remote cluster shows `status:"pending"` in `/api/v1/contexts` until you touch it.
Trigger the sync by requesting its namespaces — `curl --max-time 25 ".../contexts/<urlenc-arn>/namespaces"`
(URL-encode the ARN). First sync is ~15–25s and the very first call after a cold start can return empty
or time out — just retry once; it goes `ready` and stays warm. Only then will `?ctx=<arn>` render in the
browser without a long blank.

**Verified scale-robust 2026-06-06 (staging, a 354-node namespace — 57 Degraded: 54 failed Argo
`Workflow` CRs + 3 `Error` Pods + 1 Unknown `VMServiceScrape`; 146 Workflows / 27 kinds):** the
per-kind **severity dots** (`.kind-chip-dot`) flag ONLY troubled kinds (WF+PO red, VMServiceScrape gray;
healthy kinds dotless) — the "where do I look first" aid scales; **Kind-grouping** tiles + "+ show N more"
folds keep 354 nodes legible; every failed Workflow shows its `status.message` ("child X failed") in the
drawer; the Degraded spotlight pill reads an honest "57 of 354"; the **trouble-badge / Alt+T** cycle steps
all 5 troubled namespaces worst-first and `scrollIntoView`s each (incl. ones below the alphabetical
fold) — assert `.ns-list .active` rect ⊂ `.ns-list` rect after each click. **Caveat — homogeneous
trouble:** this cluster's failures are *uniformly* degraded Argo Workflows, so it's ideal for density/scale
but NOT for failure-type variety (use docker-desktop's status-subresource injection, above, for a specific
unhealthy shape). One hypothesis refuted here: a failed Pod needs no hero `message` — its failed container
card is already red-tinted and high in the drawer (see backlog Rejected).

## Capacity (Nodes) view — interaction recipes

This view is the hardest to unit-test (geometry + viewport fit + SVG). Recipes:

```js
// Expand / collapse a node row: click the frame at an empty spot (NOT a segment — those select a pod)
(() => { const f=document.querySelector('.cap-node-frame.clickable'); const r=f.getBoundingClientRect();
  const x=r.right-60,y=r.top+6; document.elementFromPoint(x,y).dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:y})); })()

// Measure expanded pod-card readability (the metric that matters):
(() => { const f=document.querySelectorAll('.cap-bullet-frame'); const b=f[0].getBoundingClientRect();
  return JSON.stringify({count:f.length, cardH:+b.height.toFixed(1), cardW:+b.width.toFixed(1)}); })()

// Click a pod card (selects + zooms to read its bars); measure it GREW, didn't shrink:
(() => { const b=document.querySelector('.cap-bullet'); b.dispatchEvent(new MouseEvent('click',{bubbles:true})); })()

// Hover-spotlight + tooltip: pointermove a segment, assert most others get .faded + a .cap-tooltip appears
(() => { const s=document.querySelector('.cap-seg.use:not(.other):not(.small)'); const r=s.getBoundingClientRect();
  s.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2})); })()
```
Key classes: `.cap-node-frame[.clickable][.expanded]`, `.cap-seg.use|.req[.other|.small][.faded][.selected]`,
`.cap-bullet` (g) + `.cap-bullet-frame` (card rect), `.cap-bar-value` (the "use / cap" labels),
`.cap-tooltip` (cursor-following). Resource toggle = the CPU/Memory buttons; persists to `kd:capRes`.

## UX-gap patterns found by operator dogfooding (a different lens than the harness traps below)

Distinct from the harness/measurement artifacts: these are *real* gaps a human feels by USING the app,
that a source survey misses because the code "looks complete." The 2026-06-06 campaign kept finding them
at a surface the source-survey called mature — the lens (run a real operator flow), not the code,
surfaced them. Look for these shapes on any view:

- **A scrolling row with no overflow cue.** `overflow-x:auto` scrolls but macOS hides the scrollbar
  until use, so a truncated row (the Kinds filter) reads as "that's all there is" — actively misleading
  on a legend. Fix = a scroll-position edge fade (`scrollEdges` + mask classes). Check: any single-line
  `overflow-x` row — does it cue more content? (`scrollWidth > clientWidth` with no fade = the gap.)
- **Drilling in shows LESS than the card.** The drawer dropped the status string the card showed
  ("Ready · yellow") to a bare icon tint. Carry the same status language through (card → drawer →
  manifest). Check: for each fact a card shows (status, restarts, age), does the drawer still show it?
- **A count over a foldable canvas mixes "rendered" with "true match."** The bottom overlay counted
  visible-unfaded nodes ("15 of 341") while the health pill counted the full set ("57") — folded matches
  vanished from one but not the other. Decide per-counter explicitly: rendered-cards vs true-matches
  (`props.nodes` filter), and keep sibling indicators on the same basis. Check: filter on a namespace
  where matches FOLD (a real cluster), compare every visible count against the pill/chip totals.
- **A built-in kind landing in the CR catch-all → bogus "Unknown" health.** PDBs fell through
  `crHealthFromConditions` (their condition is `DisruptionAllowed`, not `Ready`/`Available`) to Unknown
  — both noise in the tally AND a hidden real signal (a below-floor PDB blocks drains). Adding a *typed*
  rule (health.go + status.go + typedFactories) is a safe, invited extension; reinterpreting a tuned
  rule is not. Check: in cluster scope, what kinds show "Unknown"? A built-in there is a smell.
- **A drill-in path that dead-ends at the resource that explains nothing.** Triaging a degraded PDB
  ("0/3 healthy") led nowhere — a PDB selects pods like a Service but had no edge, so the failing pods
  that explain it were unreachable. Run the *whole* triage flow (most-troubled ns → Degraded filter →
  drill in → "why?") and notice where it stops. Fix = the missing edge (`EdgeGuards`, Scheduling
  category). Check: from each degraded resource, can you navigate to what's actually broken?
- **Your edge-case DEFAULT, validated only on synthetic fixtures, is wrong for the real data's shape.**
  The PDB-guards edge's first cut skipped *empty* selectors as "too noisy" — and the real degraded PDB
  had exactly an empty selector (the namespace-wide "protect everything" pattern), so the feature still
  dead-ended the case it existed for. Unit fixtures used a populated selector and passed. **Lesson:**
  after a feature passes tests, dogfood it against the REAL resource that motivated it — the actual
  shape (empty selector, never-run cron, unset field) routinely differs from the tidy fixture, and only
  live data exercises the default you guessed. This is *why* the loop mandates live verification.
- **A derived/auto-injected object kd never reads, shown as a node, is pure orphan or duplicate noise.**
  Kubernetes auto-creates per-resource machinery the operator never manages: the kube-root-ca.crt
  ConfigMap (every namespace), the core/v1 Endpoints object (one per Service). kd computes what it needs
  another way — endpoint readiness from Service *selectors*, not the Endpoints object — so these objects
  carry NO edge and NO spec rendering, surfacing only as edgeless orphan cards (6 Endpoints cluttered one
  staging namespace) or a star hub (every pod mounts kube-root-ca). **Tell (canonical):** EndpointSlices
  were already in `store.DefaultSkipKinds` ("we use Service selectors") while its twin Endpoints was not —
  an existing skip whose rationale a sibling kind matches verbatim is the strongest signal. **Fix ladder:**
  if kd reads the object nowhere and renders no spec → drop it at `DefaultSkipKinds` (cheapest, also frees
  memory); if it's a real resource with useful drawer content but a pathological *edge* (the root-CA star)
  → drop the node at the build filter so its edges fall away (`link` skips unknown targets) instead of
  guarding each inferrer. **Check:** in any view, are there cards with no edges AND a bare name (no status/
  ports/keys in the drawer)? Count them per namespace — one-per-Service or one-per-namespace cardinality
  is the fingerprint. Owned children with a real parent (AWS CNI PolicyEndpoint under its NetworkPolicy)
  are NOT this — they're structured, leave them.

## Recurring bug classes found live (check these on any UI change)

1. **Fit-zoom DIRECTION.** A "zoom to X" must enlarge X. The Nodes expand fit zoomed *out* (fit a
   58-card stack's full height → 4px cards); the pod-card click zoomed *out* (fit the full
   capacity-width card whose bars are a tiny left slice). Lesson: a length-encoded view's meaningful
   axis is its WIDTH — fit to the bar/content region, not the tall stack or the empty card; top-anchor
   an over-tall stack. **Measure cardH before vs after — assert it grew.**
2. **Viewport-edge clipping of fixed/absolute/cursor-following elements.** The help overlay grew past
   a laptop viewport with no scroll; the capacity tooltip clipped off the right/bottom edge. For ANY
   such element: cap to `calc(100vh - …)` + `overflow:auto`, or flip to the cursor's other side near
   an edge. **Hover the far-right / bottom and assert `rect.right ≤ innerWidth`, `rect.bottom ≤ innerHeight`.**
   Native `<select>` dropdowns and SVG `<title>` tooltips are OS/browser-positioned — they DON'T clip,
   so they need no handling.
3. **SVG hit-targets.** A rect with `pointer-events:none` is not clickable; a card's empty fill must
   carry pointer-events for the whole card to be a target. Verify with `elementFromPoint` on the empty area.
4. **A throw inside an EventSource/event listener is swallowed** — it doesn't reach agent-browser's
   `console` capture (which only catches `console.*`), and it silently aborts the handler. Symptom seen
   live: namespaces with resources but NO edges hung forever on "connecting…" because the server sent
   `"edges":null` (a nil Go slice) and the client's `fromSnapshot` did `[...g.edges]` → TypeError, thrown
   from the SSE `snapshot` listener BEFORE `setConnState('live')` ran. Larger namespaces hid it (they
   always have edges). **Debugging recipe** for "a feature silently doesn't update": (a) confirm the
   server sends the data — `fetch(streamURL)` and read the first chunk in-browser, or `curl` the
   non-stream `/graph`; (b) note `curl` CANNOT read the SSE stream here (the sandbox buffers streaming
   responses — even a working namespace returns 0 bytes), so use an in-browser `fetch`+ReadableStream or
   a real `new EventSource` in `eval`; (c) if the event fires but state doesn't change, the handler is
   throwing — temporarily wrap it in `try/catch`{`console.log(err.stack)`}, rebuild, and read the
   message. The fix: make the server honor its non-optional wire contract (`[]` not `null`) AND make the
   client reducer defensive (`?? []`). Always force empty slices to `[]` server-side — a nil Go slice
   marshals as `null` and the JS consumer rarely expects it.

5. **Auto-fit to a bounding box that can be ARBITRARILY LARGE → unreadable speck.** "Frame the
   matches" when a health/kind filter toggles is good UX *when matches cluster*, but matches can be
   sparse and SCATTERED across a tall layout (11 Degraded resources spread down a 142-Workflow
   namespace → bbox spans the whole canvas → fit zooms to ~0.04×, every match a tiny speck). Found
   live: the naive `fitNodeSet(lit)` made the view strictly *worse* than not moving. Lesson: an
   **automatic** viewport move must never degrade legibility — guard it with a readability floor
   (`if (target.scale < MIN_FIT_SCALE) return`, leave the pan/zoom). An **operator-initiated** move
   (the Fit button) may zoom to a speck; an automatic one may not. **Measure the post-fit `scale` AND
   count how many lit cards land inside the viewport rect — assert the scale stays legible.** General
   rule: any "fit to subset" needs to consider the worst-case spread of that subset, not just the
   happy clustered case.

6. **Malformed fetch URL from an empty path segment.** A drawer/detail fetch that interpolates a
   namespace/scope into the URL breaks when that value is empty — `.../namespaces//resources/...` (double
   slash) gets a 307→404 from Go's ServeMux, so the panel shows a generic "unavailable" / "couldn't
   load" with no hint of the real cause. Found live: every **cluster-scoped** resource (Node,
   PriorityClass, ClusterRole) has no namespace, so its drawer sent an empty `{ns}` and both manifest +
   events failed — invisible unless you dogfood in **cluster scope** (a plain namespace never selects a
   cluster-scoped resource). **Recipe:** `agent-browser network requests | grep resources` after
   selecting — a malformed URL (double slash, `undefined`, missing segment) is obvious there even though
   the rAF-frozen harness hides the *visual* failure. Compare the bad URL against a hand-`curl` of the
   path you *expect*; the diff is the bug. Fix at the single key/URL-builder, and substitute the scope
   sentinel (`CLUSTER_SCOPE`) the server already unmaps — don't special-case each fetch call site.

7. **A finished-but-empty result reads as "still loading" when the stream has no completion signal.**
   The `previous` (crashed-container) logs are a ONE-SHOT SSE dump: the server resolves pods, streams
   each, closes the line channel — then deliberately **holds the connection open idle** (heartbeating) so
   the browser's EventSource doesn't auto-reconnect and re-dump. Upshot: a crashed container that wrote
   nothing before exiting (OOM, `/bin/false`, instant panic — the exact CrashLoop triage path) yields a
   finished dump with zero lines, and the client, never told the dump finished, sat on
   "waiting for log output…" forever. **Tempting-but-wrong hypothesis** (cost a reasoning detour): "the
   server close → EventSource.onerror fires → it'll show the no-logs state." It does NOT — the server
   holds the socket open, so onerror never fires; only live driving revealed the perpetual spinner. The
   general rule: **any one-shot stream the server holds open after completing needs an explicit `done`
   event** so the client can tell "empty, finished" from "empty, still streaming" — don't infer
   completion from a close that never comes. Fix (commit): emit `event: done` on one-shot completion;
   client renders a terminal "no previous logs" state; the live follow stream never completes so its
   genuine "waiting…" is untouched. **Recipe to induce:** two disposable pods on docker-desktop —
   `command:["/bin/false"]` (crashes silent) vs `["sh","-c","echo BOOM; exit 1"]` (crashes loud) — wait
   for `restartCount ≥ 1`, then toggle `previous`: silent must show the terminal empty state, loud must
   show its line. They're standalone pods → **orphans**, so the namespace view hides them until you click
   "Show orphaned" (or pass `&orphans=1`).

## Measurement pitfalls (agent-browser `eval`) — false positives these caused

`getComputedStyle` in headless Chrome plus a naive colour parser each manufactured a convincing
"bug" that wasted most of a cycle. Check these BEFORE believing a measured-only finding:

1. **Transitioned properties read STALE right after a runtime state toggle.** Elements with
   `transition: background/color …` (the toolbar chips, legend pills) animate when you flip the theme
   at runtime (`.theme-btn.click()`), but the headless compositor doesn't advance the transition — so
   `getComputedStyle(el).backgroundColor` returns the PRE-toggle value indefinitely (e.g. a chip read
   `#171a21` dark in light theme, even though `--surface` resolved to `#fff` and inline
   `background:#ff0000 !important` *also* read as the old value — the tell that a transition, not the
   cascade, owns the value). It is NOT a theming bug. **To verify themed colours, load the page ALREADY
   in the target theme** (`eval "localStorage.setItem('kd:theme','light')"` then re-`open`) so the
   colour is settled with no transition — a fresh load read the chip correctly as `#fff`/`#6b7280`.
   A no-transition probe (a freshly-created `<div style="background:var(--surface)">` in the same
   container) is a quick cross-check: if it reads the right colour and the real element doesn't, it's
   the transition artifact.
2. **A naive rgb parser mis-reads `color(srgb r g b / a)` / `oklab(…)` backgrounds.** Modern
   translucent backgrounds (the toolbar's `color(srgb 1 1 1 / 0.92)`) serialise as `color(srgb …)`,
   not `rgb()`. A `match(/[\d.]+/g)` luminance helper then grabs `[1,1,1]` and treats it as
   `rgb(1,1,1)` ≈ black, fabricating a failing contrast ratio (a real `#6b7280`-on-near-white that
   passes AA reported ~4.3). When auditing contrast: only trust samples whose resolved bg is a plain
   `rgb()/rgba()`; for `color()/oklab()` backgrounds, composite the alpha over the parent yourself
   (`0.92·white + 0.08·canvas ≈ #fefefe`) or skip them. Both light and dark themes are AA-compliant —
   don't "fix" a contrast number that came from an `color(srgb …)` bg.
3. **The DOM lags a synchronous signal by one render tick — count nodes AFTER a tick, not in the same
   eval.** Solid commits a signal synchronously, but the `<For>`/`<Show>`-driven DOM (e.g. the
   `.node` count after toggling a collapse pill) re-renders a tick later. Clicking expand then collapse
   in ONE synchronous `eval` and reading `querySelectorAll('.node').length` measured the cluster as
   "not re-folding" (37, not back to 33) — a pure timing artifact; with a `sleep` between the second
   click and the read it correctly showed 33. So: to check a toggle's *effect*, either assert on the
   signal-driven attribute that commits synchronously (`aria-expanded`), or re-measure DOM counts after
   `sleep`/a rAF. Don't conclude "the re-fold is broken" from a same-eval count. (Same root cause in
   jsdom unit tests — assert `aria-expanded`, not the immediate child count.)
4. **A held element reference goes stale across a reactive toggle — re-query, don't reuse the ref.**
   Distinct from #3: this bites even when you assert on `aria-expanded` (which commits synchronously),
   because Solid's `<For>` reconciliation *replaces* the toggled SVG node with a new element. A `const
   pill = querySelector('.collapse-pill')` captured BEFORE dispatching Enter becomes detached after the
   toggle — its attributes never update, so `pill.getAttribute('aria-expanded')` reads the pre-toggle
   value forever (cost a false "keyboard toggle is broken" in cycle 45). Always re-`querySelector` the
   element AFTER the action and read attributes off the fresh node. Holding a ref across a toggle is
   only safe for elements Solid mutates in place, not ones it reconciles.
5. **`requestAnimationFrame` callbacks NEVER fire in the headless agent-browser session — so no
   pan/zoom/fit/animation can be verified by a viewport measurement.** Proven directly:
   `requestAnimationFrame(() => { window.__r = 1 })` leaves `__r` unset after 3s, while
   `document.visibilityState === 'visible'`, `document.hidden === false`, and `setTimeout` fires
   normally. kd routes EVERY non-initial viewport move through rAF — `animateTo`'s tick loop is rAF, and
   `fitCapRowExpanded` / `fitCapBox` / the selection-fit / filter-fit effects all do
   `selFitFrame = requestAnimationFrame(() => animateTo(...))`. So when you dispatch a click via `eval`
   and then read the canvas `<g transform>`, it will be **pixel-identical before and after** even when
   the fit logic is perfectly correct — the rAF that would apply it never runs. The ONE move you *can*
   observe is the very first fit after load, because `firstFit` (Topology.tsx) sets `scale/tx/ty`
   **directly**, not via `animateTo`. This manufactured a fully convincing "expanding a busy node
   doesn't bring its pods into view" bug in cycle 78 (`preClickTop == postExpandTop`, ~6/46 cards
   visible) that does NOT exist in a real browser; a rAF-deferral "fix" to `toggleCapRow` was equally
   invisible and was reverted. **How to actually verify viewport/animation behaviour:** (a) unit-test the
   *computed fit target* (the scale/tx/ty math) directly — that's pure and rAF-free; (b) drive the SIGNAL
   path, not the rendered transform, where possible; (c) for true end-to-end, use a HEADED browser. Never
   conclude a fit/zoom/pan is broken from an agent-browser transform diff. The tell: `ENTER`-level logs in
   a handler fire but anything inside its `requestAnimationFrame(...)` is silent.
6. **A just-mounted element with an entry `@keyframes` animation is FROZEN at its `from` frame — so its
   measured geometry/opacity/visibility is the STARTING offset, not the resting state.** Same frozen
   compositor as #1 and #5 (time-based animation never advances headless), but a distinct, high-damage
   symptom: it manufactures fake "off-screen / clipped / overflowing" bugs. The drawer animates in via
   `@keyframes drawer-in { from { transform: translateX(32px); opacity: 0 } to { translateX(0); opacity: 1 } }`
   over 0.28s with NO `animation-fill-mode`. Headless freezes it at `from`, so a freshly-opened drawer
   measures `transform: translateX(32px)` → its right edge sits 32px PAST the viewport and its close
   button reads as partially clipped (cost a convincing false "drawer overflows / × is unreachable at
   1280px" in cycle 81). In a real browser the animation completes in 0.28s and the element reverts to its
   base style (`transform: none`, flush, fully visible) — there is no overflow. **Mitigation: before
   measuring the geometry/opacity of any element that has an entry animation, force its resting state** —
   `el.style.animation = 'none'` then re-read `getBoundingClientRect()` (proven: drawer snapped to
   `right == innerWidth`, close button fully visible), OR load the page with reduced motion
   (`localStorage`/emulate) so entry animations are suppressed. NEVER conclude "this element overflows /
   is clipped / is off-screen / is invisible" from a measurement taken right after it mounted with an
   animation. The tell: a `matrix(1,0,0,1,N,0)` / non-`none` `transform` on a freshly-mounted element whose
   CSS has an `@keyframes … from { transform: … }`.
7. **A test that opts into a NON-DEFAULT config to make a feature work can be papering over a
   default-config bug.** The Events tab was empty for every resource in production for a week: `"events"`
   is in `store.DefaultSkipKinds`, so the informer snapshot never holds events, yet the handler read them
   from that snapshot → `{"events":null}` always. The handler test PASSED the whole time because it set
   `EagerKinds:["events"]` to force events into the cache — a config no real deploy uses. Found by
   dogfooding a reproducible failing pod (an ImagePullBackOff pod via a bogus image, or a crashloop via
   `command:["false"]`) on docker-desktop and seeing "No recent events." despite live kubelet events,
   then confirming `{"events":null}` straight from the API with `curl`. **Recipe:** to verify a feature
   that depends on backend data, reproduce the data condition for REAL (a probe pod with an impossible CPU
   request → Unschedulable; a bad image → ImagePullBackOff; `["sh","-c","exit 1"]` → CrashLoopBackOff;
   delete after), then `curl` the relevant `/api/...` endpoint directly — the JSON exposes an empty/null
   payload the rAF-frozen UI hides behind a generic empty state. When you spot a test using `EagerKinds` /
   a non-default flag / an injected fixture that the production path can't supply, suspect the default path
   is broken and test THAT.

8. **`navigator.clipboard.writeText` REJECTS in the headless session ("Document is not focused") — a
   copy affordance can never flash its success state there.** kd's copy paths confirm only on real
   success (the AGENTS.md clipboard rule), so the missing `.copied` flash after a dispatched
   Alt-click/copy-click is the DESIGNED failure no-op, not broken wiring. Verify instead: the handler
   fires (stub-free unit test asserts the payload + flash), the title/affordance is present, and a
   plain click does NOT copy. Don't chase the flash live, and don't weaken the success-only guard to
   make it appear.

9. **Troubled-first nav (`j`/`k`/Enter) keeps selecting VISIBLE nodes, masking a fold-related path you
   want to exercise.** Both the keyboard step (`orderedForNav`) and the search Enter-cycle order matches
   *most-troubled first*, and on a real cluster the troubled resources are often the head/tail cards a
   fold keeps visible — so pressing Enter dozens of times lands selection on visible cards and never on a
   folded one, even when folded matches plainly exist (the pill badges show them). Cost a stretch of
   inconclusive evals trying to catch auto-expand-on-select fire: pill count never dropped because no
   folded node was ever the selection. Also note search like "workflow" matches a Workflow's **Pods** too
   (via their argo labels), inflating the visible-match population. **To verify a fold-dependent behaviour
   live, drive it deterministically — don't rely on nav ordering to reach a folded node:** read a known
   hidden node's exact name (expand a pill, grab a middle card's `<title>`, re-collapse), then select THAT
   node by typing its exact name + Enter, and assert the folded→rendered transition (`.node.selected` for
   it appears) fires on the *selection* and NOT on the search alone (search must not unfold). Pill-count
   bookkeeping is unreliable as the signal on a busy cluster — SSE pod churn re-forms folds tick to tick,
   so a net-unchanged count doesn't mean no expand happened; assert the specific node's render instead.

## Accessibility patterns established (match these on any new control)

A11y is a live audit theme (cycles 17–18). The conventions now in the code:
- **Tabs** (drawer Logs/Events/Manifest): WAI-ARIA `role=tablist` › `role=tab` (`aria-selected`,
  `aria-controls`, roving `tabindex`) › `role=tabpanel` (`aria-labelledby`). NOT aria-pressed buttons.
- **Single-select segmented controls** (toolbar Group, Resource; drawer Manifest YAML/JSON):
  `role=radiogroup` › `role=radio` (`aria-checked`, roving `tabindex`). A pick-one control is a
  radiogroup, never aria-pressed toggles. (The single-select sweep is now complete — Group, Resource,
  and the Manifest format toggle all converted; no bare-`.active` pick-one controls remain.)
- **Multi-select chips** (Relationships, Kinds — compose, several on at once): `aria-pressed` toggle
  buttons in a `role=toolbar` is CORRECT — leave them.
- **Clearable single filter** (Health legend — one or none): `aria-pressed` is defensible (a radio
  can't deselect to none); leave it.
- **Roving keyboard model**: `web/src/rovingFocus.ts` `nextRovingIndex(key, cur, len)` is the ONE
  tested impl of the arrow/Home/End wrap math — reuse it for any new roving widget (tablist or
  radiogroup), don't re-derive. The handler sets the value AND `ref.focus()`s the new option (focus
  follows selection / APG automatic activation). **Verify live:** focus the active option, dispatch
  `ArrowRight`, assert `aria-checked`/`aria-selected` moved, `document.activeElement` is the new
  option, and (Group) the URL/layout actually changed.
- **Focus restoration on close** (WCAG 2.4.3): the drawer's exit effect (`on(() => props.node)`) is
  the ONE choke point for "closing" across every trigger (close button, Escape, canvas deselect) — do
  focus work there, not in each handler. When focus is inside the drawer as it closes it would fall to
  `<body>` (strands keyboard users); restore it to `.topology-search input` (the keyboard home base),
  **gated on `asideEl.contains(document.activeElement)`** so a mouse deselect doesn't yank focus.
  **Verify live both ways:** focus a drawer button → close → assert `activeElement` is the search; and
  focus OUTSIDE → close → assert focus stayed put. NOTE: focus does NOT auto-move INTO the drawer on
  open — that is intentional (it would break the search Enter-cycle flow), not a bug.
- **Worded names over glyphs** (avoid icon-only): a button whose visible content is a glyph (the log
  filter's "Aa" case toggle) has that glyph as its ONLY accessible name unless you add `aria-label` —
  `title` is a hover tooltip, NOT a reliable name source. Spell it out (`aria-label="Match case"`)
  while keeping the compact visual. Worded-text buttons (previous/timestamps/wrap) already have a real
  name and need none.
- **Interactive SVG elements need explicit button semantics** — the "show N more" collapse pill was a
  bare `<g onClick>` + `<title>` (mouse-only, unnamed: `<title>` on a `<g>` isn't a reliable accessible
  name). It's the ONLY way to reveal a folded cluster (pills are excluded from search-nav, so unlike a
  graph node there's no alternative keyboard path), so it needed `role="button"` + `tabindex="0"` +
  worded `aria-label` + `aria-expanded` + Enter/Space `onKeyDown` + a `:focus-visible` ring (SVG has no
  default focus outline — style the bg rect's stroke). **Lesson:** "I swept the HTML controls" ≠ a11y
  complete — SVG-rendered interactive elements (pills, and anything else with an onClick in the canvas)
  are a SEPARATE class to audit. Graph *nodes* are the deliberate exception (search-cycling is their
  keyboard path); a discrete *action* with no search equivalent is not.
- **A11y sweep status** (as of 2026-06-05): HTML controls — tabs (tablist/tab/tabpanel + roving),
  single-selects (radiogroups: Group, Resource, Manifest format), multi-select chips (aria-pressed),
  clearable Health filter, sidebar (nav + aria-current), copy live-region, drawer focus-restore +
  action buttons, log controls — all done + verified live. SVG **discrete-action** elements — the
  collapse pill AND the Nodes-view node row (`cap-row`) are now keyboard buttons
  (role/tabindex/aria-label/aria-expanded/Enter+Space + `:focus-visible` frame stroke). The remaining
  onClick-bearing SVG (cap-view pod segments/cards, edge hit targets) are *selection/hover* affordances
  whose data is reachable via the drawer/search — deliberately NOT focusable (same rationale as graph
  nodes: avoid canvas tab-order noise). **Rule for new canvas elements:** a discrete ACTION (expand,
  toggle, dismiss) with no search/drawer equivalent → button semantics; a SELECTION/hover affordance →
  leave non-focusable, ensure search reaches its data. Both the HTML and SVG-action audits now yield ≈0.

## What NOT to "fix" (verified risky/deferred — re-deriving wastes a cycle)

- The Nodes view's pod **Req bar fills with USAGE** (tick at request), while the node Req bar fills
  with REQUEST magnitude — an apparent Repetition-principle inconsistency. It's **recent, user-approved
  design** (the "feel how big each pod is" + overshoot-past-tick request). Node vs pod serve different
  zoom levels and the value labels disambiguate. Don't reinterpret it without the user.
- No click-affordance selects the **Node resource** in the capacity view (header click = expand). Real
  gap but conflicts with the approved expand-on-whole-row; needs a dedicated small target + the user's call.
- CPU↔Memory toggle doesn't re-fit a selected pod (bars readable in one unit get tiny in the other).
  Minor; re-clicking re-zooms; auto-jumping on every toggle would annoy. Low value.
- The drawer's **inactive tabpanels lack the `hidden` attribute** — they hide via CSS `display:none`
  (verified cycle 48: inactive panels have `offsetHeight 0`, computed `display:none`, so they're
  correctly OUT of the a11y tree; only `aria-selected` flips on the tabs). All three panels stay
  *mounted* on purpose — the Logs panel keeps its SSE log stream subscribed and the Manifest panel
  keeps its find-state across tab switches, so switching away and back doesn't re-fetch/re-scroll.
  Adding the `hidden` attribute (the WAI-ARIA "preferred" form) is redundant with `display:none` for
  AT and risks the classic `hidden` + `display:block`-override footgun. Don't "fix" the missing
  attribute — `display:none` already satisfies the contract and the persistence is deliberate.
