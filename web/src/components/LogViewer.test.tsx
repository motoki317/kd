import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogViewer from './LogViewer'

// LogViewer opens an EventSource on mount; a no-op stub keeps it from touching the network. The
// class tracks its instances so a test can fire onerror to assert how the viewer renders a stream
// drop, and supports message dispatch for tests that exercise filtering / highlight rendering.
let eventSources: NoopEventSource[] = []
class NoopEventSource {
  onerror: (() => void) | null = null
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {}
  constructor() {
    eventSources.push(this)
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    ;(this.listeners[name] ||= []).push(fn)
  }
  emit(name: string, payload: unknown) {
    const ev = new MessageEvent(name, { data: JSON.stringify(payload) })
    for (const fn of this.listeners[name] ?? []) fn(ev)
  }
  close() {}
}
beforeEach(() => {
  eventSources = []
  vi.stubGlobal('EventSource', NoopEventSource)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const base = { namespace: 'shop', kind: 'Pod', name: 'web-1' }

describe('LogViewer', () => {
  it('offers a container picker only for a single multi-container pod', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app', 'sidecar']} restarts={0} />)
    const select = container.querySelector('.logs-container')
    expect(select).toBeTruthy()
    expect(select!.querySelectorAll('option').length).toBe(2)
  })

  it('hides the picker for a single-container pod and for aggregated logs', () => {
    const single = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(single.container.querySelector('.logs-container')).toBeNull()
    const agg = render(() => <LogViewer ctx="test-ctx" namespace="shop" kind="Deployment" name="web" aggregated={true} containers={['app', 'sidecar']} restarts={0} />)
    expect(agg.container.querySelector('.logs-container')).toBeNull()
  })

  it('always offers a timestamps toggle', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(container.querySelector('.logs-ts')?.textContent).toContain('timestamps')
  })

  // The scroll region is a tab stop so keyboard users can focus and arrow-scroll it (Firefox doesn't
  // auto-focus scrollable regions like Chrome), and so the expanded-drawer focus trap (cycle 326)
  // counts it as a boundary instead of letting Tab fall through to the canvas behind.
  it('makes the log scroll region keyboard-focusable', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(container.querySelector('pre.logs-body')?.getAttribute('tabindex')).toBe('0')
  })

  // Wrap defaults on (today's behavior); toggling off switches the body to no-wrap horizontal scroll
  // and persists the choice so it survives pod switches and reloads (cycle 327).
  it('toggles line wrapping and persists the preference', () => {
    localStorage.removeItem('kd:logsWrap')
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    const body = container.querySelector('pre.logs-body')!
    const toggle = container.querySelector('.logs-wrap') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    expect(body.classList.contains('no-wrap')).toBe(false) // wraps by default
    toggle.click()
    expect(body.classList.contains('no-wrap')).toBe(true)
    expect(localStorage.getItem('kd:logsWrap')).toBe('0')
    localStorage.removeItem('kd:logsWrap')
  })

  it('hides the line filter until there are log lines', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    // No lines stream from the stub, so the filter input should not be shown.
    expect(container.querySelector('.logs-filter')).toBeNull()
  })

  it('offers the previous-logs toggle only when a single pod has restarts', () => {
    const withRestarts = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={3} />)
    expect(withRestarts.container.querySelector('.logs-prev')).toBeTruthy()
    cleanup()
    const noRestarts = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(noRestarts.container.querySelector('.logs-prev')).toBeNull()
  })

  // A Pod that isn't Running yet can't produce logs, so a stream "error" there is a benign
  // "not started" — say "no logs yet" calmly, not the alarming "stream interrupted" that a Running
  // pod's actual stream drop warrants.
  it('shows "no logs yet" when the stream errors on a non-Running pod', async () => {
    const { findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Pending" />
    ))
    eventSources[0].onerror?.()
    await findByText('no logs yet')
  })

  it('shows "stream interrupted" when the stream errors on a Running pod', async () => {
    const { findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    eventSources[0].onerror?.()
    await findByText('stream interrupted')
  })

  it('Latest button advertises unseen line count while scrolled up (cycle 266)', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    // First line: the viewer is still "pinned" (default true), so no badge.
    es.emit('log', { line: 'first' })
    await findByText('first')
    expect(container.querySelector('.logs-jump')).toBeNull()
    // Force "unpinned" by faking a scroll event after positioning above the bottom. The viewer's
    // toBottom() also assigns scrollTop on incoming lines, so define it writable.
    const pre = container.querySelector('pre.logs-body') as HTMLElement
    Object.defineProperty(pre, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(pre, 'scrollTop', { value: 100, configurable: true, writable: true })
    Object.defineProperty(pre, 'clientHeight', { value: 200, configurable: true })
    pre.dispatchEvent(new Event('scroll'))
    // Three lines arrive while scrolled up → Latest button shows the count.
    es.emit('log', { line: 'a' })
    es.emit('log', { line: 'b' })
    es.emit('log', { line: 'c' })
    await findByText('↓ Latest', { exact: false })
    expect(container.querySelector('.logs-jump-count')?.textContent).toBe('3')
  })

  it('highlights filter matches with <mark> inside the kept lines (cycle 249)', async () => {
    const { container, findByPlaceholderText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    eventSources[0].emit('log', { line: 'ERROR connect to db ConneCT again' })
    // The filter input only appears once at least one line is in. findByPlaceholderText waits for it.
    const filter = (await findByPlaceholderText(/filter…/)) as HTMLInputElement
    filter.value = 'connect'
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    // Both "connect" and "ConneCT" hit the case-insensitive query.
    expect(container.querySelectorAll('.log-match').length).toBe(2)
    const texts = [...container.querySelectorAll('.log-match')].map((e) => e.textContent)
    expect(texts).toEqual(['connect', 'ConneCT'])
  })
})
