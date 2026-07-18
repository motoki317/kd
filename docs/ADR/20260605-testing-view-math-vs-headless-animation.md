---
date: "2026-06-05"
author: "motoki317"
status: "accepted"
---

# Context

kd's canvas is heavily interactive: pan/zoom, fit-to-selection, fit-on-expand, the drawer slide-in,
and the Grafana-style hover spotlight. The project verifies UI changes live by driving the real app
with the **agent-browser** CLI (see `AGENTS.md` → "Verifying UI changes live"). During a dogfooding
campaign we discovered that this harness's **headless Chrome compositor is frozen**: a
`requestAnimationFrame` callback never fires (proven — a bare rAF stays unrun after 3s while
`document.visibilityState === 'visible'` and `setTimeout` works), and CSS animations/transitions never
advance.

This matters because **every non-initial viewport move in kd is rAF-driven** — `animateTo` runs a
`requestAnimationFrame` tick loop, and `fitCapRowExpanded` / `fitCapBox` / the selection- and
filter-fit effects all schedule `requestAnimationFrame(() => animateTo(...))`. So when a fit is driven
by an `eval`-dispatched interaction, the canvas transform is **pixel-identical before and after even
when the fit logic is perfectly correct** — the rAF that would apply it never runs. The only viewport
move the harness can observe is the very first fit after load, because `firstFit` sets `scale/tx/ty`
directly rather than through `animateTo`. The same freeze leaves a just-mounted element with an entry
`@keyframes` (e.g. the drawer's `translateX(32px) → 0` slide-in) **stuck at its `from` frame**, so its
measured geometry/opacity is its starting offset, not its resting state.

This manufactured two fully-convincing — but entirely false — "bugs" (a busy node's expand not
bringing pods into view; the drawer overflowing / its close button clipped at 1280px). Both were
retracted, not fixed; "fixing" either would have broken real behaviour.

# Decision

1. **Do not verify any fit/zoom/pan/animation by measuring the canvas transform (or an animated
   element's geometry) in agent-browser.** It cannot move, by construction.
2. **Make the view geometry pure and unit-test the computed target.** Extract the framing math out of
   the reactive component into `web/src/viewport.ts` (`boundingBox`, `selectionMaxScale`, `fitBox`,
   `clampPan`). The component keeps only the DOM reads (live SVG rect + toolbar height) and the
   rAF-driven animation around the pure result. The math is pinned by `viewport.test.ts`.
3. **To measure an animated element's resting geometry, force the resting state first** —
   `el.style.animation = 'none'` (or load with reduced motion) — then read `getBoundingClientRect()`.
4. **What agent-browser still verifies reliably**: anything that commits synchronously off a Solid
   signal — the `.faded`/`.selected` spotlight classes, `aria-*` attributes, computed colours of a
   settled (non-transitioning) element, element counts, DOM structure, and tooltip text. The initial
   load fit is also observable (it is a direct set).

# Consequences

- Fit/clamp/spotlight logic is now regression-protected by fast, deterministic unit tests instead of
  unverifiable live checks.
- Topology.tsx shrinks; the pure geometry is reusable and readable in isolation.
- Future agents stop losing cycles to phantom overflow/clip/off-screen "bugs" — the failure mode is
  documented with its tell (a handler's top-level log fires but everything inside its
  `requestAnimationFrame(...)` is silent; a freshly-mounted element shows a non-`none` `transform`).

# Impact

- Scope: the topology canvas (`web/src/components/Topology.tsx`, `web/src/viewport.ts`) and the
  dogfooding methodology. No runtime behaviour change — the extractions are byte-identical and the
  initial fit was verified live.
- Constraint: truly end-to-end animation verification (does the fit actually glide to the right place?)
  requires a **headed** browser; it is out of scope for the standard headless flow and left to manual
  spot-checks.

# Alternatives

- **Run agent-browser headed (`--headed`)** so rAF/animations actually advance. Rejected as the default:
  it needs a display server and is heavier/flakier than the headless flow; reserved for occasional
  manual checks.
- **Stub `requestAnimationFrame` to run synchronously via injected JS before driving.** Rejected: it
  changes the very timing under test and animateTo's loop would complete in one tick, masking real
  ordering issues; the unit test of the computed target is a cleaner, truer assertion.
- **Leave the math inline and accept it as untested.** Rejected: it is exactly the logic most prone to
  silent regression (centring, padding, the toolbar top-inset, divide-by-zero guards) and the one the
  live harness cannot cover.

# Notes

The recurring measurement pitfalls (rAF frozen; entry `@keyframes` frozen at `from`; transitioned
properties reading stale after a runtime toggle; DOM lagging a synchronous signal by a tick; a held
element ref going stale across a Solid `<For>` reconcile) are catalogued in the `improvement-cycle`
skill's `dogfooding-kd-ui.md` "Measurement pitfalls" section.
