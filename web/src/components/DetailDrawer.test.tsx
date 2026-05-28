import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import DetailDrawer from './DetailDrawer'
import type { KNode } from '../types'

// A loggable resource mounts LogViewer, which opens an EventSource on mount; a no-op stub keeps it
// from touching the network.
class NoopEventSource {
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}

// Stub the network so the manifest/events resources resolve without a server.
beforeEach(() => {
  vi.stubGlobal('EventSource', NoopEventSource)
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve(
      url.includes('/events')
        ? new Response(JSON.stringify({ events: [] }), { status: 200 })
        : new Response('kind: ConfigMap\nmetadata:\n  name: settings\n', { status: 200 }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const configMap: KNode = {
  id: 'cm1',
  kind: 'ConfigMap',
  name: 'settings',
  namespace: 'shop',
  health: 'Healthy',
  createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
}

describe('DetailDrawer', () => {
  it('shows Events/Manifest tabs (no Logs) for a non-loggable resource', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const tabs = [...container.querySelectorAll('.drawer-tabs button')].map((b) => b.textContent?.trim())
    expect(tabs).toEqual(['Events', 'Manifest'])
  })

  it('[ and ] cycle the drawer tabs (cycle 292)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    // ConfigMap is not loggable: tabs = [Events, Manifest]; non-loggable resources default to
    // Manifest (line 106 in DetailDrawer.tsx).
    const active = () => container.querySelector('.drawer-tabs button.active')?.textContent?.trim()
    expect(active()).toBe('Manifest')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
    expect(active()).toBe('Events') // wraps forward
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))
    expect(active()).toBe('Manifest')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }))
    expect(active()).toBe('Events') // backward
  })

  it('[ / ] do nothing when no node is shown (cycle 292)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={null} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    // Should be empty — no drawer rendered.
    expect(container.querySelector('.drawer-tabs')).toBeFalsy()
    // Dispatching keydown should not throw.
    expect(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }))).not.toThrow()
  })

  it('renders labels as key/value chips, sorted by key', () => {
    const labeled: KNode = { ...configMap, labels: { tier: 'backend', app: 'shop' } }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={labeled} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const keys = [...container.querySelectorAll('.label-chip .label-key')].map((e) => e.textContent)
    const vals = [...container.querySelectorAll('.label-chip .label-val')].map((e) => e.textContent)
    expect(keys).toEqual(['app', 'tier'])
    expect(vals).toEqual(['shop', 'backend'])
  })

  it('shows node capacity in the meta line when present', () => {
    const node: KNode = { id: 'n1', kind: 'Node', name: 'worker-1', health: 'Healthy', capacity: '8 vCPU · 16Gi · 110 pods' }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={node} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-meta')?.textContent).toContain('8 vCPU · 16Gi · 110 pods')
  })

  it('offers a copy-name button in the header (cycle 287: title also documents Shift+click for Kind/name)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const btn = container.querySelector('.drawer-name .copy-btn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('title')).toMatch(/^Copy name/)
    expect(btn.getAttribute('title')).toMatch(/Shift\+click for Kind\/name/)
  })

  it('label chip click copies key=value; Shift+click copies value only (cycle 282)', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (s: string) => { writes.push(s); return Promise.resolve() } },
    })
    const labeled: KNode = { ...configMap, labels: { app: 'shop', version: 'v1.2.3' } }
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx" node={labeled} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const chips = [...container.querySelectorAll('.label-chip')] as HTMLButtonElement[]
    expect(chips.length).toBe(2)
    // Plain click on the 'app' chip copies "app=shop".
    chips[0].click()
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['app=shop'])
    // Shift+click on the 'version' chip copies just "v1.2.3".
    chips[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual(['app=shop', 'v1.2.3'])
  })

  it('share button copies window.location.href to the clipboard (cycle 275)', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (s: string) => { writes.push(s); return Promise.resolve() } },
    })
    const { getByTitle } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const btn = getByTitle('Copy share link') as HTMLButtonElement
    btn.click()
    // Two microtask cycles: writeText resolves, then the .copied class is added in the await
    // continuation. A second await ensures both have flushed before the assertion runs.
    await Promise.resolve()
    await Promise.resolve()
    expect(writes).toEqual([window.location.href])
    expect(btn.classList.contains('copied')).toBe(true)
  })

  it('renders per-container status rows with names and states', () => {
    const pod: KNode = {
      ...configMap,
      kind: 'Pod',
      containerStatuses: [
        { name: 'app', ready: true, state: 'Running' },
        { name: 'sidecar', ready: false, restarts: 4, state: 'Waiting: CrashLoopBackOff' },
      ],
    }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const names = [...container.querySelectorAll('.container-row .container-name')].map((e) => e.textContent)
    const states = [...container.querySelectorAll('.container-row .container-state')].map((e) => e.textContent)
    expect(names).toEqual(['app', 'sidecar'])
    expect(states).toEqual(['Running', 'Waiting: CrashLoopBackOff'])
    expect(container.querySelector('.container-restarts')?.textContent).toContain('4')
  })

  it('init containers come before main containers (cycle 274)', () => {
    const pod: KNode = {
      ...configMap,
      kind: 'Pod',
      // Server-side order interleaves init + main; the drawer should re-group so init comes first.
      containerStatuses: [
        { name: 'app', ready: true, state: 'Running' },
        { name: 'wait-for-db', ready: true, state: 'Terminated: Completed', init: true },
        { name: 'sidecar', ready: true, state: 'Running' },
        { name: 'migrate', ready: true, state: 'Terminated: Completed', init: true },
      ],
    }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const names = [...container.querySelectorAll('.container-row .container-name')].map((e) => e.textContent?.trim().replace(/\s+init$/, ''))
    expect(names).toEqual(['wait-for-db', 'migrate', 'app', 'sidecar'])
  })

  it('renders each container image', () => {
    const workload: KNode = { ...configMap, kind: 'Deployment', images: ['nginx:1.25', 'envoy:1.29'] }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={workload} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const imgs = [...container.querySelectorAll('.drawer-image code')].map((e) => e.textContent)
    expect(imgs).toEqual(['nginx:1.25', 'envoy:1.29'])
  })

  it('omits the labels section when there are none', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-labels')).toBeNull()
  })

  it("shows a load error (not 'no events') when the events fetch fails, without crashing", async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response('boom', { status: 500 })
          : new Response('kind: ConfigMap\n', { status: 200 }),
      ),
    )
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText("Couldn't load events.")
    // The drawer itself still rendered (a thrown resource error would have torn it down).
    expect(container.querySelector('.drawer')).toBeTruthy()
  })

  it('shows "unavailable" when the manifest fetch fails, without crashing', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(JSON.stringify({ events: [] }), { status: 200 })
          : new Response('nope', { status: 500 }),
      ),
    )
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText('unavailable')
    expect(container.querySelector('.drawer')).toBeTruthy()
  })

  it('keeps the active tab across selections when the new resource has it', () => {
    const podA: KNode = { id: 'pa', kind: 'Pod', name: 'pod-a', namespace: 'shop', health: 'Healthy' }
    const podB: KNode = { id: 'pb', kind: 'Pod', name: 'pod-b', namespace: 'shop', health: 'Healthy' }
    const [node, setNode] = createSignal<KNode>(podA)
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const tabBtn = (label: string) =>
      [...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement
    const activeTab = () => container.querySelector('.drawer-tabs button.active')?.textContent?.trim()

    tabBtn('Events').click()
    expect(activeTab()).toBe('Events')
    setNode(podB) // another loggable resource that also has an Events tab
    expect(activeTab()).toBe('Events')
  })

  it('falls back to the default tab when the new resource lacks the current one', () => {
    const pod: KNode = { id: 'pa', kind: 'Pod', name: 'pod-a', namespace: 'shop', health: 'Healthy' }
    const [node, setNode] = createSignal<KNode>(pod)
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const activeTab = () => container.querySelector('.drawer-tabs button.active')?.textContent?.trim()
    // Pod defaults to Logs; switching to a non-loggable ConfigMap (no Logs tab) must fall back.
    expect(activeTab()).toBe('Logs')
    setNode(configMap)
    expect(activeTab()).toBe('Manifest')
  })

  it('renders an age and clickable owner chips', () => {
    const owner: KNode = { id: 'd1', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const navigated: string[] = []
    const { container, getByTitle } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[owner]} onNavigate={(id) => navigated.push(id)} onClose={() => {}} />
    ))
    expect(container.querySelector('.drawer-age')?.textContent).toContain('3d')
    const chip = getByTitle('Go to Deployment web')
    chip.click()
    expect(navigated).toEqual(['d1'])
  })

  it('host meta is a click-to-jump button when onNavigateRef is provided', () => {
    const pod: KNode = { ...configMap, kind: 'Pod', host: 'worker-1' }
    const refNavigated: string[] = []
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx"
        node={pod}
        owners={[]}
        onNavigate={() => {}}
        onNavigateRef={(ref) => {
          refNavigated.push(ref)
          return true
        }}
        onClose={() => {}}
      />
    ))
    const host = container.querySelector('button.drawer-host') as HTMLButtonElement | null
    expect(host).toBeTruthy()
    host!.click()
    expect(refNavigated).toEqual(['Node/worker-1'])
  })

  it('host meta is a static span when onNavigateRef is omitted (no nav available)', () => {
    const pod: KNode = { ...configMap, kind: 'Pod', host: 'worker-1' }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('button.drawer-host')).toBeNull()
    expect(container.querySelector('.drawer-meta')?.textContent).toContain('on worker-1')
  })

  it('events list offers a warnings-only toggle when there is a mix to filter', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(
              JSON.stringify({
                events: [
                  { type: 'Normal', reason: 'Pulled', message: 'image pulled', count: 1, last: new Date().toISOString() },
                  { type: 'Normal', reason: 'Created', message: 'container created', count: 1, last: new Date().toISOString() },
                  { type: 'Warning', reason: 'BackOff', message: 'crash-looping', count: 3, last: new Date().toISOString() },
                ],
              }),
              { status: 200 },
            )
          : new Response('kind: ConfigMap\n', { status: 200 }),
      ),
    )
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    ;[...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.includes('Events'))!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // Wait for events to render; expect all three reasons visible initially.
    await findByText('Pulled')
    expect(container.querySelectorAll('.event-item').length).toBe(3)
    const chip = container.querySelector('.events-filter-chip') as HTMLButtonElement
    expect(chip).toBeTruthy()
    chip.click()
    // After toggling, only the Warning event remains.
    expect(container.querySelectorAll('.event-item').length).toBe(1)
    expect(container.querySelector('.event-reason')?.textContent).toBe('BackOff')
  })

  it('omits the warnings-only chip when all events are the same type', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(
              JSON.stringify({
                events: [
                  { type: 'Normal', reason: 'Pulled', message: 'image pulled', count: 1, last: new Date().toISOString() },
                  { type: 'Normal', reason: 'Created', message: 'container created', count: 1, last: new Date().toISOString() },
                ],
              }),
              { status: 200 },
            )
          : new Response('kind: ConfigMap\n', { status: 200 }),
      ),
    )
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    ;[...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.includes('Events'))!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await findByText('Pulled')
    expect(container.querySelector('.events-filter-chip')).toBeNull()
  })

  it('manifest find highlights matches and shows a count', async () => {
    const yaml = 'kind: ConfigMap\ndata:\n  feature: true\n  feature_flag: enabled\n'
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(JSON.stringify({ events: [] }), { status: 200 })
          : new Response(yaml, { status: 200 }),
      ),
    )
    const { container, findByPlaceholderText, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    // Wait until the manifest text actually loads — find runs against detail(), so an early
    // dispatch fires before the resource resolves and reports 0 matches.
    await findByText((_t, el) => !!el?.classList.contains('manifest') && (el?.textContent ?? '').includes('feature_flag'))
    const find = (await findByPlaceholderText(/find in manifest/)) as HTMLInputElement
    find.value = 'feature'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    // Two case-insensitive hits in the body.
    expect(container.querySelectorAll('.manifest-match').length).toBe(2)
    // The count badge reads "<current>/<total>" once Enter cycling kicked in (cycle 263); fresh
    // state is index 0, i.e. "1/2".
    expect(container.querySelector('.manifest-find-count')?.textContent).toMatch(/1\/2/)
  })

  it('clicking an aggregated event source pill navigates via onNavigateRef', async () => {
    // Stub the events fetch to return an event whose source differs from the root resource —
    // i.e. an aggregated event from a descendant pod.
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(
              JSON.stringify({
                events: [
                  {
                    type: 'Warning',
                    reason: 'BackOff',
                    message: 'crash-looping',
                    count: 3,
                    last: new Date().toISOString(),
                    source: 'Pod/web-7d9f-2xkp',
                  },
                ],
              }),
              { status: 200 },
            )
          : new Response('kind: Deployment\n', { status: 200 }),
      ),
    )
    const deploy: KNode = { id: 'd1', kind: 'Deployment', name: 'web', namespace: 'shop', health: 'Degraded' }
    const refNavigated: string[] = []
    const { container, findByTitle } = render(() => (
      <DetailDrawer ctx="test-ctx"
        node={deploy}
        owners={[]}
        onNavigate={() => {}}
        onNavigateRef={(ref) => {
          refNavigated.push(ref)
          return true
        }}
        onClose={() => {}}
      />
    ))
    // The drawer opens to Logs by default for a Deployment; flip to Events to render the list.
    const tabs = [...container.querySelectorAll('.drawer-tabs button')] as HTMLButtonElement[]
    tabs.find((b) => b.textContent?.includes('Events'))!.click()
    const pill = (await findByTitle('Go to Pod/web-7d9f-2xkp')) as HTMLButtonElement
    pill.click()
    expect(refNavigated).toEqual(['Pod/web-7d9f-2xkp'])
  })
})
