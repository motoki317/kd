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

## Dogfood against real scale

`docker-desktop` (1 node, ~58 pods) exercises the many-pods-on-one-node path; a real EKS context
(`?ctx=<arn>`) gives production shapes (varied node sizes, near-zero usages, 9 nodes). **Never let a
real ctx/cluster/namespace/ARN name reach a tracked file** — keep it in the browser session only
(see AGENTS.md leakage rule). URL-encode an ARN ctx before putting it in the open URL.

**Last verified clean at production scale (2026-06-05):** a real EKS staging cluster (72 nodes / 39
namespaces) — cluster-scope relationship layout had **0 overlapping node cards** (the `placeColumns`
depth-column layout holds), cluster- and namespace-scope capacity bars had **0 overshoot rows**
(Σuse-segments ≤ track width on every row; the namespace fold drew own/`other`/`small` aggregates
correctly), and a real multi-container pod's drawer rendered init-before-main container cards with no
width overflow. So these surfaces are mature — the bar to re-dogfood them is "did the layout /
capacity geometry / drawer-card code change", not "every cycle". Reusable overshoot check:
`for each .cap-track.use, assert max(.cap-seg.use at same y).right ≤ track.right`. Overlap check:
pairwise screen-rect intersection of `.node .node-bg` (>4px on both axes = a real overlap).

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
- Still TODO (future cycles): sweep the drawer back/expand/share buttons and the log-level controls for
  role/state correctness. (Sidebar list, tabs, segmented controls, copy live-region, and drawer
  close-focus-restore are done.)

## What NOT to "fix" (verified risky/deferred — re-deriving wastes a cycle)

- The Nodes view's pod **Req bar fills with USAGE** (tick at request), while the node Req bar fills
  with REQUEST magnitude — an apparent Repetition-principle inconsistency. It's **recent, user-approved
  design** (the "feel how big each pod is" + overshoot-past-tick request). Node vs pod serve different
  zoom levels and the value labels disambiguate. Don't reinterpret it without the user.
- No click-affordance selects the **Node resource** in the capacity view (header click = expand). Real
  gap but conflicts with the approved expand-on-whole-row; needs a dedicated small target + the user's call.
- CPU↔Memory toggle doesn't re-fit a selected pod (bars readable in one unit get tiny in the other).
  Minor; re-clicking re-zooms; auto-jumping on every toggle would annoy. Low value.
