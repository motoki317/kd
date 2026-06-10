// The phone-width breakpoint, below which the sidebar/drawer become full-width overlays and the
// topbar compacts. CSS media queries can't read a JS constant, so the SAME query is repeated in
// index.css `@media` blocks tagged "NARROW_SCREEN_QUERY" — change it here, grep for that tag there.
// Lives in its own module (not App.tsx) so leaf components can read it without an import cycle.
export const NARROW_SCREEN_QUERY = '(max-width: 640px)'

// One-shot read; matchMedia is guarded for jsdom, which doesn't implement it. For REACTIVE use
// (overlay gating that must follow a rotation/resize), attach a change listener to
// matchMedia(NARROW_SCREEN_QUERY) instead of polling this.
export const isNarrowScreen = (): boolean =>
  typeof matchMedia === 'function' && matchMedia(NARROW_SCREEN_QUERY).matches
