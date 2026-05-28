// parseAnsi splits a log line into styled segments, interpreting the common subset of ANSI SGR
// escape codes (\x1b[…m). It handles standard 16-color foreground/background (30–37, 90–97, 40–47,
// 100–107), the 256-color palette (38;5;N / 48;5;N), truecolor (38;2;R;G;B / 48;2;R;G;B), plus
// reset (0), bold (1), dim (2), italic (3), underline (4), and the corresponding "off" codes
// (22/23/24/39/49). Unknown CSI sequences (e.g. cursor moves) are dropped silently so a log line
// with stray non-SGR escapes still renders cleanly.

export type AnsiStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export type AnsiSegment = { text: string; style: AnsiStyle }

// 16-color palette tuned for the dark log pane (#0e131b bg). Bright variants are the 8–15 indices.
const ANSI16 = [
  '#3b3b3b', // black
  '#f56565', // red
  '#48bb78', // green
  '#ecc94b', // yellow
  '#4299e1', // blue
  '#b794f4', // magenta
  '#0bc5ea', // cyan
  '#d6deea', // white
  '#6b7280', // bright black (gray)
  '#fc8181', // bright red
  '#9ae6b4', // bright green
  '#f6e05e', // bright yellow
  '#63b3ed', // bright blue
  '#d6bcfa', // bright magenta
  '#76e4f7', // bright cyan
  '#ffffff', // bright white
]

const CUBE_STEPS = [0, 95, 135, 175, 215, 255]

function palette256(idx: number): string {
  if (idx < 0 || idx > 255) return '#d6deea'
  if (idx < 16) return ANSI16[idx]
  if (idx < 232) {
    const n = idx - 16
    const r = CUBE_STEPS[Math.floor(n / 36)]
    const g = CUBE_STEPS[Math.floor(n / 6) % 6]
    const b = CUBE_STEPS[n % 6]
    return `rgb(${r},${g},${b})`
  }
  const v = 8 + (idx - 232) * 10
  return `rgb(${v},${v},${v})`
}

function applyParams(prev: AnsiStyle, body: string): AnsiStyle {
  // An empty SGR ("\x1b[m") is the canonical reset. So is "0".
  if (body === '' || body === '0') return {}
  const params = body.split(';').map((p) => (p === '' ? 0 : Number(p)))
  let s: AnsiStyle = { ...prev }
  let i = 0
  while (i < params.length) {
    const p = params[i]
    if (isNaN(p) || p === 0) s = {}
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 22) {
      s.bold = false
      s.dim = false
    } else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 39) s.fg = undefined
    else if (p === 49) s.bg = undefined
    else if (p >= 30 && p <= 37) s.fg = ANSI16[p - 30]
    else if (p >= 40 && p <= 47) s.bg = ANSI16[p - 40]
    else if (p >= 90 && p <= 97) s.fg = ANSI16[p - 90 + 8]
    else if (p >= 100 && p <= 107) s.bg = ANSI16[p - 100 + 8]
    else if (p === 38 || p === 48) {
      const sub = params[i + 1]
      if (sub === 5) {
        const c = palette256(params[i + 2] ?? 0)
        if (p === 38) s.fg = c
        else s.bg = c
        i += 2
      } else if (sub === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        const c = `rgb(${r},${g},${b})`
        if (p === 38) s.fg = c
        else s.bg = c
        i += 4
      } else {
        // Malformed extended color — skip the lone 38/48.
        i += 1
      }
    }
    i++
  }
  return s
}

export function parseAnsi(input: string): AnsiSegment[] {
  const segs: AnsiSegment[] = []
  let i = 0
  let style: AnsiStyle = {}
  while (i < input.length) {
    const next = input.indexOf('\x1b[', i)
    if (next === -1) {
      if (i < input.length) segs.push({ text: input.slice(i), style: { ...style } })
      break
    }
    if (next > i) segs.push({ text: input.slice(i, next), style: { ...style } })
    // CSI: ESC '[' …params… <final byte 0x40–0x7e>. SGR uses 'm' as the final.
    let j = next + 2
    while (j < input.length) {
      const c = input.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) break
      j++
    }
    if (j < input.length && input[j] === 'm') {
      style = applyParams(style, input.slice(next + 2, j))
    }
    // Non-'m' CSI (cursor moves, etc.) and runaway sequences are dropped without emitting text.
    i = j + 1
  }
  return segs
}

// Converts a parsed AnsiStyle into the inline CSS the renderer applies to a <span>.
export function ansiStyleToCss(style: AnsiStyle): Record<string, string> {
  const css: Record<string, string> = {}
  if (style.fg) css.color = style.fg
  if (style.bg) css['background-color'] = style.bg
  if (style.bold) css['font-weight'] = '700'
  if (style.dim) css.opacity = '0.65'
  if (style.italic) css['font-style'] = 'italic'
  if (style.underline) css['text-decoration'] = 'underline'
  return css
}

// True when the line contains at least one CSI escape — lets the caller pick a fast path for
// the common case of plain log lines (no segmentation needed).
export function hasAnsi(input: string): boolean {
  return input.indexOf('\x1b[') !== -1
}
