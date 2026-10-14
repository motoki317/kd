import { describe, expect, it } from 'vitest'
import type { LogEntry } from './api'
import { createLogResume, LOG_BUFFER_CAPACITY } from './logResume'

const older = '2021-05-21T12:00:00.799799344Z'
const last = '2021-05-21T12:00:00.799799345Z'
const newer = '2021-05-21T12:00:00.799799346Z'
const entry = (time: string | undefined, line: string, pod = 'shop-0', container = 'app'): LogEntry =>
  ({ pod, container, time, line })

describe('log resume', () => {
  it('caps records at the buffer capacity and evicts the oldest accepted sources', () => {
    const resume = createLogResume()
    const logs = Array.from({ length: LOG_BUFFER_CAPACITY + 2 }, (_, i) => entry(last, 'burst', `shop-${i}`))
    logs.forEach(log => resume.accept(log))
    resume.opened()
    expect(logs.filter(resume.accept)).toEqual(logs.slice(0, 2))
  })

  it.each([newer, last, older, undefined])('refreshes source recency on an accepted update at %s', time => {
    const resume = createLogResume()
    const logs = Array.from({ length: LOG_BUFFER_CAPACITY }, (_, i) => entry(last, 'burst', `shop-${i}`))
    logs.forEach(log => resume.accept(log))
    expect(resume.accept({ ...logs[0], time, line: 'refreshed' })).toBe(true)
    const fresh = entry(last, 'burst', 'shop-new')
    resume.accept(fresh)
    resume.opened()
    expect(resume.accept(logs[0])).toBe(false)
    expect(resume.accept(logs[1])).toBe(true)
    expect(logs.slice(2).filter(resume.accept)).toEqual([])
    expect(resume.accept(fresh)).toBe(false)
  })

  it('does not refresh source recency when a replay is dropped', () => {
    const resume = createLogResume()
    const logs = Array.from({ length: LOG_BUFFER_CAPACITY }, (_, i) => entry(last, 'burst', `shop-${i}`))
    logs.forEach(log => resume.accept(log))
    resume.opened()
    expect(resume.accept(logs[0])).toBe(false)
    resume.accept(entry(last, 'burst', 'shop-new'))
    resume.opened()
    expect(resume.accept(logs[0])).toBe(true)
    expect(resume.accept(logs[1])).toBe(false)
  })

  it('keeps every line before the first reconnect', () => {
    const resume = createLogResume()
    for (const log of [entry(last, 'burst'), entry(last, 'burst'), entry(older, 'earlier')]) {
      expect(resume.accept(log)).toBe(true)
    }
  })

  it('drops a replayed tail and keeps lines after the snapshot', () => {
    const resume = createLogResume()
    const tail = [entry(older, 'earlier'), entry(last, 'burst')]
    tail.forEach(log => resume.accept(log))
    resume.opened()
    expect([...tail, entry(newer, 'burst')].filter(resume.accept)).toEqual([entry(newer, 'burst')])
  })

  it('keeps a new equal-stamp line when the tail window slides', () => {
    const resume = createLogResume()
    ;['A', 'B'].forEach(line => resume.accept(entry(last, line)))
    resume.opened()
    expect(['B', 'C'].filter(line => resume.accept(entry(last, line)))).toEqual(['C'])
    resume.opened()
    expect(['C', 'B', 'A', 'D', 'D'].filter(line => resume.accept(entry(last, line)))).toEqual(['D', 'D'])
  })

  it('keeps one of three equal-stamp copies after two were delivered', () => {
    const resume = createLogResume()
    const burst = entry(last, 'burst')
    resume.accept(burst)
    resume.accept(burst)
    resume.opened()
    expect([burst, burst, burst].filter(resume.accept)).toEqual([burst])
    resume.opened()
    expect([burst, burst, burst, burst].filter(resume.accept)).toEqual([burst])
  })

  it('passes unstamped lines without changing the stamped record', () => {
    const resume = createLogResume()
    const stamped = entry(last, 'burst')
    const unstamped = [entry(undefined, 'burst'), entry('', 'plain')]
    resume.accept(stamped)
    unstamped.forEach(log => expect(resume.accept(log)).toBe(true))
    resume.opened()
    unstamped.forEach(log => expect(resume.accept(log)).toBe(true))
    expect(resume.accept(stamped)).toBe(false)
  })

  it('keeps pod and container sources independent, including new sources', () => {
    const resume = createLogResume()
    const tail = [entry(last, 'burst'), entry(older, 'burst', 'shop-0', 'sidecar'), entry(newer, 'burst', 'shop-1')]
    tail.forEach(log => resume.accept(log))
    resume.opened()
    tail.forEach(log => expect(resume.accept(log)).toBe(false))
    expect(resume.accept(entry(last, 'burst', 'shop-0', 'sidecar'))).toBe(true)
    expect(resume.accept(entry(older, 'burst', 'shop-2'))).toBe(true)
    expect(resume.accept(entry(older, 'burst', 'shop-0', 'debugger'))).toBe(true)
    expect(resume.accept(entry(last, 'burst', 'shop-1'))).toBe(false)
  })

  it('snapshots the latest live state on a second reconnect', () => {
    const resume = createLogResume()
    resume.accept(entry(last, 'first'))
    resume.opened()
    expect(resume.accept(entry(newer, 'next'))).toBe(true)
    expect(resume.accept(entry(newer, 'next'))).toBe(true)
    expect(resume.accept(entry(last, 'first'))).toBe(false)
    resume.opened()
    expect(resume.accept(entry(last, 'unseen older text'))).toBe(false)
    expect([1, 2, 3].filter(() => resume.accept(entry(newer, 'next')))).toEqual([3])
  })

  it('records only the newest timestamp even when accepted input arrives out of order', () => {
    const resume = createLogResume()
    resume.accept(entry(newer, 'newest'))
    resume.accept(entry(older, 'earlier'))
    resume.opened()
    expect(resume.accept(entry(last, 'middle'))).toBe(false)
    expect(resume.accept(entry(newer, 'newest'))).toBe(false)
  })

  it('does not filter lines from a new source until the next reconnect', () => {
    const resume = createLogResume()
    resume.opened()
    const fresh = entry(last, 'burst')
    expect(resume.accept(fresh)).toBe(true)
    expect(resume.accept(fresh)).toBe(true)
    resume.opened()
    expect([fresh, fresh, fresh].filter(resume.accept)).toEqual([fresh])
  })

  it('keeps the reconnect snapshot fixed while accepted lines update the live record', () => {
    const resume = createLogResume()
    resume.accept(entry(older, 'earlier'))
    resume.opened()
    expect(resume.accept(entry(newer, 'burst'))).toBe(true)
    expect(resume.accept(entry(newer, 'burst'))).toBe(true)
    expect(resume.accept(entry(last, 'middle'))).toBe(true)
    resume.opened()
    expect(resume.accept(entry(last, 'middle'))).toBe(false)
  })
})
