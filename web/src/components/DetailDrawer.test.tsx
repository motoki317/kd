import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DetailDrawer from './DetailDrawer'
import type { KNode } from '../types'

// Stub the network so the manifest/events resources resolve without a server.
beforeEach(() => {
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
