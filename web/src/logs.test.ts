import { describe, expect, it } from 'vitest'
import { filterLogLines, formatLogTime, parseJsonLog, parseLogLevel, splitByMatch } from './logs'
import type { LogEntry } from './api'

const lines: LogEntry[] = [
  { pod: 'a', line: 'starting server on :8080' },
  { pod: 'a', line: 'ERROR failed to connect to db' },
  { pod: 'b', line: 'request handled in 3ms' },
  { pod: 'b', line: 'error: retrying connection' },
]

describe('filterLogLines', () => {
  it('keeps every line for an empty or whitespace query', () => {
    expect(filterLogLines(lines, '')).toHaveLength(4)
    expect(filterLogLines(lines, '   ')).toHaveLength(4)
  })

  it('keeps only lines containing the query, case-insensitively', () => {
    const got = filterLogLines(lines, 'ERROR').map((l) => l.line)
    expect(got).toEqual(['ERROR failed to connect to db', 'error: retrying connection'])
  })

  it('matches on substrings anywhere in the line', () => {
    expect(filterLogLines(lines, 'connect').map((l) => l.pod)).toEqual(['a', 'b'])
  })

  it('returns nothing when no line matches', () => {
    expect(filterLogLines(lines, 'timeout')).toEqual([])
  })

  it('hides lines whose detected level is toggled off, keeping unleveled lines (cycle 328)', () => {
    const lvlLines: LogEntry[] = [
      { pod: 'a', line: 'E0521 12:00:00.0 1 main.go:1] boom' }, // error
      { pod: 'a', line: 'W0521 12:00:00.0 1 main.go:2] careful' }, // warn
      { pod: 'a', line: 'I0521 12:00:00.0 1 main.go:3] hello' }, // info
      { pod: 'a', line: 'just some output with no level' }, // unleveled → always kept
    ]
    // Hiding info drops only the info line; the unleveled line survives.
    expect(filterLogLines(lvlLines, '', false, new Set(['info'])).map((l) => l.line)).toEqual([
      'E0521 12:00:00.0 1 main.go:1] boom',
      'W0521 12:00:00.0 1 main.go:2] careful',
      'just some output with no level',
    ])
    // "Errors + warnings only" = hide info and debug.
    expect(filterLogLines(lvlLines, '', false, new Set(['info', 'debug'])).map((l) => l.line)).toEqual([
      'E0521 12:00:00.0 1 main.go:1] boom',
      'W0521 12:00:00.0 1 main.go:2] careful',
      'just some output with no level',
    ])
    // An empty hidden set is a no-op (every line kept).
    expect(filterLogLines(lvlLines, '', false, new Set())).toHaveLength(4)
  })

  it('AND-combines the level filter with the substring query (cycle 328)', () => {
    const lvlLines: LogEntry[] = [
      { pod: 'a', line: 'E0521 1 db connection refused' },
      { pod: 'a', line: 'I0521 1 db pool warmed' },
      { pod: 'a', line: 'E0521 1 cache miss' },
    ]
    // query "db" + hide info → only the error line mentioning db.
    expect(filterLogLines(lvlLines, 'db', false, new Set(['info'])).map((l) => l.line)).toEqual([
      'E0521 1 db connection refused',
    ])
  })

  it('matches case-sensitively when asked (cycle 321)', () => {
    // Case-insensitive "ERROR" matches both the upper-case level and the prose "error".
    expect(filterLogLines(lines, 'ERROR', false).map((l) => l.line)).toEqual([
      'ERROR failed to connect to db',
      'error: retrying connection',
    ])
    // Case-sensitive "ERROR" matches only the upper-case level line.
    expect(filterLogLines(lines, 'ERROR', true).map((l) => l.line)).toEqual(['ERROR failed to connect to db'])
  })
})

describe('formatLogTime', () => {
  it('compacts an RFC3339Nano stamp to HH:MM:SS.mmm in the source UTC (no timezone shift)', () => {
    expect(formatLogTime('2026-05-29T05:40:51.832381Z')).toBe('05:40:51.832')
    expect(formatLogTime('2026-05-29T05:40:51.8Z')).toBe('05:40:51.8')
    expect(formatLogTime('2026-05-29T05:40:51Z')).toBe('05:40:51')
  })
  it('returns the input unchanged when it is not an RFC3339 timestamp', () => {
    expect(formatLogTime('not a time')).toBe('not a time')
    expect(formatLogTime('')).toBe('')
  })
})

describe('parseJsonLog', () => {
  it('leads with the message and trails the remaining fields, dropping badge/time-column keys', () => {
    const line = '{"@timestamp":"2026-06-05T13:57:56.364Z","log.level":"INFO","message":"node started","service":"es","node":"es-0"}'
    expect(parseJsonLog(line)).toEqual({ message: 'node started', extras: 'service=es node=es-0' })
  })
  it('accepts msg/log as message aliases and serializes non-string field values', () => {
    expect(parseJsonLog('{"msg":"ready","port":9200,"tls":true}')).toEqual({ message: 'ready', extras: 'port=9200 tls=true' })
    expect(parseJsonLog('{"log":"hi","tags":["a","b"]}')).toEqual({ message: 'hi', extras: 'tags=["a","b"]' })
  })
  it('returns null for non-JSON, arrays, and objects without a string message — they stay raw', () => {
    expect(parseJsonLog('plain text line')).toBeNull()
    expect(parseJsonLog('E0521 12:00:00 main.go:42] boom')).toBeNull() // klog, not JSON
    expect(parseJsonLog('[1,2,3]')).toBeNull()
    expect(parseJsonLog('{"level":"info","count":3}')).toBeNull() // no message field
    expect(parseJsonLog('{"message":42}')).toBeNull() // message not a string
    expect(parseJsonLog('{ not valid json')).toBeNull()
  })
  it('yields empty extras when the only fields are the message and dropped keys', () => {
    expect(parseJsonLog('{"level":"warn","message":"lonely"}')).toEqual({ message: 'lonely', extras: '' })
  })
})

describe('parseLogLevel', () => {
  it('detects klog/glog single-letter prefixes', () => {
    expect(parseLogLevel('E0521 12:00:00.123456   1 main.go:42] boom')).toBe('error')
    expect(parseLogLevel('W0521 12:00:00.123456   1 main.go:42] careful')).toBe('warn')
    expect(parseLogLevel('I0521 12:00:00.123456   1 main.go:42] hello')).toBe('info')
    expect(parseLogLevel('F0521 12:00:00.123456   1 main.go:42] fatal')).toBe('error')
  })
  it('detects structured level fields (logfmt / json), case-insensitively', () => {
    expect(parseLogLevel('ts=2026-05-21 level=warn msg="disk low"')).toBe('warn')
    expect(parseLogLevel('{"level":"error","msg":"oops"}')).toBe('error')
    expect(parseLogLevel('severity=DEBUG trace data')).toBe('debug')
  })
  it('finds the level in a JSON line even when it sits after a long leading message', () => {
    // pino/bunyan and other message-first loggers put `level` past the first 64 chars; the badge/
    // level-filter/jump-to-error must still classify it (the head-only scan missed it).
    expect(parseLogLevel('{"message":"this message is intentionally quite long to push things","level":"error"}')).toBe('error')
    expect(parseLogLevel('{"msg":"a fairly verbose human-readable line that runs well past sixty chars","log.level":"WARN"}')).toBe('warn')
    // The whole-line scan is gated to JSON: a stray "level=" deep in an UNSTRUCTURED line (past the
    // 64-char head) stays unbadged, so prose can't hijack the badge. The prefix here runs well past
    // 64 chars before "level=" appears.
    expect(parseLogLevel('plain unstructured prose that rambles on at considerable length before mentioning level=error')).toBeNull()
  })
  it('detects an uppercase level token after a timestamp or in brackets', () => {
    expect(parseLogLevel('2026-05-21T12:00:00Z ERROR failed to connect')).toBe('error')
    expect(parseLogLevel('[WARN] retrying')).toBe('warn')
    expect(parseLogLevel('12:00:00 INFO started')).toBe('info')
  })
  it('does NOT badge a lowercase level word buried in prose', () => {
    expect(parseLogLevel('handled request, no error occurred')).toBeNull()
    expect(parseLogLevel('starting server on :8080')).toBeNull()
  })
  it('folds fatal/panic into error and trace into debug', () => {
    expect(parseLogLevel('FATAL boom')).toBe('error')
    expect(parseLogLevel('level=panic msg=x')).toBe('error')
    expect(parseLogLevel('TRACE entering fn')).toBe('debug')
  })
})

describe('splitByMatch', () => {
  it('returns the whole line as a single non-match for an empty query', () => {
    expect(splitByMatch('hello world', '')).toEqual([{ text: 'hello world', match: false }])
  })

  it('splits a line into alternating non-match / match segments, case-insensitively', () => {
    expect(splitByMatch('connect to DB and ConneCT again', 'connect')).toEqual([
      { text: 'connect', match: true },
      { text: ' to DB and ', match: false },
      { text: 'ConneCT', match: true },
      { text: ' again', match: false },
    ])
  })

  it('handles a query that does not appear in the line', () => {
    expect(splitByMatch('hello world', 'xyz')).toEqual([{ text: 'hello world', match: false }])
  })

  it('highlights case-sensitively when asked, skipping differently-cased text (cycle 321)', () => {
    expect(splitByMatch('connect to DB and ConneCT again', 'connect', true)).toEqual([
      { text: 'connect', match: true },
      { text: ' to DB and ConneCT again', match: false },
    ])
  })

  it('preserves consecutive matches without empty segments between them', () => {
    expect(splitByMatch('aaaa', 'a')).toEqual([
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
    ])
  })
})
