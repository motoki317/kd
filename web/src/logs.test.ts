import { describe, expect, it } from 'vitest'
import { filterLogLines } from './logs'
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
