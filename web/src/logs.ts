import type { LogEntry } from './api'

// filterLogLines keeps only the lines whose text contains the query (case-insensitive) — the
// in-viewer "grep" for finding an error in a busy stream. An empty/whitespace query keeps every
// line, so the filter is off until the user types.
export function filterLogLines(lines: LogEntry[], query: string): LogEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return lines
  return lines.filter((l) => l.line.toLowerCase().includes(q))
}
