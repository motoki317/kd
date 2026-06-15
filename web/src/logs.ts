import type { LogEntry } from './api'

// LogLevel is the normalized severity kd recognizes in a log line; fatal/panic fold into error and
// trace into debug so the badge palette stays small.
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

// defaultLogContainer picks which container the viewer streams when the operator hasn't chosen one.
// It mirrors the server's defaultLogContainer (internal/api/logstream.go): prefer a container named
// "main" — the Argo Workflows step that does the real work, sitting behind a `wait` executor sidecar
// that's listed FIRST — so a workflow pod's logs aren't pure executor noise. Falls back to the first
// container for an ordinary app+sidecar pod (no `main`). Keeping the two in lockstep means the picker
// shows the same container the server actually streams, whether the stream is a single pod or an
// aggregated workload.
export function defaultLogContainer(containers: string[]): string {
  return containers.includes('main') ? 'main' : (containers[0] ?? '')
}

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
// "level":"error", severity=info), (3) an UPPERCASE level token near the start ("<ts> ERROR …",
// "[WARN]"), or (4) a bare level word of ANY case in the leading FIELD slot — at the line start or
// right after a timestamp ("<ts><TAB>info<TAB>…", as VictoriaMetrics / zap-console / many Go loggers
// emit). A lowercase level word anywhere ELSE (buried in prose) is still ignored. Returns null when
// unsure.
export function parseLogLevel(line: string): LogLevel | null {
  const head = line.slice(0, 64)
  const klog = /^[EWIF]\d{4}\s/.exec(head)
  if (klog) {
    const c = head[0]
    return c === 'E' || c === 'F' ? 'error' : c === 'W' ? 'warn' : 'info'
  }
  // Structured field (level=warn, "log.level":"INFO"). For a JSON line the level can sit AFTER a long
  // message (pino/bunyan and message-first loggers), so scan the whole line — the kv pattern demands a
  // `level:value` shape, so it stays safe from prose. Non-JSON lines keep the cheap 64-char head scan.
  const kvScope = line.charCodeAt(0) === 123 /* { */ ? line : head
  const kv = /\b(?:lvl|level|severity)"?\s*[:=]\s*"?(error|err|fatal|panic|warn|warning|info|debug|trace)\b/i.exec(kvScope)
  if (kv) return classifyLevel(kv[1])
  // Bare uppercase token ("<ts> ERROR …", "[WARN]") — head-only: a stray ERROR deep in an
  // unstructured line is usually prose, not the line's own severity.
  const tok = /(?:^|[\s[(])(ERROR|ERR|FATAL|PANIC|WARN|WARNING|INFO|DEBUG|TRACE)(?:[\s\])]|:)/.exec(head)
  if (tok) return classifyLevel(tok[1])
  // Bare level word — ANY case — in the leading field slot: the line starts with it, or with up to
  // two timestamp-shaped tokens (e.g. "2026-…T…Z<TAB>" or "<date> <time> ") then it, bounded by a
  // delimiter. This is the VictoriaMetrics / zap-console "<ts>\tinfo\t<src>\t<msg>" shape, which the
  // UPPERCASE-only rule above misses. Anchoring to that positional slot is what keeps a lowercase
  // level safe from prose: "returned an error" never starts with a level word or a timestamp.
  const positional = /^(?:[0-9][0-9:.,T/+\-Z]*[ \t]+){0,2}(error|err|fatal|panic|warn|warning|info|debug|trace)(?=[ \t:]|$)/i.exec(head)
  if (positional) return classifyLevel(positional[1])
  return null
}

// parseJsonLog recognizes a JSON-object log line (Elasticsearch, zap, logrus, pino, bunyan, …) and
// splits it into the human message and the remaining fields, so the viewer can LEAD with the message —
// the part an operator actually reads — instead of a wall of raw JSON with the message buried
// mid-object. Returns null for anything that isn't a JSON object carrying a recognizable message field,
// so plain-text/klog lines fall through to the normal renderer untouched. NON-DESTRUCTIVE: `extras`
// carries every other field except the ones the viewer ALREADY surfaces (the level badge + the time
// column), so nothing readable is hidden; callers keep the raw line for copy/grep — this only reorders
// what is shown. Conservative on purpose: an object without a string message stays raw rather than
// guessing which field is the message.
const JSON_MSG_KEYS = ['message', 'msg', 'log'] as const
// Keys already represented by the badge/time column (or pure noise) — dropped from `extras` so the
// reformat is a net DE-clutter. Everything else is preserved as `key=value`.
const JSON_DROP_KEYS = new Set(['message', 'msg', 'log', 'level', 'lvl', 'severity', 'log.level', '@timestamp', 'timestamp', 'time', 'ts'])

export function parseJsonLog(line: string): { message: string; extras: string } | null {
  const t = line.trimStart()
  if (t[0] !== '{') return null // fast path: the vast majority of lines are not JSON objects
  let obj: unknown
  try {
    obj = JSON.parse(t)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  const msgKey = JSON_MSG_KEYS.find((k) => typeof rec[k] === 'string')
  if (!msgKey) return null
  const extras = Object.keys(rec)
    .filter((k) => !JSON_DROP_KEYS.has(k))
    .map((k) => `${k}=${typeof rec[k] === 'string' ? rec[k] : JSON.stringify(rec[k])}`)
    .join(' ')
  return { message: rec[msgKey] as string, extras }
}

// parseLogfmtLog does for logfmt (`key=value key="quoted value" …`) what parseJsonLog does for JSON:
// the Go ecosystem (argocd, prometheus, controller-runtime, logrus' text formatter) emits lines whose
// left edge is `time="…" level=info` metadata, burying the `msg="…"` an operator actually reads. This
// splits out the message so the viewer leads with it and dims the rest, reusing the same drop-set so
// the badge/time column aren't duplicated. CONSERVATIVE: the line must START with a `key=` token AND
// carry a msg/message field — so a klog line ("I0521 …") or prose with an incidental `foo=bar` is left
// raw. NON-DESTRUCTIVE: extras keeps every other pair, and the raw line still backs copy/grep.
const LOGFMT_PAIR = /([A-Za-z0-9_.\-]+)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g

export function parseLogfmtLog(line: string): { message: string; extras: string } | null {
  const t = line.trimStart()
  if (!/^[A-Za-z0-9_.\-]+=/.test(t)) return null // must open with a key= token — the logfmt signal
  const pairs: Array<[string, string]> = []
  LOGFMT_PAIR.lastIndex = 0
  for (let m = LOGFMT_PAIR.exec(t); m; m = LOGFMT_PAIR.exec(t)) {
    let val = m[2]
    if (val.length >= 2 && val[0] === '"') val = val.slice(1, -1).replace(/\\(.)/g, '$1') // unquote + unescape
    pairs.push([m[1], val])
  }
  const msg = pairs.find(([k]) => (JSON_MSG_KEYS as readonly string[]).includes(k))
  if (!msg) return null // no human message to lead with — leave the line raw
  const extras = pairs
    .filter(([k]) => !JSON_DROP_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return { message: msg[1], extras }
}

// formatLogTime compacts a kubectl --timestamps RFC3339Nano stamp (2026-05-29T05:40:51.832381Z) to
// HH:MM:SS.mmm for the timestamp column. It slices the time substring out directly rather than
// parsing into a Date, so the value stays in the source's UTC (lining up with kubectl --timestamps)
// and sub-millisecond noise is trimmed. The full stamp stays available in the line's title. Returns
// the input unchanged when it isn't an RFC3339 timestamp (some logs carry their own time prefix).
export function formatLogTime(raw: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(raw)
  if (!m) return raw
  return m[2] ? `${m[1]}.${m[2].slice(0, 3)}` : m[1]
}

// filterLogLines keeps only the lines whose text contains the query — the in-viewer "grep" for
// finding an error in a busy stream. Case-insensitive by default (the common triage need); pass
// caseSensitive to match exactly. An empty/whitespace query keeps every line, so the filter is off
// until the user types. hiddenLevels (cycle 328) additionally drops lines whose DETECTED level is
// toggled off — combined with the substring filter via AND. Lines with no confident level (stack-trace
// bodies, continuation lines, plain stdout) are always kept so hiding INFO/DEBUG noise doesn't swallow
// the context around an error.
export function filterLogLines(
  lines: LogEntry[],
  query: string,
  caseSensitive = false,
  hiddenLevels?: Set<LogLevel>,
): LogEntry[] {
  const raw = query.trim()
  const hideLevels = !!hiddenLevels && hiddenLevels.size > 0
  if (!raw && !hideLevels) return lines
  const q = caseSensitive ? raw : raw.toLowerCase()
  return lines.filter((l) => {
    if (hideLevels) {
      const lvl = parseLogLevel(l.line)
      if (lvl && hiddenLevels!.has(lvl)) return false
    }
    if (!raw) return true
    return caseSensitive ? l.line.includes(raw) : l.line.toLowerCase().includes(q)
  })
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
