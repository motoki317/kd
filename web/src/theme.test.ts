import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, loadThemePref, nextThemePref, resolveTheme, saveThemePref, type ThemePref } from './theme'

afterEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('resolveTheme', () => {
  it('pins ignore the OS scheme', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('system follows the OS scheme', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('nextThemePref', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextThemePref('system')).toBe('light')
    expect(nextThemePref('light')).toBe('dark')
    expect(nextThemePref('dark')).toBe('system')
  })
})

describe('load/save', () => {
  it('defaults to system when unset or garbage', () => {
    expect(loadThemePref()).toBe('system')
    localStorage.setItem('kd:theme', 'neon')
    expect(loadThemePref()).toBe('system')
  })

  it('round-trips a saved pin', () => {
    const prefs: ThemePref[] = ['light', 'dark', 'system']
    for (const p of prefs) {
      saveThemePref(p)
      expect(loadThemePref()).toBe(p)
    }
  })
})

describe('applyTheme', () => {
  it('stamps the resolved scheme onto <html data-theme>', () => {
    // jsdom's matchMedia is undefined, so prefersDark() reports false → system resolves to light.
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    applyTheme('system')
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
