import { describe, expect, it } from 'vitest'
import { filterLogLines, formatLogTime, parseLogLevel, splitByMatch } from './logs'
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
