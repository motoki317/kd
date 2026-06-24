// Lightweight, dependency-free tokenizer that colors the drawer's manifest tab. The input is never
// hand-written YAML/JSON — it is machine-emitted by the server (`sigs.k8s.io/yaml` Marshal and
// `json.MarshalIndent`), so the grammar is a narrow, predictable subset: no comments, no anchors/
// aliases/tags, no `---` document markers, and keywords are only bare `true`/`false`/`null`. That
// constraint is what makes a hand-rolled scanner safe here instead of the usual "never hand-parse
// YAML" trap, and keeps the bundle untouched (a TextMate/Shiki engine would add tens of KB plus an
// opaque-HTML output the within-manifest search `<mark>` overlay can't compose with).
//
// INVARIANT: concatenating every token's text reproduces the input byte-for-byte. Mis-coloring is
// cosmetic; dropping or duplicating a character would corrupt the displayed manifest. The test suite
// asserts this round-trip over the whole fixture corpus first.

export type TokType = 'key' | 'string' | 'number' | 'keyword' | 'punct' | 'plain'
export interface Token {
  text: string
  type: TokType
}

// Bare YAML/JSON scalar that is a number (so it renders unquoted): integer, decimal, or exponent.
const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
// Block scalar indicator: `|` or `>` with an optional chomping (`+`/`-`) and/or explicit indent digit.
const BLOCK_RE = /^[|>][+-]?\d*$/
// JSON number, sticky so the scanner advances without slicing the (possibly large) source per token.
const JSON_NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

export function tokenizeManifest(text: string, format: 'yaml' | 'json'): Token[] {
  return format === 'json' ? tokenizeJson(text) : tokenizeYaml(text)
}

function leadingSpaces(s: string): number {
  let i = 0
  while (i < s.length && s[i] === ' ') i++
  return i
}

// --- YAML ----------------------------------------------------------------------------------------
// Line-oriented: the marshaled YAML is block style, so each line is one of "key:", "key: value",
// "- value", or block-scalar content. The one piece of cross-line state is an open block scalar:
// after `key: |`, every following line indented deeper than that key is verbatim string content.
function tokenizeYaml(text: string): Token[] {
  const out: Token[] = []
  const lines = text.split('\n')
  // Indentation of the key that opened the current block scalar, or null when not inside one.
  let blockIndent: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (blockIndent !== null) {
      const blank = line.trim() === ''
      if (blank || leadingSpaces(line) > blockIndent) {
        if (line.length) out.push({ text: line, type: 'string' })
        if (i < lines.length - 1) out.push({ text: '\n', type: 'plain' })
        continue
      }
      blockIndent = null // a line at/under the opener's indent ends the block — parse it normally
    }
    blockIndent = tokenizeYamlLine(line, out)
    if (i < lines.length - 1) out.push({ text: '\n', type: 'plain' })
  }
  return out
}

// Tokenizes one YAML line into `out`. Returns the line's indent when the line opens a block scalar
// (`key: |`), else null.
function tokenizeYamlLine(line: string, out: Token[]): number | null {
  if (line === '') return null
  const indent = leadingSpaces(line)
  if (indent) out.push({ text: line.slice(0, indent), type: 'plain' })
  let rest = line.slice(indent)
  // Sequence markers ("- ", possibly stacked for a list-of-lists) are structure, not content.
  while (rest === '-' || rest.startsWith('- ')) {
    if (rest === '-') {
      out.push({ text: '-', type: 'punct' })
      return null
    }
    out.push({ text: '- ', type: 'punct' })
    rest = rest.slice(2)
  }
  if (rest === '') return null
  const sep = findKeyColon(rest)
  if (sep < 0) {
    // No "key:" separator → the whole remainder is a scalar (a list item's value).
    return tokenizeYamlValue(rest, out) ? indent : null
  }
  const keyText = rest.slice(0, sep)
  if (keyText) out.push({ text: keyText, type: 'key' })
  out.push({ text: ':', type: 'punct' })
  return tokenizeYamlValue(rest.slice(sep + 1), out) ? indent : null
}

// Index of the ':' that separates a key from its value — a colon followed by a space or end-of-line,
// outside any quotes. A colon inside a value (`image: nginx:1.25`, `path: http://x`) is followed by a
// non-space, so it is not mistaken for a key separator.
function findKeyColon(s: string): number {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === ':' && (i + 1 >= s.length || s[i + 1] === ' ')) return i
  }
  return -1
}

// Tokenizes a YAML value (leading whitespace + scalar/indicator). Returns true when the value is a
// block-scalar indicator, signaling the caller that following indented lines are string content.
function tokenizeYamlValue(v: string, out: Token[]): boolean {
  if (v === '') return false
  const ws = leadingSpaces(v)
  if (ws) out.push({ text: v.slice(0, ws), type: 'plain' })
  const t = v.slice(ws)
  if (t === '') return false
  if (BLOCK_RE.test(t)) {
    out.push({ text: t, type: 'punct' })
    return true
  }
  if (t === '{}' || t === '[]') {
    out.push({ text: t, type: 'punct' })
    return false
  }
  if (t[0] === '"' || t[0] === "'") {
    const end = quotedEnd(t)
    out.push({ text: t.slice(0, end), type: 'string' })
    if (end < t.length) out.push({ text: t.slice(end), type: 'plain' })
    return false
  }
  if (NUM_RE.test(t)) out.push({ text: t, type: 'number' })
  else if (t === 'true' || t === 'false' || t === 'null' || t === '~') out.push({ text: t, type: 'keyword' })
  else out.push({ text: t, type: 'string' }) // bare scalar reads as a string value
  return false
}

// Index just past the closing quote of a value that starts with a quote (handles `\"` escapes in
// double-quoted strings). Returns the full length when unterminated, so no character is dropped.
function quotedEnd(t: string): number {
  const q = t[0]
  for (let i = 1; i < t.length; i++) {
    if (q === '"' && t[i] === '\\') {
      i++
      continue
    }
    if (t[i] === q) return i + 1
  }
  return t.length
}

// --- JSON ----------------------------------------------------------------------------------------
function tokenizeJson(text: string): Token[] {
  const out: Token[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\n' || text[j] === '\t' || text[j] === '\r')) j++
      out.push({ text: text.slice(i, j), type: 'plain' })
      i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === '"') {
          j++
          break
        }
        j++
      }
      // A string immediately before a ':' is an object key; otherwise it is a value.
      let k = j
      while (k < n && (text[k] === ' ' || text[k] === '\n' || text[k] === '\t' || text[k] === '\r')) k++
      out.push({ text: text.slice(i, j), type: text[k] === ':' ? 'key' : 'string' })
      i = j
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      JSON_NUM_RE.lastIndex = i
      const m = JSON_NUM_RE.exec(text)
      if (m && m.index === i) {
        out.push({ text: m[0], type: 'number' })
        i += m[0].length
      } else {
        out.push({ text: c, type: 'plain' })
        i++
      }
    } else if (text.startsWith('true', i)) {
      out.push({ text: 'true', type: 'keyword' })
      i += 4
    } else if (text.startsWith('false', i)) {
      out.push({ text: 'false', type: 'keyword' })
      i += 5
    } else if (text.startsWith('null', i)) {
      out.push({ text: 'null', type: 'keyword' })
      i += 4
    } else if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      out.push({ text: c, type: 'punct' })
      i++
    } else {
      out.push({ text: c, type: 'plain' })
      i++
    }
  }
  return out
}

// --- line model + field folding ------------------------------------------------------------------
export interface ManifestLine {
  text: string
  tokens: Token[]
}

// Regroups the flat token stream into one entry per source line, splitting any token that straddles a
// newline (JSON whitespace runs carry `\n` plus the next line's indent in one token). Round-trip holds
// per line: lines.map(l => l.text).join('\n') === input.
export function splitManifestLines(text: string, format: 'yaml' | 'json'): ManifestLine[] {
  const lines: ManifestLine[] = [{ text: '', tokens: [] }]
  for (const tok of tokenizeManifest(text, format)) {
    const parts = tok.text.split('\n')
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) lines.push({ text: '', tokens: [] })
      if (parts[p] !== '') {
        const cur = lines[lines.length - 1]
        cur.tokens.push({ text: parts[p], type: tok.type })
        cur.text += parts[p]
      }
    }
  }
  return lines
}

// A collapsible region: the header line whose body (header+1 .. end, inclusive) hides when collapsed.
export interface FoldRegion {
  header: number
  end: number
  hiddenCount: number
}

interface LineMeta {
  indent: number
  blank: boolean
  seq: boolean
}
function lineMeta(text: string): LineMeta {
  const indent = leadingSpaces(text)
  const t = text.slice(indent)
  return { indent, blank: t === '', seq: t === '-' || t.startsWith('- ') }
}

// Folding is indentation-based and works for both the server's pretty-printed JSON and its block-style
// YAML — with one twist the YAML marshaler forces: yaml.v2 emits sequence items at the SAME indent as
// their parent key (`containers:` and its `- …` items both at column N), not deeper. So a line is a
// header either when the next non-blank line is indented deeper (mapping/array child) OR sits at the
// same indent as a sequence item while the header itself is not one. The `!header.seq` guard stops a
// `- item` header at its next sibling `-` instead of swallowing the rest of the list. Blank lines stay
// inside the open region (a block scalar's body may contain them) but never extend it past its last
// non-blank line.
export function computeFolds(lineTexts: string[]): FoldRegion[] {
  const meta = lineTexts.map(lineMeta)
  const inside = (m: LineMeta, header: LineMeta) =>
    m.indent > header.indent || (m.indent === header.indent && m.seq && !header.seq)
  const regions: FoldRegion[] = []
  for (let i = 0; i < meta.length; i++) {
    if (meta[i].blank) continue
    let j = i + 1
    while (j < meta.length && meta[j].blank) j++
    if (j >= meta.length || !inside(meta[j], meta[i])) continue
    let last = -1
    for (let k = j; k < meta.length; k++) {
      if (meta[k].blank) continue
      if (!inside(meta[k], meta[i])) break
      last = k
    }
    if (last >= i + 1) regions.push({ header: i, end: last, hiddenCount: last - i })
  }
  return regions
}

// --- search composition --------------------------------------------------------------------------
export interface Span {
  text: string
  type: TokType
}
export interface MatchRun {
  match: boolean
  spans: Span[]
}

// Overlays the within-manifest search segmentation onto the syntax tokens. `runs` is the output of
// splitByMatch over the SAME text (alternating outside/match segments); both segmentations cover the
// text exactly, so a single linear walk slices the tokens at each run boundary. Match runs stay the
// primary segmentation (one `<mark>` per hit, preserving the find count/scroll/index machinery) with
// the colored syntax spans nested inside each run.
export function mergeMatchRuns(tokens: Token[], runs: Array<{ text: string; match: boolean }>): MatchRun[] {
  const out: MatchRun[] = []
  let ti = 0 // current token
  let to = 0 // offset within the current token
  for (const run of runs) {
    let remaining = run.text.length
    const spans: Span[] = []
    while (remaining > 0 && ti < tokens.length) {
      const tok = tokens[ti]
      const take = Math.min(tok.text.length - to, remaining)
      spans.push({ text: tok.text.slice(to, to + take), type: tok.type })
      to += take
      remaining -= take
      if (to >= tok.text.length) {
        ti++
        to = 0
      }
    }
    out.push({ match: run.match, spans })
  }
  return out
}
