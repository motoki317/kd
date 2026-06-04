// Theme preference (cycle 301): the dashboard used to follow the OS color scheme with no override.
// Operators on a light-defaulted OS who want a dark canvas (or vice versa) had no recourse. A
// three-way preference — light / dark / system — is stored in localStorage and resolved to the
// concrete scheme that paints the page. 'system' still tracks the OS live so the original
// auto-behavior is the default and remains a first-class choice rather than a fallback.
import { readPref, writePref } from './prefs'

export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'kd:theme'
// Cycle order for the topbar toggle: the default (system) leads, then the two explicit pins.
const ORDER: ThemePref[] = ['system', 'light', 'dark']

export function loadThemePref(): ThemePref {
  // Via the private-mode-safe pref helper: reading localStorage throws in some browsers, and this
  // runs at first paint (initTheme) where an exception would blank the page before render.
  return readPref(STORAGE_KEY, 'system', ORDER)
}

export function saveThemePref(pref: ThemePref): void {
  writePref(STORAGE_KEY, pref)
}

export function nextThemePref(pref: ThemePref): ThemePref {
  return ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]
}

// Pure resolution so it's unit-testable without a real matchMedia: 'system' defers to the OS bit,
// the explicit pins ignore it.
export function resolveTheme(pref: ThemePref, prefersDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

// Stamp the resolved scheme onto <html data-theme>. CSS keys every dark rule off this attribute
// (never prefers-color-scheme directly) so the explicit pins and the OS-tracking 'system' mode
// share one code path — the JS is always the source of truth for what's painted.
export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = resolveTheme(pref, prefersDark())
}

// Called once from the entry point before render so the first paint already carries the right
// scheme (no light→dark flash). Returns nothing; App owns the reactive re-apply on user change.
export function initTheme(): void {
  applyTheme(loadThemePref())
}
