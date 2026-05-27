import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    const { container } = render(() => <DetailDrawer node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const tabs = [...container.querySelectorAll('.drawer-tabs button')].map((b) => b.textContent?.trim())
    expect(tabs).toEqual(['Events', 'Manifest'])
  })

  it('renders labels as key/value chips, sorted by key', () => {
    const labeled: KNode = { ...configMap, labels: { tier: 'backend', app: 'shop' } }
    const { container } = render(() => <DetailDrawer node={labeled} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const keys = [...container.querySelectorAll('.label-chip .label-key')].map((e) => e.textContent)
    const vals = [...container.querySelectorAll('.label-chip .label-val')].map((e) => e.textContent)
    expect(keys).toEqual(['app', 'tier'])
    expect(vals).toEqual(['shop', 'backend'])
  })

  it('shows node capacity in the meta line when present', () => {
    const node: KNode = { id: 'n1', kind: 'Node', name: 'worker-1', health: 'Healthy', capacity: '8 vCPU · 16Gi · 110 pods' }
    const { container } = render(() => <DetailDrawer node={node} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-meta')?.textContent).toContain('8 vCPU · 16Gi · 110 pods')
  })

  it('offers a copy-name button in the header', () => {
    const { getByTitle } = render(() => <DetailDrawer node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(getByTitle('Copy name')).toBeTruthy()
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
    const { container } = render(() => <DetailDrawer node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const names = [...container.querySelectorAll('.container-row .container-name')].map((e) => e.textContent)
    const states = [...container.querySelectorAll('.container-row .container-state')].map((e) => e.textContent)
    expect(names).toEqual(['app', 'sidecar'])
    expect(states).toEqual(['Running', 'Waiting: CrashLoopBackOff'])
    expect(container.querySelector('.container-restarts')?.textContent).toContain('4')
  })

  it('renders each container image', () => {
    const workload: KNode = { ...configMap, kind: 'Deployment', images: ['nginx:1.25', 'envoy:1.29'] }
    const { container } = render(() => <DetailDrawer node={workload} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const imgs = [...container.querySelectorAll('.drawer-image code')].map((e) => e.textContent)
    expect(imgs).toEqual(['nginx:1.25', 'envoy:1.29'])
  })

  it('omits the labels section when there are none', () => {
    const { container } = render(() => <DetailDrawer node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
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
      <DetailDrawer node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText("Couldn't load events.")
    // The drawer itself still rendered (a thrown resource error would have torn it down).
    expect(container.querySelector('.drawer')).toBeTruthy()
  })

  it('renders an age and clickable owner chips', () => {
    const owner: KNode = { id: 'd1', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const navigated: string[] = []
    const { container, getByTitle } = render(() => (
      <DetailDrawer node={configMap} owners={[owner]} onNavigate={(id) => navigated.push(id)} onClose={() => {}} />
    ))
    expect(container.querySelector('.drawer-age')?.textContent).toContain('3d')
    const chip = getByTitle('Go to Deployment web')
    chip.click()
    expect(navigated).toEqual(['d1'])
  })
})
