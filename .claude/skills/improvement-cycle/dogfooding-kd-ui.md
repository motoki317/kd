# Dogfooding kd's UI — discovery playbook

Discovery-oriented recipes + recurring bug classes for the improvement cycle. Setup, the demo/k3d
cluster, broken-shape fixtures, and the **headless measurement pitfalls** live in
**`docs/live-debug.md`** — read that first; this file is what to *look for* once you're driving the
real UI. The rule that makes dogfooding pay off: **measure the thing you changed with `eval`, don't
just eyeball a screenshot.**

## Inducing states to verify a render

- **Broken shapes:** apply `docs/demo/diagnostics/<shape>.yaml` on the demo cluster (see
  live-debug.md for the full list + the interaction-only shapes: finalizer-stuck, saturated HPA,
  status-subresource injection for node conditions).
- **A CR spec-chip without the operator installed:** apply a minimal open-schema CRD + one
  real-shaped instance — the chip reads the informer's unstructured object, no controller needed:
  ```yaml
  apiVersion: apiextensions.k8s.io/v1
  kind: CustomResourceDefinition
  metadata: { name: clusterissuers.cert-manager.io }
  spec:
    group: cert-manager.io
    scope: Cluster
    names: { plural: clusterissuers, singular: clusterissuer, kind: ClusterIssuer }
    versions: [{ name: v1, served: true, storage: true,
                 schema: { openAPIV3Schema: { type: object, x-kubernetes-preserve-unknown-fields: true } } }]
  ```
  Restart kd after the CRD lands (GVRs are discovered at startup). Clean up after.
- **After a feature passes tests, dogfood it against the REAL resource shape that motivated it** —
  the actual shape (empty selector, never-run cron, unset field) routinely differs from the tidy
  fixture, and only live data exercises the default you guessed. (The PDB-guards edge skipped empty
  selectors as "too noisy"; the real degraded PDB had exactly an empty selector.)

## Theme audits (light mode)

Mostly static, not visual — kd's CSS is token-driven, so token-only styling verifies by
construction:

1. `grep` `web/src/styles/` for hardcoded colors outside the `:root`/`[data-theme]` token blocks
   (skip `var(--…)`/`color-mix`; alpha-neutral `#000` shadows/masks are fine).
2. Check each hit is scoped under the right `[data-theme=…]` or deliberately theme-invariant (the
   dark log pane).
3. ONE live pass per theme, loaded FRESH in that theme (pitfall: stale transitions): measure
   contrast with computed styles — segments need ≥3:1 vs the panel; a 1px `--border` hairline is
   the theme's standard edge, not a bug.
4. Reset `kd:theme` after.

## Capacity (Nodes) view — interaction recipes

The hardest view to unit-test (geometry + viewport fit + SVG):

```js
// Expand/collapse a node row: click the frame at an empty spot (NOT a segment — those select a pod)
(() => { const f=document.querySelector('.cap-node-frame.clickable'); const r=f.getBoundingClientRect();
  const x=r.right-60,y=r.top+6; document.elementFromPoint(x,y).dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:x,clientY:y})); })()
// Expanded pod-card readability (the metric that matters): count + cardH/cardW of '.cap-bullet-frame'
// Click a pod card ('.cap-bullet') → selects + zooms; measure it GREW, didn't shrink
// Hover-spotlight: pointermove a '.cap-seg.use' center → others get .faded + a .cap-tooltip appears
```

Key classes: `.cap-node-frame[.clickable][.expanded]`, `.cap-seg.use|.req[.other|.small][.faded]`,
`.cap-bullet(-frame)`, `.cap-bar-value`, `.cap-tooltip`. Resource toggle persists to `kd:capRes`.

Reusable geometry checks: **overshoot** — for each `.cap-track.use`, max same-y `.cap-seg.use`
right ≤ track right; **overlap** — pairwise `.node .node-bg` screen-rect intersection (>4px both
axes = real); **name fit** — each `.cap-row text` `getBBox().right` ≤ its frame's right edge.

## UX-gap patterns (the operator lens — run real flows, notice where they stop)

Real gaps a human feels by USING the app that a source survey misses because the code "looks
complete". Shapes to check on any view:

- **A scrolling row with no overflow cue** — `scrollWidth > clientWidth` with no edge fade reads as
  "that's all there is". Fix = scroll-position edge fade.
- **Drilling in shows LESS than the card** — for each fact a card shows (status, restarts, age),
  does the drawer still show it? Carry the same status language through card → drawer → manifest.
- **A count over a foldable canvas mixing "rendered" with "true match"** — decide per-counter
  (rendered-cards vs true-matches) and keep sibling indicators on the same basis; compare counts on
  a namespace where matches FOLD.
- **A built-in kind landing in the CR catch-all → bogus "Unknown" health** — in cluster scope, a
  built-in showing Unknown is a smell; add a *typed* rule (health.go + status.go + typedFactories).
- **A drill-in path that dead-ends at the resource that explains nothing** — run the whole triage
  flow (most-troubled ns → Degraded filter → drill in → "why?") and notice where it stops; the fix
  is usually a missing edge.
- **A derived/auto-injected object kd never reads, shown as a node, is orphan/duplicate noise**
  (kube-root-ca.crt, core/v1 Endpoints). Tell: an existing `DefaultSkipKinds` entry whose rationale
  a sibling kind matches verbatim. Fix ladder: kd reads it nowhere + no spec render → drop at
  `DefaultSkipKinds`; real drawer content but pathological edges → drop the node at the build
  filter. Owned children with a real parent are NOT this.

## Recurring bug classes (check on any UI change)

1. **Fit-zoom DIRECTION** — a "zoom to X" must enlarge X. A length-encoded view's meaningful axis
   is its WIDTH: fit to the bar/content region, not the tall stack; top-anchor an over-tall stack.
   Measure cardH before vs after — assert it grew.
2. **Viewport-edge clipping** of fixed/absolute/cursor-following elements — cap to
   `calc(100vh - …)` + `overflow:auto`, or flip to the cursor's other side near an edge. Hover the
   far right/bottom and assert `rect ≤ innerWidth/Height`. (Native `<select>` and SVG `<title>`
   are OS-positioned — exempt.)
3. **SVG hit-targets** — `pointer-events:none` isn't clickable; a card's empty fill must carry
   pointer events for the whole card to be a target. Verify with `elementFromPoint`.
4. **A throw inside an EventSource listener is swallowed** — see live-debug.md pitfall list for the
   debugging recipe; the fix is always both sides: server honors the wire contract (`[]` not
   `null`), client reducer defensive (`?? []`).
5. **Auto-fit to an arbitrarily-large bbox → unreadable speck** — an *automatic* viewport move must
   never degrade legibility: guard with a readability floor (`if (target.scale < MIN_FIT_SCALE)
   return`). An operator-initiated Fit may zoom to a speck; an automatic one may not. Consider the
   worst-case *spread* of the subset, not the happy clustered case.
6. **Malformed fetch URL from an empty path segment** — a cluster-scoped resource has no namespace,
   so `.../namespaces//...` 307→404s behind a generic "unavailable". `agent-browser network
   requests | grep resources` makes the bad URL obvious. Fix at the single URL-builder with the
   `CLUSTER_SCOPE` sentinel — don't special-case call sites. Dogfood in cluster scope; a plain
   namespace never selects a cluster-scoped resource.
7. **A finished-but-empty one-shot stream reads as "still loading"** — any one-shot stream the
   server holds open after completing (the `previous` logs dump) needs an explicit `done` event so
   the client can tell "empty, finished" from "empty, still streaming"; onerror never fires because
   the socket stays open. Induce with two disposable pods: `/bin/false` (crashes silent) vs
   `sh -c "echo BOOM; exit 1"` (crashes loud) — silent must show the terminal empty state.
   Standalone pods are orphans: reveal via "Show orphaned" / `&orphans=1`.

## Accessibility conventions (match these on any new control)

- **Tabs** (drawer): `role=tablist › tab › tabpanel`, `aria-selected`, roving `tabindex` — not
  aria-pressed buttons.
- **Single-select segmented controls** (Group, Resource, Manifest format): `role=radiogroup › radio`
  (`aria-checked`, roving tabindex). A pick-one control is a radiogroup, never aria-pressed toggles.
- **Multi-select chips** (Relationships, Kinds): `aria-pressed` toggles in `role=toolbar` — correct,
  leave them. **Clearable single filter** (Health): `aria-pressed` is defensible (a radio can't
  deselect to none).
- **Roving keyboard math**: `web/src/rovingFocus.ts` `nextRovingIndex` is the ONE tested impl —
  reuse it; the handler sets the value AND focuses the new option. Verify live: dispatch ArrowRight,
  assert `aria-checked` moved + `document.activeElement` is the new option.
- **Focus restoration on close** (WCAG 2.4.3): do focus work in the drawer's exit effect (the one
  choke point), restore to the search input, **gated on `asideEl.contains(document.activeElement)`**
  so a mouse deselect doesn't yank focus. Focus does NOT auto-move INTO the drawer on open —
  intentional.
- **Worded names over glyphs**: a glyph-only button needs `aria-label` (`title` is not a reliable
  name source).
- **Interactive SVG needs explicit button semantics** — a discrete ACTION with no search/drawer
  equivalent (the collapse pill, the cap-view node row) gets `role="button"` + `tabindex` + worded
  `aria-label` + `aria-expanded` + Enter/Space + a `:focus-visible` ring (style the bg rect's
  stroke — SVG has no default outline). A SELECTION/hover affordance stays non-focusable (canvas
  tab-order noise); search reaches its data. "I swept the HTML controls" ≠ a11y complete — SVG
  onClick elements are a separate class to audit.

## What NOT to "fix" (verified risky/deferred — re-deriving wastes a cycle)

- The Nodes view's pod **Req bar fills with USAGE** (tick at request) while the node Req bar fills
  with request magnitude — user-approved design ("feel how big each pod is"); the value labels
  disambiguate. Don't reinterpret without the user.
- No click-affordance selects the **Node resource** in the capacity view (header click = expand) —
  real gap, conflicts with the approved expand-on-whole-row; needs the user's call.
- CPU↔Memory toggle doesn't re-fit a selected pod — minor; re-clicking re-zooms; auto-jumping would
  annoy.
- The drawer's **inactive tabpanels lack the `hidden` attribute** — they hide via CSS
  `display:none` (correctly out of the a11y tree) and stay *mounted* on purpose (the Logs panel
  keeps its SSE stream, Manifest keeps find-state). Adding `hidden` is redundant and risks the
  `hidden`+`display:block` footgun.
