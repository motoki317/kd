import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal, Suspense } from 'solid-js'
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
  // 3 days + a margin: ages off the shared app clock (captured at import, a hair before render), so an
  // exactly-3-day fixture could tip to "2d". The margin keeps it unambiguously in the "3d" bucket.
  createdAt: new Date(Date.now() - (3 * 86400_000 + 3600_000)).toISOString(),
}

describe('DetailDrawer', () => {
  it('deleted: stays open on the last-known node with an explicit banner; absent otherwise', () => {
    // The inspected resource vanished mid-investigation (rollout replaced the pod): the drawer
    // must NOT silently close — it shows a terminal banner over the last-known facts, announced
    // via a live region, and the owner chips stay as the path to the replacement.
    const owner: KNode = { id: 'rs1', kind: 'ReplicaSet', name: 'web-abc', health: 'Healthy' }
    const deleted = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} deleted={true} owners={[owner]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const banner = deleted.container.querySelector('.drawer-deleted')
    expect(banner?.textContent).toContain('Deleted from the cluster')
    expect(banner?.textContent).toContain('owner chip') // owner present → points at the replacement path
    expect(banner?.getAttribute('aria-live')).toBe('polite')
    expect(deleted.container.querySelector('.drawer-name')?.textContent).toContain('settings')
    deleted.unmount()
    const live = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} deleted={false} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    expect(live.container.querySelector('.drawer-deleted')).toBeNull()
  })

  it('keeps the drawer visible while events are still loading (events read must not suspend the OUTER boundary)', async () => {
    // App wraps the whole drawer in <Suspense>. The events tab badge sits ABOVE the events panel's
    // own Suspense, so a suspending events() read there re-suspends the OUTER boundary — and the 8s
    // poll re-runs it, detaching/re-inserting the drawer's DOM and replaying its slide-in animation
    // (the reported "drawer re-opens every few seconds" flicker). Hold the events fetch pending and
    // resolve the manifest: the drawer must still be on screen, the events suspense contained to the
    // panel's own boundary. Before the fix the outer boundary stayed stuck on the never-resolving
    // events read and the drawer never rendered.
    vi.stubGlobal('fetch', (url: string) =>
      url.includes('/events')
        ? new Promise<Response>(() => {}) // never resolves
        : Promise.resolve(new Response('kind: ConfigMap\n', { status: 200 })),
    )
    const { container } = render(() => (
      <Suspense fallback={<div class="outer-fallback" />}>
        <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
      </Suspense>
    ))
    // The manifest resolves and the outer boundary settles; events stay pending throughout.
    await vi.waitFor(() => expect(container.querySelector('aside.drawer')).toBeTruthy())
    expect(container.querySelector('.outer-fallback')).toBeNull()
    expect(container.querySelector('.drawer-name')?.textContent).toContain('settings')
  })

  it('shows Events/Manifest tabs (no Logs) for a non-loggable resource', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const tabs = [...container.querySelectorAll('.drawer-tabs button')].map((b) => b.textContent?.trim())
    expect(tabs).toEqual(['Events', 'Manifest'])
  })

  it('names the complementary landmark by the resource so it is identifiable in a landmark list', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const aside = container.querySelector('aside.drawer')!
    expect(aside.getAttribute('aria-label')).toBe('ConfigMap settings details')
  })

  it('exposes the tabs as a WAI-ARIA tablist with associated panels and roving tabindex', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const list = container.querySelector('.drawer-tabs')!
    expect(list.getAttribute('role')).toBe('tablist')
    const tabBtns = [...container.querySelectorAll('.drawer-tabs button')] as HTMLButtonElement[]
    expect(tabBtns.every((b) => b.getAttribute('role') === 'tab')).toBe(true)
    // ConfigMap defaults to Manifest. The selected tab is the sole tab stop (tabindex 0); the rest
    // are -1 so Tab doesn't land on every tab (roving), and aria-selected mirrors the active state.
    const manifest = tabBtns.find((b) => b.textContent?.trim() === 'Manifest')!
    const events = tabBtns.find((b) => b.textContent?.trim() === 'Events')!
    expect(manifest.getAttribute('aria-selected')).toBe('true')
    expect(events.getAttribute('aria-selected')).toBe('false')
    expect(manifest.tabIndex).toBe(0)
    expect(events.tabIndex).toBe(-1)
    // Each tab points at its panel, and the panel points back — so a screen reader pairs them.
    const panel = container.querySelector(`#${manifest.getAttribute('aria-controls')}`)!
    expect(panel.getAttribute('role')).toBe('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(manifest.id)
  })

  it('arrow keys move between tabs within the tablist (APG keyboard model)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const list = container.querySelector('.drawer-tabs')!
    const active = () => container.querySelector('.drawer-tabs button.active')?.textContent?.trim()
    expect(active()).toBe('Manifest') // tabs = [Events, Manifest], non-loggable defaults to Manifest
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(active()).toBe('Events') // wraps forward past the end
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(active()).toBe('Manifest') // wraps backward
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(active()).toBe('Events') // first
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(active()).toBe('Manifest') // last
  })

  it('renders a back button only when canBack is true and routes its click to onBack (cycle 300)', async () => {
    // Without canBack, no back button is rendered.
    const { container, unmount } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    expect(container.querySelector('.drawer-back')).toBeFalsy()
    unmount()
    // With canBack=true and an onBack callback, the button is rendered and clicking calls onBack.
    const onBack = vi.fn()
    const { container: c2 } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} canBack={true} onBack={onBack} />
    ))
    const btn = c2.querySelector('.drawer-back') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('opens a loggable resource on the Logs tab on a fresh open (was latching to Manifest, cycle 312)', async () => {
    const pod: KNode = { id: 'p1', kind: 'Pod', name: 'web-abc', namespace: 'shop', health: 'Healthy', containers: ['web'] }
    const [node, setNode] = createSignal<KNode | null>(null)
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    // The drawer mounts empty; the tab-default effect must not latch onto Manifest.
    expect(container.querySelector('.drawer-tabs')).toBeFalsy()
    // Open the Pod from a closed state → Logs, not Manifest.
    setNode(pod)
    await Promise.resolve()
    expect(container.querySelector('.drawer-tabs button.active')?.textContent?.trim()).toBe('Logs')
  })

  it('preserves the active tab when navigating between resources while open (cycle 312)', async () => {
    const podA: KNode = { id: 'a', kind: 'Pod', name: 'a', namespace: 'shop', health: 'Healthy', containers: ['c'] }
    const podB: KNode = { id: 'b', kind: 'Pod', name: 'b', namespace: 'shop', health: 'Healthy', containers: ['c'] }
    const [node, setNode] = createSignal<KNode | null>(podA)
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const active = () => container.querySelector('.drawer-tabs button.active')?.textContent?.trim()
    // Fresh open of a Pod defaults to Logs.
    expect(active()).toBe('Logs')
    // Operator switches to Manifest, then clicks an owner chip to a different resource.
    const manifestTab = [...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.trim() === 'Manifest') as HTMLButtonElement
    manifestTab.click()
    expect(active()).toBe('Manifest')
    setNode(podB)
    await Promise.resolve()
    // Navigation (drawer stayed open) keeps the operator's chosen tab.
    expect(active()).toBe('Manifest')
  })

  it('toggles an expanded (canvas-filling) mode via the expand button (cycle 311)', () => {
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const drawer = container.querySelector('.drawer') as HTMLElement
    const btn = container.querySelector('.drawer-expand') as HTMLButtonElement
    expect(btn).toBeTruthy()
    // Starts compact.
    expect(drawer.classList.contains('expanded')).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    // Click expands.
    btn.click()
    expect(drawer.classList.contains('expanded')).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    // Click again restores.
    btn.click()
    expect(drawer.classList.contains('expanded')).toBe(false)
  })

  it('offers a left-edge resize handle only when resizing is wired and the panel is compact', () => {
    // No resize props → no handle (callers/tests that don't wire resizing).
    const bare = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(bare.container.querySelector('.drawer-resizer')).toBeNull()
    bare.unmount()

    const calls: { to: number[]; resets: number } = { to: [], resets: 0 }
    const { container } = render(() => (
      <DetailDrawer
        ctx="test-ctx"
        node={configMap}
        owners={[]}
        onNavigate={() => {}}
        onClose={() => {}}
        resizeWidth={520}
        resizeMin={360}
        resizeMax={760}
        onResizeStart={() => {}}
        onResizeTo={(w) => calls.to.push(w)}
        onResizeReset={() => (calls.resets += 1)}
      />
    ))
    const handle = container.querySelector('.drawer-resizer') as HTMLElement
    expect(handle).toBeTruthy()
    expect(handle.getAttribute('role')).toBe('separator')
    expect(handle.getAttribute('aria-valuenow')).toBe('520')
    expect(handle.getAttribute('aria-valuemin')).toBe('360')
    expect(handle.getAttribute('aria-valuemax')).toBe('760')
    // Handle is on the LEFT edge → ← widens, → narrows; Home/End jump to min/max (each computed from
    // the static 520 prop, since App — not the component — owns the width signal).
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(calls.to).toEqual([528, 512, 360, 760])
    // Double-click resets to the default width.
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(calls.resets).toBe(1)
    // Expanding the panel hides the handle — it fills the canvas, so there's no edge to drag.
    ;(container.querySelector('.drawer-expand') as HTMLButtonElement).click()
    expect(container.querySelector('.drawer-resizer')).toBeNull()
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

  it('echoes the card status string under the name, health-coloured for a troubled resource', () => {
    const es: KNode = { id: 'es1', kind: 'Elasticsearch', name: 'shop', namespace: 'shop', health: 'Progressing', status: 'Ready · yellow' }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={es} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const s = container.querySelector('.drawer-status') as HTMLElement
    expect(s).toBeTruthy()
    expect(s.textContent).toBe('Ready · yellow')
    // Troubled → health-coloured (contrast), mirroring the card's status text — in the darker TEXT
    // ink, since the vivid hue fails the light theme's 4.5:1 bar at this size (healthTextColor).
    expect(s.style.color).toBe('var(--progressing-text)')
  })

  it('keeps a Healthy status quiet (dim, not green) so the eye lands on trouble', () => {
    const pod: KNode = { id: 'p1', kind: 'Pod', name: 'web', namespace: 'shop', health: 'Healthy', status: 'Running' }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const s = container.querySelector('.drawer-status') as HTMLElement
    expect(s.textContent).toBe('Running')
    expect(s.style.color).toBe('var(--text-dim)')
  })

  it('omits the status line when a resource has no status (e.g. a ConfigMap)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-status')).toBeNull()
  })

  it('surfaces an unhealthy resource’s failure message, full text in the title for hover', () => {
    const msg = '0/3 nodes are available: 3 Insufficient cpu.'
    const pod: KNode = { id: 'p1', kind: 'Pod', name: 'web', namespace: 'shop', health: 'Progressing', status: 'Unschedulable', message: msg }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const m = container.querySelector('.drawer-message') as HTMLElement
    expect(m).toBeTruthy()
    expect(m.textContent).toBe(msg)
    expect(m.getAttribute('title')).toBe(msg) // full text on hover even when CSS clamps the display
  })

  it('omits the message block when a resource has none (the healthy/common case)', () => {
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-message')).toBeNull()
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
    const names = [...container.querySelectorAll('.container-card .container-name')].map((e) => e.textContent)
    const states = [...container.querySelectorAll('.container-card .container-state')].map((e) => e.textContent)
    expect(names).toEqual(['app', 'sidecar'])
    expect(states).toEqual(['Running', 'Waiting: CrashLoopBackOff'])
    expect(container.querySelector('.container-restarts')?.textContent).toContain('4')
  })

  it('surfaces a restarted container\'s last-termination reason inline (why it restarted)', () => {
    const pod: KNode = {
      ...configMap,
      kind: 'Pod',
      // Currently Running but OOMKilled on its last restart — the reason must show without opening the
      // manifest, and a clean container must NOT get a spurious "last exit" line.
      containerStatuses: [
        { name: 'app', ready: true, restarts: 1, state: 'Running', lastTerminated: 'OOMKilled (exit 137)' },
        { name: 'sidecar', ready: true, state: 'Running' },
      ],
    }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const lines = [...container.querySelectorAll('.container-last-terminated')].map((e) => e.textContent?.trim())
    expect(lines).toHaveLength(1) // only the restarted container, not the clean sidecar
    expect(lines[0]).toBe('last exit: OOMKilled (exit 137)')
  })

  it('explains the CrashLoopBackOff + clean-exit contradiction in words', () => {
    // "It exits successfully, why is it red?" — the batch-script-in-a-Deployment beginner mistake.
    // Only the crashloop+Completed pairing gets the gloss; a clean exit on a Running container
    // (previous test) keeps the bare reason.
    const pod: KNode = {
      ...configMap,
      kind: 'Pod',
      containerStatuses: [
        { name: 'main', ready: false, restarts: 3, state: 'Waiting: CrashLoopBackOff', lastTerminated: 'Completed' },
      ],
    }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const line = container.querySelector('.container-last-terminated')?.textContent
    expect(line).toContain('run one-shot work as a Job')
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
    // Init containers render in their own group (first), main containers in the second group.
    const names = [...container.querySelectorAll('.container-card .container-name')].map((e) => e.textContent)
    expect(names).toEqual(['wait-for-db', 'migrate', 'app', 'sidecar'])
    const groups = [...container.querySelectorAll('.container-group-head')].map((e) => e.textContent)
    expect(groups[0]).toContain('Init containers')
    expect(groups[1]).toContain('Containers')
  })

  it('renders each workload image (no per-container runtime to pair with)', () => {
    const workload: KNode = { ...configMap, kind: 'Deployment', images: ['nginx:1.25', 'envoy:1.29'] }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={workload} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const imgs = [...container.querySelectorAll('.drawer-image code')].map((e) => e.textContent)
    expect(imgs).toEqual(['nginx:1.25', 'envoy:1.29'])
  })

  // For a Pod the image belongs WITH its container (cycle 338): each card pairs name + state + image,
  // and the separate workload image list is not shown (that would be the "shown separately" the
  // redesign removed).
  it('pairs each pod container with its own image and drops the separate image list', () => {
    const pod: KNode = {
      ...configMap,
      kind: 'Pod',
      images: ['app:1.2', 'envoy:1.29'], // would-be flat list; should be superseded by per-container
      containerStatuses: [
        { name: 'app', ready: true, state: 'Running', image: 'app:1.2' },
        { name: 'proxy', ready: true, state: 'Running', image: 'envoy:1.29' },
      ],
    }
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    expect(container.querySelector('.drawer-images')).toBeNull() // no separate flat list for pods
    const cards = [...container.querySelectorAll('.container-card')]
    expect(cards.map((c) => c.querySelector('.container-name')?.textContent)).toEqual(['app', 'proxy'])
    expect(cards.map((c) => c.querySelector('.container-image code')?.textContent)).toEqual(['app:1.2', 'envoy:1.29'])
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

  it('a 403 names itself — access denied, not the generic load failure (events + manifest)', async () => {
    // kd's own policy denying drill-in must read as "ask your admin", not "kd is broken": the
    // generic wording sends the operator into retry/distrust instead of a permissions request.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('forbidden', { status: 403 })))
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText("Access denied — your kd role can't read events here.")
    // Manifest tab: same split.
    ;[...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.includes('Manifest'))!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await findByText("Access denied — your kd role can't read this manifest.")
  })

  it('explains the ~1h event TTL under an empty events list (not just "No recent events")', async () => {
    // Default beforeEach mock returns {events: []} → the empty state. The hint stops an operator from
    // reading an aged-out resource's empty tab as "nothing ever happened / broken feed".
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText('No recent events.')
    const hint = container.querySelector('.events-empty-hint')
    expect(hint?.textContent).toContain('about an hour')
  })

  it('glosses a coalesced event\'s ×N count in plain words on hover', async () => {
    const ev = { type: 'Warning', reason: 'BackOff', message: 'restarting failed container', count: 7, last: new Date().toISOString() }
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(JSON.stringify({ events: [ev] }), { status: 200 })
          : new Response('kind: ConfigMap\n', { status: 200 }),
      ),
    )
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    await findByText('BackOff')
    const count = container.querySelector('.event-count')
    expect(count?.textContent).toBe('×7')
    expect(count?.getAttribute('title')).toContain('Happened 7 times')
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

  it('requests a cluster-scoped resource under the __cluster__ namespace, not an empty one', async () => {
    // A Node/PriorityClass/ClusterRole carries no namespace; an empty {ns} segment collapses to a
    // double slash the server 404s (manifest + events both showed "unavailable"). The drawer must
    // substitute the cluster sentinel the server unmaps to "".
    const urls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(url)
      return Promise.resolve(
        url.includes('/events')
          ? new Response(JSON.stringify({ events: [] }), { status: 200 })
          : new Response('kind: Node\n', { status: 200 }),
      )
    })
    const node: KNode = { id: 'n1', kind: 'Node', name: 'worker-1', namespace: '', health: 'Healthy' }
    render(() => <DetailDrawer ctx="test-ctx" node={node} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    await vi.waitFor(() => expect(urls.some((u) => u.includes('/resources/Node/worker-1'))).toBe(true))
    expect(urls.every((u) => !u.includes('/namespaces//'))).toBe(true)
    expect(urls.some((u) => u.includes('/namespaces/__cluster__/resources/Node/worker-1'))).toBe(true)
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

  it('goes full screen from the logs toolbar, driving the same expanded state as the header button', () => {
    // The full-screen control lives in the logs panel (proximity), so it only exists on a loggable
    // resource's logs tab. Clicking it toggles the SAME `expanded` class the drawer-header expand
    // button drives — one affordance, two reachable places.
    const pod: KNode = { ...configMap, id: 'p1', kind: 'Pod', name: 'api-0', status: 'Running' }
    const { container } = render(() => (
      <DetailDrawer ctx="test-ctx" node={pod} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    const drawer = container.querySelector('.drawer')!
    expect(drawer.classList.contains('expanded')).toBe(false)
    const toggle = container.querySelector('.logs-fullscreen') as HTMLButtonElement
    expect(toggle.closest('.logs-panel')).toBeTruthy() // it's inside the logs panel
    toggle.click()
    expect(drawer.classList.contains('expanded')).toBe(true)
    // The header expand button reflects the shared state too (both now read "Restore panel size").
    expect(container.querySelector('.drawer-expand')!.getAttribute('aria-pressed')).toBe('true')
    toggle.click() // same control, now in restore state
    expect(drawer.classList.contains('expanded')).toBe(false)
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

  it('Alt-click copies an event as "Reason: message" with the green flash (log-line idiom)', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url.includes('/events')
          ? new Response(
              JSON.stringify({
                events: [
                  { type: 'Warning', reason: 'BackOff', message: 'crash-looping', count: 3, last: new Date().toISOString() },
                ],
              }),
              { status: 200 },
            )
          : new Response('kind: ConfigMap\n', { status: 200 }),
      ),
    )
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { container, findByText } = render(() => (
      <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />
    ))
    ;[...container.querySelectorAll('.drawer-tabs button')].find((b) => b.textContent?.includes('Events'))!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await findByText('BackOff')
    const item = container.querySelector('.event-item') as HTMLElement
    expect(item.title).toContain('Alt-click')
    // A plain click must NOT copy (it would fight text selection); Alt-click copies.
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(writeText).not.toHaveBeenCalled()
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    expect(writeText).toHaveBeenCalledWith('BackOff: crash-looping')
    await Promise.resolve() // let the .then flash apply
    expect(item.classList.contains('copied')).toBe(true)
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
    // jsdom has no layout; stub scrollIntoView so the scroll-to-first-match-on-type fires without
    // throwing, and so we can assert it was called.
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const find = (await findByPlaceholderText(/find in manifest/)) as HTMLInputElement
    find.value = 'feature'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    // Two case-insensitive hits in the body.
    expect(container.querySelectorAll('.manifest-match').length).toBe(2)
    // The count badge reads "<current>/<total>" once Enter cycling kicked in (cycle 263); fresh
    // state is index 0, i.e. "1/2".
    expect(container.querySelector('.manifest-find-count')?.textContent).toMatch(/1\/2/)
    // Typing must scroll the FIRST match into view (browser-find behaviour), not leave the manifest
    // pinned at the top with the hit below the fold. Deferred a microtask in the component.
    await Promise.resolve()
    expect(scrollSpy).toHaveBeenCalled()
    // The match scrolled to is match 0 (the one the "1/2" count points at) — so the first Enter
    // advances to 2/2 rather than appearing to skip the hit the count already claims you're on.
    expect((scrollSpy.mock.instances[0] as HTMLElement).classList.contains('current')).toBe(true)
  })

  it('restores focus to the resource search when the drawer closes with focus inside it', async () => {
    // The focus-restore reaches for the topology search input (the keyboard home base); provide one.
    const searchWrap = document.createElement('div')
    searchWrap.className = 'topology-search'
    const searchInput = document.createElement('input')
    searchWrap.appendChild(searchInput)
    document.body.appendChild(searchWrap)
    try {
      const [node, setNode] = createSignal<KNode | null>(configMap)
      const { container } = render(() => (
        <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />
      ))
      // Keyboard focus is inside the drawer (the close button).
      const closeBtn = container.querySelector('.drawer-close') as HTMLButtonElement
      closeBtn.focus()
      expect(container.querySelector('.drawer')!.contains(document.activeElement)).toBe(true)
      // Closing (node → null) must move focus to the search, not let it fall to <body>.
      setNode(null)
      await Promise.resolve()
      expect(document.activeElement).toBe(searchInput)
    } finally {
      searchWrap.remove()
    }
  })

  it('does NOT steal focus to the search when the drawer closes with focus outside it', async () => {
    const searchWrap = document.createElement('div')
    searchWrap.className = 'topology-search'
    const searchInput = document.createElement('input')
    searchWrap.appendChild(searchInput)
    document.body.appendChild(searchWrap)
    // A separate element to hold focus (simulating a mouse user who clicked the canvas to deselect).
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    try {
      const [node, setNode] = createSignal<KNode | null>(configMap)
      render(() => <DetailDrawer ctx="test-ctx" node={node()} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
      elsewhere.focus()
      setNode(null)
      await Promise.resolve()
      // Focus was outside the drawer, so it must stay put — not be yanked into the search.
      expect(document.activeElement).toBe(elsewhere)
    } finally {
      searchWrap.remove()
      elsewhere.remove()
    }
  })

  it('exposes the manifest YAML/JSON toggle as a radiogroup with roving tabindex', () => {
    // ConfigMap defaults to the Manifest tab, so the format toggle is rendered.
    const { container } = render(() => <DetailDrawer ctx="test-ctx" node={configMap} owners={[]} onNavigate={() => {}} onClose={() => {}} />)
    const group = container.querySelector('.manifest-format')!
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('aria-label')).toBe('Manifest format')
    const radios = [...group.querySelectorAll('[role="radio"]')] as HTMLButtonElement[]
    expect(radios.map((r) => r.textContent)).toEqual(['YAML', 'JSON'])
    // YAML is the default: it's checked and the sole tab stop; JSON is unchecked and roved out.
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios[0].tabIndex).toBe(0)
    expect(radios[1].getAttribute('aria-checked')).toBe('false')
    expect(radios[1].tabIndex).toBe(-1)
    // ArrowRight selects JSON (APG single-select keyboard model); the checked/roving state follows.
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(radios[1].tabIndex).toBe(0)
    expect(radios[0].getAttribute('aria-checked')).toBe('false')
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
