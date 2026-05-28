import { describe, expect, it } from 'vitest'
import { ansiStyleToCss, hasAnsi, parseAnsi } from './ansi'

describe('parseAnsi', () => {
  it('returns the whole input as a single plain segment when there are no escapes', () => {
    const segs = parseAnsi('hello world')
    expect(segs).toEqual([{ text: 'hello world', style: {} }])
  })

  it('hasAnsi flags lines containing CSI sequences and skips the plain ones', () => {
    expect(hasAnsi('plain log line')).toBe(false)
    expect(hasAnsi('\x1b[31mred\x1b[0m')).toBe(true)
  })

  it('applies 16-color foreground codes and resets back to no style', () => {
    const segs = parseAnsi('\x1b[31mred\x1b[0m after')
    expect(segs.length).toBe(2)
    expect(segs[0].text).toBe('red')
    expect(segs[0].style.fg).toBeDefined()
    expect(segs[1].text).toBe(' after')
    expect(segs[1].style.fg).toBeUndefined()
  })

  it('supports bright (90–97) foreground codes', () => {
    const segs = parseAnsi('\x1b[91mbright red\x1b[39m')
    expect(segs[0].style.fg).toBe('#fc8181') // bright-red entry of the palette
  })

  it('toggles bold, dim, italic, and underline, then turns them off', () => {
    const segs = parseAnsi('\x1b[1;4mbold-ul\x1b[24m bold\x1b[22m plain')
    expect(segs[0].style).toMatchObject({ bold: true, underline: true })
    expect(segs[1].style).toMatchObject({ bold: true, underline: false })
    expect(segs[2].style.bold).toBe(false)
  })

  it('handles 256-color extended foreground (38;5;N)', () => {
    const segs = parseAnsi('\x1b[38;5;196mhot\x1b[0m cool')
    expect(segs[0].style.fg).toBe('rgb(255,0,0)') // palette index 196 = (5,0,0) in the cube
    expect(segs[1].style.fg).toBeUndefined()
  })

  it('handles truecolor (38;2;R;G;B)', () => {
    const segs = parseAnsi('\x1b[38;2;12;34;56mhello\x1b[0m')
    expect(segs[0].style.fg).toBe('rgb(12,34,56)')
  })

  it('handles background colors (40–47, 48;5;N)', () => {
    const a = parseAnsi('\x1b[41mhi\x1b[49m')
    expect(a[0].style.bg).toBeDefined()
    expect(a.length).toBe(1)
    const b = parseAnsi('\x1b[48;5;21mhi\x1b[49m')
    expect(b[0].style.bg).toBe('rgb(0,0,255)') // index 21 = (0,0,5)
  })

  it('drops unknown CSI sequences (cursor moves) without emitting them as text', () => {
    const segs = parseAnsi('before\x1b[2Kafter')
    expect(segs.length).toBe(2)
    expect(segs[0].text).toBe('before')
    expect(segs[1].text).toBe('after')
  })

  it('treats an empty SGR ("\\x1b[m") as a reset', () => {
    const segs = parseAnsi('\x1b[31mred\x1b[m plain')
    expect(segs[0].style.fg).toBeDefined()
    expect(segs[1].style.fg).toBeUndefined()
  })

  it('survives a runaway escape at end of input without throwing', () => {
    const segs = parseAnsi('hello\x1b[31')
    expect(segs).toEqual([{ text: 'hello', style: {} }])
  })
})

describe('ansiStyleToCss', () => {
  it('emits only the keys that the style sets', () => {
    expect(ansiStyleToCss({})).toEqual({})
    expect(ansiStyleToCss({ fg: '#fff', bold: true })).toEqual({ color: '#fff', 'font-weight': '700' })
    expect(ansiStyleToCss({ dim: true, italic: true })).toEqual({ opacity: '0.65', 'font-style': 'italic' })
  })
})
