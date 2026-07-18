# Client gotchas

## Solid

- `createMemo` runs when created. A memo that reads a later `const` hits the temporal dead zone; read
  the prop directly or declare dependencies first.
- Signal setters commit synchronously. Repeated discrete keyboard actions must apply immediately;
  easing from a lagging signal coalesces rapid presses.
- `on(dep, fn, { defer: true })` skips its initial run. Use `queueMicrotask` before reading a DOM class
  set by the same reactive update. `ref={varName}` assigns the element.

## SVG and CSS

- SVG `<text>` ignores CSS `text-overflow`; truncate in TypeScript. Markers default to
  `markerUnits="strokeWidth"`, so arrowheads scale with zoomed strokes. A wide transparent stroke still
  receives pointer events and can serve as a hit target over a thin line.
- A two-class selector beats a one-class selector; do not use `!important` to compensate. Gate motion
  behind `prefers-reduced-motion`. Store display preferences under `kd:*` in `localStorage`.
- Setting `display` on a direct child of `<details>` overrides the browser rule that hides closed
  content. Re-hide it with an explicit `:not([open])` selector; this reproduces only in a browser.
- In a wrapping flex row, a zero-basis item can "fit" beside a 100%-wide sibling at 0px instead of
  wrapping. Put the banner outside the row or give the item a real basis; jsdom cannot measure it.

## Browser-only behavior

- jsdom reports `offsetParent` as null and zero rectangles. It lacks `scrollIntoView` and
  `Element.animate` unless stubbed, and never fires `animationend`. Assert the DOM contract, including
  that an animation class was added, then verify behavior in a browser.
- On plain `http://<lan-ip>`, `navigator.clipboard` is undefined. Optional-chaining only
  `navigator.clipboard?.writeText(x)` still lets a following `.then(...)` throw synchronously.
  Optional-chain the whole chain or use `await` in `try/catch`, as `CopyButton` and the drawer do.
  Confirm only after success; otherwise no-op silently.
