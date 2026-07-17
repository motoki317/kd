import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamGraph, streamNamespaces, type NamespaceInfo } from './api'

// A minimal EventSource stand-in: jsdom ships none, so tests drive the watchdog by constructing these
// and firing events by hand. Instances accumulate so a reconnect is observable as a second instance.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  closed = false
  onerror: ((e: unknown) => void) | null = null
  private listeners: Record<string, ((e: unknown) => void)[]> = {}
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (e: unknown) => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }
  close() {
    // Real EventSource.close() stops delivery; this mock deliberately keeps dispatching afterward so
    // the generation-guard tests can fire a late event from a source the watchdog already superseded.
    this.closed = true
  }
  emit(name: string, data = '') {
    for (const fn of this.listeners[name] ?? []) fn({ data })
  }
  error() {
    this.onerror?.({})
  }
  static reset() {
    MockEventSource.instances = []
  }
  static get count() {
    return MockEventSource.instances.length
  }
  static get last() {
    return MockEventSource.instances[MockEventSource.instances.length - 1]
  }
}

const nsPayload = (list: NamespaceInfo[]) => JSON.stringify({ namespaces: list })

beforeEach(() => {
  vi.useFakeTimers()
  MockEventSource.reset()
  vi.stubGlobal('EventSource', MockEventSource)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks() // undo any Math.random spy
  vi.useRealTimers()
})

describe('streamNamespaces watchdog', () => {
  it('stays on one connection while pings keep arriving (no false reconnect)', () => {
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    // A ping every 15s over ~2 minutes must never trip the ~40s staleness watchdog.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(15_000)
      MockEventSource.last.emit('ping')
    }
    expect(MockEventSource.count).toBe(1)
    close()
  })

  it('reconnects exactly once after the staleness window of silence', () => {
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    const first = MockEventSource.last
    first.emit('open')
    vi.advanceTimersByTime(41_000) // past ~40s with no ping/data
    expect(MockEventSource.count).toBe(2) // recreated in place
    expect(first.closed).toBe(true) // old source torn down
    close()
  })

  it('re-attaches handlers on reconnect so data still flows', () => {
    const seen: NamespaceInfo[][] = []
    const close = streamNamespaces('ctx', { namespaces: (l) => seen.push(l) })
    MockEventSource.last.emit('open')
    vi.advanceTimersByTime(41_000) // force a reconnect
    MockEventSource.last.emit('namespaces', nsPayload([{ name: 'demo-a', health: 'Healthy' }]))
    expect(seen).toEqual([[{ name: 'demo-a', health: 'Healthy' }]])
    close()
  })

  it('treats domain data as liveness (no reconnect while data flows)', () => {
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    vi.advanceTimersByTime(30_000)
    MockEventSource.last.emit('namespaces', nsPayload([{ name: 'demo-a', health: 'Progressing' }]))
    vi.advanceTimersByTime(30_000) // 60s total, but the 30s-mark data re-armed the timer
    expect(MockEventSource.count).toBe(1)
    close()
  })

  it('stops watching after close (no reconnect once torn down)', () => {
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    close()
    vi.advanceTimersByTime(120_000)
    expect(MockEventSource.count).toBe(1)
    expect(MockEventSource.instances[0].closed).toBe(true)
  })

  it('ignores a late event from the superseded source (generation guard)', () => {
    const seen: NamespaceInfo[][] = []
    const close = streamNamespaces('ctx', { namespaces: (l) => seen.push(l) })
    const stale = MockEventSource.last
    stale.emit('open')
    vi.advanceTimersByTime(41_000) // reconnect: `stale` is now superseded
    stale.emit('namespaces', nsPayload([{ name: 'ghost', health: 'Degraded' }]))
    expect(seen).toEqual([]) // the dead source's late payload must not reach the app
    close()
  })

  it('grows the reconnect backoff on repeated silence and caps it (no runaway)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter factor -> 1.0, so the gaps are exact
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    // Each reconnect's replacement is left silent (no open/ping), so the backstop keeps firing with a
    // growing gap: 40s (initial) -> 60 -> 90 -> 120 -> 120 (capped). A flattened or uncapped backoff
    // would diverge from this and fail.
    const step = (advance: number, expected: number) => {
      vi.advanceTimersByTime(advance)
      expect(MockEventSource.count).toBe(expected)
    }
    step(40_000, 2)
    step(59_000, 2) // gap is 60s — not yet
    step(1_000, 3)
    step(89_000, 3) // gap is 90s
    step(1_000, 4)
    step(119_000, 4) // gap capped at 120s
    step(1_000, 5)
    step(120_000, 6) // still 120s — plateau, not runaway
    close()
  })

  it('leaves the staleness backstop armed after a native error', () => {
    const errs: number[] = []
    const close = streamNamespaces('ctx', { namespaces: () => {}, error: () => errs.push(1) })
    MockEventSource.last.emit('open')
    MockEventSource.last.error() // native error: onError fires; EventSource itself would retry
    expect(errs).toEqual([1])
    // The watchdog does NOT reconnect on the error (native retry owns that); the timer stays armed, so
    // if that retry never delivers, silence past the window still forces a fresh connection.
    vi.advanceTimersByTime(41_000)
    expect(MockEventSource.count).toBe(2)
    close()
  })

  it('ignores a native error from a superseded source (no false offline flip)', () => {
    const errs: number[] = []
    const close = streamNamespaces('ctx', { namespaces: () => {}, error: () => errs.push(1) })
    const stale = MockEventSource.last
    stale.emit('open')
    vi.advanceTimersByTime(41_000) // reconnect; `stale` is superseded
    stale.error() // a late error from the dead source
    expect(errs).toEqual([])
    close()
  })

  it('re-arms the grace window on tab refocus instead of reconnecting immediately', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    vi.advanceTimersByTime(30_000) // 30s of silence; a reconnect would fire at 40s
    document.dispatchEvent(new Event('visibilitychange')) // refocus re-arms the deadline
    vi.advanceTimersByTime(30_000) // 60s total, but the deadline was pushed to 30+40=70s
    expect(MockEventSource.count).toBe(1) // not reconnected yet — grace granted
    vi.advanceTimersByTime(11_000) // past the re-armed window
    expect(MockEventSource.count).toBe(2)
    close()
  })

  it('stops watching visibility after close (no reconnect, no leaked listener)', () => {
    const close = streamNamespaces('ctx', { namespaces: () => {} })
    MockEventSource.last.emit('open')
    close()
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(120_000)
    expect(MockEventSource.count).toBe(1)
  })
})

describe('streamGraph watchdog', () => {
  it('reconnects to the same graph stream after the staleness window', () => {
    const close = streamGraph('ctx', 'shop', { snapshot: () => {}, patch: () => {} })
    const first = MockEventSource.last
    first.emit('open')
    vi.advanceTimersByTime(41_000)
    expect(MockEventSource.count).toBe(2)
    expect(MockEventSource.last.url).toBe(first.url)
    close()
  })

  it('treats graph data as liveness', () => {
    const close = streamGraph('ctx', 'shop', { snapshot: () => {}, patch: () => {} })
    MockEventSource.last.emit('open')
    vi.advanceTimersByTime(30_000)
    MockEventSource.last.emit('capacity', '{"nodes":[]}')
    vi.advanceTimersByTime(30_000)
    expect(MockEventSource.count).toBe(1)
    close()
  })

  it('re-attaches every graph handler on reconnect', () => {
    const seen: string[] = []
    const close = streamGraph('ctx', 'shop', {
      snapshot: () => seen.push('snapshot'),
      patch: () => seen.push('patch'),
      summary: () => seen.push('summary'),
      capacity: () => seen.push('capacity'),
      error: () => seen.push('error'),
    })
    MockEventSource.last.emit('open')
    vi.advanceTimersByTime(41_000)
    const replacement = MockEventSource.last
    replacement.emit('snapshot', '{}')
    replacement.emit('patch', '{}')
    replacement.emit('summary', '{}')
    replacement.emit('capacity', '{}')
    replacement.error()
    expect(seen).toEqual(['snapshot', 'patch', 'summary', 'capacity', 'error'])
    close()
  })

  it('stops watching after close', () => {
    const close = streamGraph('ctx', 'shop', { snapshot: () => {}, patch: () => {} })
    const source = MockEventSource.last
    source.emit('open')
    close()
    vi.advanceTimersByTime(120_000)
    expect(MockEventSource.count).toBe(1)
    expect(source.closed).toBe(true)
  })
})
