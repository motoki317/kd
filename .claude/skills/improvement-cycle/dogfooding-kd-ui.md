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

## What NOT to "fix" (verified risky/deferred — re-deriving wastes a cycle)

- The Nodes view's pod **Req bar fills with USAGE** (tick at request), while the node Req bar fills
  with REQUEST magnitude — an apparent Repetition-principle inconsistency. It's **recent, user-approved
  design** (the "feel how big each pod is" + overshoot-past-tick request). Node vs pod serve different
  zoom levels and the value labels disambiguate. Don't reinterpret it without the user.
- No click-affordance selects the **Node resource** in the capacity view (header click = expand). Real
  gap but conflicts with the approved expand-on-whole-row; needs a dedicated small target + the user's call.
- CPU↔Memory toggle doesn't re-fit a selected pod (bars readable in one unit get tiny in the other).
  Minor; re-clicking re-zooms; auto-jumping on every toggle would annoy. Low value.
