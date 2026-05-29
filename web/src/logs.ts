import type { LogEntry } from './api'

// LogLevel is the normalized severity kd recognizes in a log line; fatal/panic fold into error and
// trace into debug so the badge palette stays small.
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

function classifyLevel(word: string): LogLevel {
  const w = word.toLowerCase()
  if (w === 'error' || w === 'err' || w === 'fatal' || w === 'panic') return 'error'
  if (w === 'warn' || w === 'warning') return 'warn'
  if (w === 'debug' || w === 'trace') return 'debug'
  return 'info'
}

// parseLogLevel best-effort extracts a severity from the head of a log line so the viewer can show a
// colored badge for error-first scanning. Deliberately CONSERVATIVE to avoid badging prose: it only
// recognizes (1) klog/glog "E0521 …" prefixes, (2) an explicit structured field (level=warn,
// "level":"error", severity=info), or (3) an UPPERCASE level token near the start ("<ts> ERROR …",
// "[WARN]") — a lowercase "error" buried in a message is ignored. Returns null when unsure.
export function parseLogLevel(line: string): LogLevel | null {
  const head = line.slice(0, 64)
  const klog = /^[EWIF]\d{4}\s/.exec(head)
  if (klog) {
    const c = head[0]
    return c === 'E' || c === 'F' ? 'error' : c === 'W' ? 'warn' : 'info'
  }
  const kv = /\b(?:lvl|level|severity)"?\s*[:=]\s*"?(error|err|fatal|panic|warn|warning|info|debug|trace)\b/i.exec(head)
  if (kv) return classifyLevel(kv[1])
  const tok = /(?:^|[\s[(])(ERROR|ERR|FATAL|PANIC|WARN|WARNING|INFO|DEBUG|TRACE)(?:[\s\])]|:)/.exec(head)
  if (tok) return classifyLevel(tok[1])
  return null
}

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
