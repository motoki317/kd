import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
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
  // LogViewer persists triage prefs (kd:logsWrap, kd:logsHideLevels); clear so a test that toggles
  // them (e.g. hiding every level) can't leak that state into the next test's filtered line set.
  localStorage.clear()
})

const base = { namespace: 'shop', kind: 'Pod', name: 'web-1' }

describe('LogViewer', () => {
  it('offers a container picker only for a single multi-container pod, defaulting to All containers', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app', 'sidecar']} restarts={0} />)
    const select = container.querySelector('.logs-container') as HTMLSelectElement
    expect(select).toBeTruthy()
    // "All containers" (the merged default) sits first, ahead of the two app containers.
    const opts = [...select.querySelectorAll('option')].map((o) => o.textContent)
    expect(opts).toEqual(['All containers', 'app', 'sidecar'])
    expect(select.value).toBe('__all__')
  })

  it('turns "waiting for log output…" into a terminal notice when the tailed resource is deleted', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('waiting for log output')
    eventSources.at(-1)!.emit('gone', {})
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('log stream ended — the resource was deleted')
    // A same-name re-create resumes streaming: a new line supersedes the stale notice.
    eventSources.at(-1)!.emit('log', { pod: 'web-1', line: 'back from the dead' })
    expect(container.querySelector('.logs-waiting')).toBeNull()
    expect(container.textContent).toContain('back from the dead')
    // Deleted again with lines on screen: the end-of-stream marker renders at the tail (the
    // empty-state text only covers the nothing-arrived case).
    eventSources.at(-1)!.emit('gone', {})
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('log stream ended')
    expect(container.textContent).toContain('back from the dead') // lines stay
  })

  it('hides the picker for a single-container pod and for aggregated logs', () => {
    const single = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(single.container.querySelector('.logs-container')).toBeNull()
    const agg = render(() => <LogViewer ctx="test-ctx" namespace="shop" kind="Deployment" name="web" aggregated={true} containers={['app', 'sidecar']} restarts={0} />)
    expect(agg.container.querySelector('.logs-container')).toBeNull()
  })

  it('lists init containers in their own optgroup so a failed init container’s logs are reachable', () => {
    const { container } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} initContainers={['init-fs', 'init-migrate']} restarts={0} />
    ))
    const select = container.querySelector('.logs-container')
    expect(select).toBeTruthy() // 1 app + 2 init = 3 → picker shows even with a single app container
    const groups = [...select!.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups).toEqual(['Init containers', 'App containers'])
    const initOpts = [...select!.querySelectorAll('optgroup[label="Init containers"] option')].map((o) => o.textContent)
    expect(initOpts).toEqual(['init-fs', 'init-migrate'])
  })

  it('keeps the picker a flat list (no optgroups) when a pod has no init containers', () => {
    const { container } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app', 'sidecar']} initContainers={[]} restarts={0} />
    ))
    const select = container.querySelector('.logs-container')!
    expect(select.querySelectorAll('optgroup').length).toBe(0)
    // "All containers" + the two app containers, flat (no init containers to split out).
    expect(select.querySelectorAll('option').length).toBe(3)
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
    // The button reads as pressed/active WHEN wrapping is on — it is labelled "wrap", so its lit state
    // must mean "wrapping", not the inverse (the flipped-state bug).
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(toggle.classList.contains('active')).toBe(true)
    toggle.click()
    expect(body.classList.contains('no-wrap')).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('false') // off → not wrapping
    expect(localStorage.getItem('kd:logsWrap')).toBe('0')
    localStorage.removeItem('kd:logsWrap')
  })

  // The full-screen control (expands the drawer to fill the canvas) lives in the logs toolbar, next to
  // the logs it grows — driving the SAME expanded state as the drawer-header expand button. It only
  // renders when the parent wires onToggleExpand, and its label/aria flip with the expanded prop.
  it('offers a full-screen control wired to onToggleExpand, reflecting the expanded state', () => {
    const [expanded, setExpanded] = createSignal(false)
    const { container } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} expanded={expanded()} onToggleExpand={() => setExpanded((v) => !v)} />
    ))
    const btn = container.querySelector('.logs-fullscreen') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('full screen')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    btn.click()
    // When expanded, the same control reads as "restore" (label + pressed state) — surgically, the
    // signal drives it without remounting.
    expect(btn.textContent).toContain('restore')
    expect(btn.getAttribute('aria-pressed')).toBe('true')
  })

  it('omits the full-screen control when no onToggleExpand is wired', () => {
    const { container } = render(() => <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} />)
    expect(container.querySelector('.logs-fullscreen')).toBeNull()
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

  // The `previous` dump is one-shot: the server emits `done` when finished. A crashed container that
  // wrote nothing before exiting yields a finished-but-empty dump — the CrashLoop triage path — which
  // must read as a terminal "no previous logs" state, not an indefinite "waiting…" spinner.
  it('shows "no previous logs" when a finished previous-logs dump produced nothing', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={3} status="Running" />
    ))
    // Before completion the stream is genuinely still streaming.
    expect(container.querySelector('.logs-waiting')?.textContent).toBe('waiting for log output…')
    // The server signals the one-shot dump finished with zero lines.
    eventSources[0].emit('done', {})
    await findByText('no previous logs for this container')
  })

  it('shows "stream interrupted" when the stream errors on a Running pod', async () => {
    const { findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    eventSources[0].onerror?.()
    await findByText('stream interrupted')
  })

  // A Succeeded Workflow / Complete Job whose pods were already GC'd streams nothing, forever —
  // "waiting for log output…" would have the operator waiting on logs that can never arrive.
  it('tells a finished run apart from a silent live one in the empty state', () => {
    const { container } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated containers={[]} restarts={0} status="Succeeded" />
    ))
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('this run already finished')
    cleanup()
    // A live resource keeps the genuine waiting message — its logs may still come.
    const live = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated containers={[]} restarts={0} status="Running" />
    ))
    expect(live.container.querySelector('.logs-waiting')?.textContent).toBe('waiting for log output…')
  })

  // The mirror of the finished-run case: a CronJob/CronWorkflow that never fired has no pods to
  // tail until its first scheduled run — "waiting…" implied logs were imminent.
  it('tells a never-run scheduled resource apart from a silent live one', () => {
    const { container } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated containers={[]} restarts={0} status="30 3 * * *" neverRan />
    ))
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('has not run yet')
  })

  it('names the hidden-line count and offers a reset when a filter hides every line', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    // Before any line arrives: genuinely waiting.
    expect(container.querySelector('.logs-waiting')?.textContent).toBe('waiting for log output…')
    // Two klog INFO lines (parse as INF) stream in.
    const es = eventSources[0]
    es.emit('log', { line: 'I0521 12:00:00.000000 1 main.go:1] starting' })
    es.emit('log', { line: 'I0521 12:00:01.000000 1 main.go:2] ready' })
    await findByText('starting', { exact: false })
    // Toggle off every level chip → all lines hidden by the LEVEL filter (no text filter active).
    const levelBtns = [...container.querySelectorAll('.logs-levels button')] as HTMLButtonElement[]
    levelBtns.forEach((b) => {
      if (b.getAttribute('aria-pressed') === 'true') b.click()
    })
    // The empty state must NOT read "waiting" (implying silence) — it names the count so the operator
    // knows lines exist and are merely hidden (a persisted level filter is the common cause).
    expect(container.querySelector('.logs-waiting')?.textContent).toContain('all 2 lines hidden by the active filters')
    // ...and a "show all" reset restores them in one click.
    const reset = container.querySelector('.logs-clear-filters') as HTMLButtonElement
    expect(reset).toBeTruthy()
    reset.click()
    expect(container.querySelectorAll('.log-line').length).toBe(2)
    expect(container.querySelector('.logs-waiting')).toBeNull()
  })

  it('defaults a multi-container pod to a merged view, labelling and timestamp-ordering by container', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app', 'sidecar']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    // Container tail dumps arrive grouped (all of sidecar, then app) and out of time order; the merged
    // view must interleave them by emission time, and label each line with its source container.
    es.emit('log', { container: 'sidecar', time: '2021-05-21T12:00:02Z', line: 'proxy up' })
    es.emit('log', { container: 'app', time: '2021-05-21T12:00:01Z', line: 'app boot' })
    es.emit('log', { container: 'app', time: '2021-05-21T12:00:03Z', line: 'app ready' })
    await findByText('app boot', { exact: false })
    const lines = [...container.querySelectorAll('.log-line')]
    // Ordered by time (app boot @01, proxy up @02, app ready @03), not arrival order.
    expect(lines.map((l) => l.textContent?.match(/app boot|proxy up|app ready/)?.[0])).toEqual([
      'app boot',
      'proxy up',
      'app ready',
    ])
    // Each line carries its container as the source label.
    const labels = lines.map((l) => l.querySelector('.log-pod')?.textContent)
    expect(labels).toEqual(['app', 'sidecar', 'app'])
    // A per-container filter chip row appears (one chip per container present).
    const chips = [...container.querySelectorAll('.logs-pod-chip')].map((c) => c.textContent)
    expect(chips.sort()).toEqual(['app', 'sidecar'])
    // The time-ordered merge is illegible without visible stamps, so combined mode defaults the time
    // column ON (toggle reflects it) — every line shows its time, the anchor explaining the interleave.
    expect(container.querySelector('.logs-ts')?.getAttribute('aria-pressed')).toBe('true')
    expect(lines.every((l) => l.querySelector('.log-time'))).toBe(true)
  })

  it('lets the operator turn the combined-mode timestamps back off', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app', 'sidecar']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { container: 'app', time: '2021-05-21T12:00:01Z', line: 'app boot' })
    await findByText('app boot', { exact: false })
    const toggle = container.querySelector('.logs-ts') as HTMLButtonElement
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('.log-time')).toBeNull()
  })

  it('shows the shown/total count for a level filter, not only a text filter', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { line: 'E0521 12:00:00.000000 1 main.go:1] boom' }) // parses as error
    es.emit('log', { line: 'I0521 12:00:01.000000 1 main.go:2] ready' }) // parses as info
    await findByText('boom', { exact: false })
    // No filter yet → no count readout (the whole buffer is shown).
    expect(container.querySelector('.logs-count')).toBeNull()
    // Hide INFO via its chip — no text filter involved. The count must still surface so the operator
    // sees 1 of 2 lines remain (previously the readout was gated on the text filter alone).
    const infoChip = [...container.querySelectorAll('.logs-levels button')].find((b) => b.textContent === 'INF') as HTMLButtonElement
    infoChip.click()
    expect(container.querySelector('.logs-count')?.textContent).toBe('1/2')
  })

  it('renders a JSON log line message-first with the extras dimmed; plain lines stay raw', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { line: '{"@timestamp":"2026-06-05T13:57:56.364Z","log.level":"INFO","message":"node started","node":"es-0"}' })
    es.emit('log', { line: 'plain stdout line, not json' })
    await findByText('node started', { exact: false })
    // The JSON line leads with its message (.log-msg, normal foreground) and trails the rest dimmed
    // (.log-json-extra). @timestamp + log.level are dropped from extras — the badge/time column show them.
    const msg = container.querySelector('.log-msg')
    expect(msg?.textContent).toBe('node started')
    expect(container.querySelector('.log-json-extra')?.textContent?.trim()).toBe('node=es-0')
    // The embedded log.level still drives the colored badge.
    expect(msg?.closest('.log-line')?.querySelector('.log-level-info')).toBeTruthy()
    // The plain line is untouched — no message/extras wrappers, so non-JSON rendering is unchanged.
    const plain = [...container.querySelectorAll('.log-line')].find((l) => /plain stdout/.test(l.textContent || ''))
    expect(plain?.querySelector('.log-msg')).toBeNull()
  })

  it('gives the "Aa" case toggle a worded accessible name (not just the glyph)', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { line: 'hello' }) // the case toggle only renders once there are lines
    await findByText('hello', { exact: false })
    const caseBtn = container.querySelector('.logs-case') as HTMLButtonElement
    expect(caseBtn).toBeTruthy()
    expect(caseBtn.textContent).toBe('Aa') // visual stays the compact glyph
    // ...but a screen reader hears a real name, not "Aa", matching the worded sibling chips.
    expect(caseBtn.getAttribute('aria-label')).toBe('Match case')
    expect(caseBtn.getAttribute('aria-pressed')).toBe('false')
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

  // Aggregated workload streams interleave several pods; per-pod chips let an operator isolate one
  // replica without typing its pod-hash into the filter (cycle 329). Single-pod views have no chips.
  it('offers per-pod toggles for an aggregated stream and hides a pod when clicked', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" namespace="shop" kind="Deployment" name="web" aggregated={true} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { pod: 'web-aaa', line: 'from aaa' })
    es.emit('log', { pod: 'web-bbb', line: 'from bbb' })
    await findByText('from aaa')
    await findByText('from bbb')
    const chips = [...container.querySelectorAll('.logs-pod-chip')] as HTMLButtonElement[]
    expect(chips.length).toBe(2)
    const aaa = chips.find((c) => c.textContent?.includes('web-aaa'))!
    aaa.click()
    const body = container.querySelector('pre.logs-body')!
    expect(body.textContent).not.toContain('from aaa')
    expect(body.textContent).toContain('from bbb')
    expect(aaa.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows no per-pod chips for a single-pod (non-aggregated) stream', async () => {
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    eventSources[0].emit('log', { pod: 'web-1', line: 'solo line' })
    await findByText('solo line')
    expect(container.querySelectorAll('.logs-pod-chip').length).toBe(0)
  })

  // Jump-to-error (cycle 333/R6): the button appears only when the buffer holds error-level lines,
  // and clicking it flashes the next error line (stepping through them).
  it('offers a jump-to-error control only when error lines exist, and flashes the target', async () => {
    Element.prototype.scrollIntoView = vi.fn() // jsdom has no layout; stub the scroll
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { line: 'I0521 1 main.go:1] starting up' })
    await findByText(/starting up/)
    expect(container.querySelector('.logs-errjump')).toBeNull() // no errors → no control
    es.emit('log', { line: 'E0521 1 main.go:2] first boom' })
    es.emit('log', { line: 'E0521 1 main.go:3] second crash' })
    await findByText(/second crash/)
    const btn = container.querySelector('.logs-errjump') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('2') // two error lines
    const lineWith = (t: string) => [...container.querySelectorAll('.log-line')].find((l) => l.textContent?.includes(t))!
    btn.click()
    // First click lands on the first error and flashes that line. (In jsdom the class lingers since
    // animationend never fires; in the browser it clears after the 1.2s animation — so assert the
    // specific target carries the flash rather than counting flashed lines.)
    expect(lineWith('first boom').classList.contains('log-line-flash')).toBe(true)
    expect(lineWith('starting up').classList.contains('log-line-flash')).toBe(false)
    btn.click() // steps to the second error
    expect(lineWith('second crash').classList.contains('log-line-flash')).toBe(true)
  })

  it('tags each line with its detected level class — the hook the severity left-accent styles', async () => {
    // The error/warn left-edge accent (index.css `.log-line:has(> .log-level-error)`) relies on the
    // per-line level badge class. Lock that contract so a badge-class rename can't silently drop the
    // accent: an error line carries .log-level-error, an info line .log-level-info and never -error.
    const { container, findByText } = render(() => (
      <LogViewer ctx="test-ctx" {...base} aggregated={false} containers={['app']} restarts={0} status="Running" />
    ))
    const es = eventSources[0]
    es.emit('log', { line: 'I0521 1 main.go:1] all good' })
    es.emit('log', { line: 'E0521 1 main.go:2] boom' })
    await findByText(/boom/)
    const lineWith = (t: string) => [...container.querySelectorAll('.log-line')].find((l) => l.textContent?.includes(t))!
    expect(lineWith('boom').querySelector('.log-level-error')).toBeTruthy()
    expect(lineWith('all good').querySelector('.log-level-info')).toBeTruthy()
    expect(lineWith('all good').querySelector('.log-level-error')).toBeNull()
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
