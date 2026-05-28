import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogViewer from './LogViewer'

// LogViewer opens an EventSource on mount; a no-op stub keeps it from touching the network. The
// class tracks its instances so a test can fire onerror to assert how the viewer renders a stream drop.
let eventSources: NoopEventSource[] = []
class NoopEventSource {
  onerror: (() => void) | null = null
  constructor() {
    eventSources.push(this)
  }
  addEventListener() {}
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
    const { container } = render(() => <LogViewer {...base} aggregated={false} containers={['app', 'sidecar']} restarts={0} />)
    const select = container.querySelector('.logs-container')
    expect(select).toBeTruthy()
    expect(select!.querySelectorAll('option').length).toBe(2)
  })

  it('hides the picker for a single-container pod and for aggregated logs', () => {
    const single = render(() => <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(single.container.querySelector('.logs-container')).toBeNull()
    const agg = render(() => <LogViewer namespace="shop" kind="Deployment" name="web" aggregated={true} containers={['app', 'sidecar']} restarts={0} />)
    expect(agg.container.querySelector('.logs-container')).toBeNull()
  })

  it('always offers a timestamps toggle', () => {
    const { container } = render(() => <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(container.querySelector('.logs-ts')?.textContent).toContain('timestamps')
  })

  it('hides the line filter until there are log lines', () => {
    const { container } = render(() => <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} />)
    // No lines stream from the stub, so the filter input should not be shown.
    expect(container.querySelector('.logs-filter')).toBeNull()
  })

  it('offers the previous-logs toggle only when a single pod has restarts', () => {
    const withRestarts = render(() => <LogViewer {...base} aggregated={false} containers={['app']} restarts={3} />)
    expect(withRestarts.container.querySelector('.logs-prev')).toBeTruthy()
    cleanup()
    const noRestarts = render(() => <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(noRestarts.container.querySelector('.logs-prev')).toBeNull()
  })

  // A Pod that isn't Running yet can't produce logs, so a stream "error" there is a benign
  // "not started" — say "no logs yet" calmly, not the alarming "stream interrupted" that a Running
  // pod's actual stream drop warrants.
  it('shows "no logs yet" when the stream errors on a non-Running pod', async () => {
    const { findByText } = render(() => (
      <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} status="Pending" />
    ))
    eventSources[0].onerror?.()
    await findByText('no logs yet')
  })

  it('shows "stream interrupted" when the stream errors on a Running pod', async () => {
    const { findByText } = render(() => (
      <LogViewer {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    eventSources[0].onerror?.()
    await findByText('stream interrupted')
  })
})
