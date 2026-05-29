import type { LogEntry } from './api'

// filterLogLines keeps only the lines whose text contains the query — the in-viewer "grep" for
// finding an error in a busy stream. Case-insensitive by default (the common triage need); pass
// caseSensitive to match exactly. An empty/whitespace query keeps every line, so the filter is off
// until the user types.
export function filterLogLines(lines: LogEntry[], query: string, caseSensitive = false): LogEntry[] {
  const raw = query.trim()
  if (!raw) return lines
  if (caseSensitive) return lines.filter((l) => l.line.includes(raw))
  const q = raw.toLowerCase()
  return lines.filter((l) => l.line.toLowerCase().includes(q))
}

// splitByMatch chops a line into alternating "outside" / "match" segments for the query, so the
// renderer can highlight the hits. Case-insensitive by default; caseSensitive matches exactly. With
// an empty query, returns a single match=false segment covering the whole line — keeps the
// renderer's loop uniform whether highlighting is active or not.
export function splitByMatch(line: string, query: string, caseSensitive = false): Array<{ text: string; match: boolean }> {
  const q = query.trim()
  if (!q) return [{ text: line, match: false }]
  const needle = caseSensitive ? q : q.toLowerCase()
  const hay = caseSensitive ? line : line.toLowerCase()
  const out: Array<{ text: string; match: boolean }> = []
  let i = 0
  while (i < line.length) {
    const idx = hay.indexOf(needle, i)
    if (idx < 0) {
      out.push({ text: line.slice(i), match: false })
      break
    }
    if (idx > i) out.push({ text: line.slice(i, idx), match: false })
    out.push({ text: line.slice(idx, idx + q.length), match: true })
    i = idx + q.length
  }
  return out
}
