import { describe, expect, it } from 'vitest'
import { filterLogLines, splitByMatch } from './logs'
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

  it('preserves consecutive matches without empty segments between them', () => {
    expect(splitByMatch('aaaa', 'a')).toEqual([
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
      { text: 'a', match: true },
    ])
  })
})
