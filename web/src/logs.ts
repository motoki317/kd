import type { LogEntry } from './api'

// filterLogLines keeps only the lines whose text contains the query (case-insensitive) — the
// in-viewer "grep" for finding an error in a busy stream. An empty/whitespace query keeps every
// line, so the filter is off until the user types.
export function filterLogLines(lines: LogEntry[], query: string): LogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return lines
  return lines.filter((l) => l.line.toLowerCase().includes(q))
}

// splitByMatch chops a line into alternating "outside" / "match" segments for the case-insensitive
// query. With an empty query, returns a single match=false segment covering the whole line — keeps
// the renderer's loop uniform whether highlighting is active or not.
export function splitByMatch(line: string, query: string): Array<{ text: string; match: boolean }> {
  const q = query.trim()
  if (!q) return [{ text: line, match: false }]
  const ql = q.toLowerCase()
  const ll = line.toLowerCase()
  const out: Array<{ text: string; match: boolean }> = []
  let i = 0
  while (i < line.length) {
    const idx = ll.indexOf(ql, i)
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
