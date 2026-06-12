import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSignal } from 'solid-js'
import Sidebar from './Sidebar'
import { CLUSTER_SCOPE, type NamespaceInfo } from '../api'

afterEach(cleanup)
// jsdom doesn't implement scrollIntoView; Sidebar calls it when the selection changes (cycle 242).
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const namespaces: NamespaceInfo[] = [
  { name: 'aaa', health: 'Healthy' },
  { name: 'zzz-broken', health: 'Degraded', nonReady: 3 },
  { name: 'mmm', health: 'Progressing', nonReady: 1 },
  { name: 'bbb', health: 'Healthy' },
]

const noop = () => {}

describe('Sidebar', () => {
  it('lists namespaces in stable alphabetical order regardless of health, and counts the troubled', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    const order = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    // Plain A→Z — health no longer reorders rows, so a row never moves as its dot color changes.
    expect(order).toEqual(['aaa', 'bbb', 'mmm', 'zzz-broken'])
    // The trouble badge still counts Degraded/Progressing namespaces even though they don't float up.
    expect(container.querySelector('.ns-trouble')?.textContent).toBe('2')
    // Each troubled namespace shows its non-ready count (in alpha order: mmm=1, zzz-broken=3).
    const counts = [...container.querySelectorAll('.ns-list .ns-count')].map((e) => e.textContent)
    expect(counts).toEqual(['1', '3'])
  })

  it('makes the trouble badge a jump button when a handler is wired (a plain span otherwise)', () => {
    // Without a handler: a passive count.
    const plain = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    expect(plain.container.querySelector('button.ns-trouble')).toBeNull()
    expect(plain.container.querySelector('.ns-trouble')?.textContent).toBe('2')
    cleanup()

    // With a handler: the badge is a button that fires the jump on click.
    let jumped = 0
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} onJumpToTrouble={() => (jumped += 1)} />
    ))
    const btn = container.querySelector('button.ns-trouble') as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.getAttribute('aria-label')).toContain('2')
    fireEvent.click(btn)
    expect(jumped).toBe(1)
  })

  it('hides the trouble badge entirely when nothing is troubled (no empty button)', () => {
    const allHealthy: NamespaceInfo[] = [{ name: 'a', health: 'Healthy' }, { name: 'b', health: 'Healthy' }]
    const { container } = render(() => (
      <Sidebar namespaces={allHealthy} selected={null} onSelect={noop} loading={false} failed={false} onJumpToTrouble={noop} />
    ))
    expect(container.querySelector('.ns-trouble')).toBeNull()
  })

  it('marks the selected namespace with aria-current and names the nav landmark', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected="mmm" onSelect={noop} loading={false} failed={false} />
    ))
    expect(container.querySelector('nav.sidebar')?.getAttribute('aria-label')).toBe('Namespaces')
    // Exactly the selected row carries aria-current=page; the others don't (so a screen reader
    // announces which namespace is the current view, not just a visual highlight).
    const current = [...container.querySelectorAll('.ns-list button[aria-current="page"]')]
    expect(current.length).toBe(1)
    expect(current[0].querySelector('.ns-name')?.textContent).toBe('mmm')
  })

  it('renders no permanent legend chrome — each row explains itself on hover instead', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    expect(container.querySelector('.ns-legend')).toBeNull()
    // No divider either — the alphabetical list has no troubled/healthy boundary to mark.
    expect(container.querySelectorAll('.ns-divider').length).toBe(0)
  })

  it('puts the health tooltip on the whole row, not just the 8px dot (hovering the name shows it)', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Alpha order: aaa(Healthy), bbb(Healthy), mmm(Progressing,1), zzz-broken(Degraded,3).
    const buttons = [...container.querySelectorAll('.ns-list button')] as HTMLElement[]
    // A healthy row carries the bare gloss — no count to mention.
    expect(buttons[0].getAttribute('title')).toBe('Healthy — all resources are OK')
    // A troubled row's title is self-complete (gloss + not-ready count), so the whole row is a
    // hover target — an operator no longer has to land on the tiny dot to learn what's wrong.
    const broken = buttons.find((b) => b.textContent?.includes('zzz-broken'))!
    expect(broken.getAttribute('title')).toBe('Degraded — something is broken · 3 not ready')
  })

  it('explains each health state in the dot tooltip, not just the bare enum word', () => {
    const mix: NamespaceInfo[] = [
      { name: 'crd-only', health: 'Unknown', nonReady: 4 },
      { name: 'fine', health: 'Healthy' },
    ]
    const { container } = render(() => (
      <Sidebar namespaces={mix} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Alpha order: crd-only (Unknown) then fine (Healthy). The gray dot's tooltip says what Unknown means.
    const titles = [...container.querySelectorAll('.ns-list .ns-dot')].map((e) => e.getAttribute('title'))
    expect(titles[0]).toContain('Unknown')
    expect(titles[0]).toContain("can't classify")
    expect(titles[1]).toContain('Healthy')
  })

  it('renders a filled health dot for every namespace — healthy reads green, not a hollow gray ring (cycle 308)', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Scope to .ns-list so the key's sample dot (also .ns-dot, under the title) isn't counted.
    const dots = [...container.querySelectorAll('.ns-list .ns-dot')] as HTMLElement[]
    // One dot per namespace, each with a non-transparent background bound to its health color.
    expect(dots.length).toBe(namespaces.length)
    for (const d of dots) {
      expect(d.style.background).not.toBe('')
      expect(d.style.background).not.toBe('transparent')
    }
    // No leftover hollow-placeholder class — healthy is a real (green) dot now.
    expect(container.querySelector('.ns-dot-ok')).toBeNull()
    // The healthy dots resolve to the healthy color var (alpha order: aaa, bbb are the first two).
    expect(dots[0].style.background).toBe('var(--health-healthy)')
  })

  it('counts only Degraded/Progressing in the "needs attention" badge, not Unknown/Suspended (cycle 313)', () => {
    const mix: NamespaceInfo[] = [
      { name: 'broken', health: 'Degraded', nonReady: 2 },
      { name: 'rolling', health: 'Progressing', nonReady: 1 },
      { name: 'crd-only', health: 'Unknown', nonReady: 4 }, // custom resources kd can't classify
      { name: 'paused', health: 'Suspended', nonReady: 1 }, // intentionally off
      { name: 'fine', health: 'Healthy' },
    ]
    const { container } = render(() => (
      <Sidebar namespaces={mix} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Only the Degraded + Progressing namespaces raise the alarm; Unknown/Suspended don't.
    expect(container.querySelector('.ns-trouble')?.textContent).toBe('2')
  })

  it('names the health state in the ns-count tooltip (cycle 317)', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Alpha order, counts only on the troubled rows: mmm (Progressing, 1) then zzz-broken (Degraded, 3).
    // Scope to .ns-list so the key's sample "#" (also .ns-count) doesn't join the assertion.
    const titles = [...container.querySelectorAll('.ns-list .ns-count')].map((e) => e.getAttribute('title'))
    expect(titles).toEqual(['1 non-ready · Progressing', '3 non-ready · Degraded'])
  })

  it('colors the ns-count with the legible ink, not the vivid dot value (cycle 132)', () => {
    // The dot stays vivid (graphics, 3:1) but the count is small text and must clear AA 4.5:1 on the
    // light theme — healthTextColor returns the darker *-text ink for the trouble states the badge
    // actually shows. Alpha order: mmm (Progressing) then zzz-broken (Degraded).
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    const colors = [...container.querySelectorAll('.ns-list .ns-count')].map((e) => (e as HTMLElement).style.color)
    expect(colors).toEqual(['var(--progressing-text)', 'var(--degraded-text)'])
  })

  it('filters the list by name', async () => {
    const { container, getByPlaceholderText } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: 'bbb' } })
    const names = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    expect(names).toEqual(['bbb'])
  })

  it('trims paste whitespace in the filter, like the resource search', async () => {
    const { container, getByPlaceholderText } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: 'bbb ' } })
    const names = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    expect(names).toEqual(['bbb'])
  })

  it('shows an error message when loading failed', () => {
    const { getByText } = render(() => <Sidebar namespaces={[]} selected={null} onSelect={noop} loading={false} failed={true} />)
    expect(getByText("Couldn't load namespaces.")).toBeTruthy()
  })

  it('Enter on the filter input selects the top-of-list match (cycle 223)', () => {
    const onSelect = vi.fn()
    const { getByPlaceholderText } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={onSelect} loading={false} failed={false} />
    ))
    const input = getByPlaceholderText(/Filter/) as HTMLInputElement
    fireEvent.input(input, { target: { value: 'bbb' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('bbb')
  })

  it('ArrowDown/ArrowUp on the filter input steps through the filtered ns without blurring', () => {
    const onSelect = vi.fn()
    // Three healthy ns with stable alpha order; troubled-first sort is a no-op here.
    const list: NamespaceInfo[] = [
      { name: 'a', health: 'Healthy' },
      { name: 'b', health: 'Healthy' },
      { name: 'c', health: 'Healthy' },
    ]
    const { getByPlaceholderText } = render(() => (
      <Sidebar namespaces={list} selected="b" onSelect={onSelect} loading={false} failed={false} />
    ))
    const input = getByPlaceholderText(/Filter/) as HTMLInputElement
    input.focus()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(onSelect).toHaveBeenLastCalledWith('c')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    // Up from selected 'b' wraps to 'a' if we're at index 1 -> 0; selected didn't follow into the
    // controlled re-render (the mock onSelect only records the call), so cur stays at b's index.
    expect(onSelect).toHaveBeenLastCalledWith('a')
    // Focus must stay in the input so the filter remains typeable.
    expect(document.activeElement).toBe(input)
  })

  it('offers a retry button on failure when onRetry is wired (cycle 220)', () => {
    const onRetry = vi.fn()
    const { getByText } = render(() => (
      <Sidebar namespaces={[]} selected={null} onSelect={noop} loading={false} failed={true} onRetry={onRetry} />
    ))
    fireEvent.click(getByText('retry'))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('distinguishes no namespaces visible from no filter matches', () => {
    const { container, getByText } = render(() => <Sidebar namespaces={[]} selected={null} onSelect={noop} loading={false} failed={false} />)
    expect(getByText('No namespaces visible.')).toBeTruthy()
    // The empty state is a live region so an AT user typing a filter hears the candidates vanish.
    expect(container.querySelector('.ns-empty')?.getAttribute('role')).toBe('status')
  })

  it('announces the trouble count to screen readers, and stays silent when all-clear', () => {
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected={null} onSelect={noop} loading={false} failed={false} />
    ))
    // Polite live region mirrors the badge/favicon so an AT user hears trouble arrive (2 troubled here).
    const live = [...container.querySelectorAll('.sr-only[role="status"]')].find((e) => /attention/.test(e.textContent ?? ''))
    expect(live?.textContent).toContain('2 namespaces need attention')
    cleanup()
    // All healthy → the region renders but is empty, so nothing is announced.
    const allHealthy: NamespaceInfo[] = [{ name: 'a', health: 'Healthy' }]
    const clean = render(() => <Sidebar namespaces={allHealthy} selected={null} onSelect={noop} loading={false} failed={false} />)
    const region = clean.container.querySelector('.sidebar-title .sr-only[role="status"]')
    expect(region?.textContent?.trim()).toBe('')
  })

  it('pins the [cluster] pseudo-namespace above the list and outside the filter (FR-004)', async () => {
    const withCluster: NamespaceInfo[] = [
      { name: CLUSTER_SCOPE, health: 'Degraded', nonReady: 1 },
      { name: 'aaa', health: 'Healthy' },
      { name: 'bbb', health: 'Healthy' },
    ]
    const onSelect = vi.fn()
    const { container, getByText, getByPlaceholderText } = render(() => (
      <Sidebar namespaces={withCluster} selected={null} onSelect={onSelect} loading={false} failed={false} />
    ))
    // Pinned first regardless of name sort, identified by its [cluster] label.
    expect(getByText('[cluster]')).toBeTruthy()
    // The cluster entry sits above the namespaces list visually — it's the first ns-name.
    const names = [...container.querySelectorAll('.ns-name')].map((e) => e.textContent)
    expect(names[0]).toBe('[cluster]')
    // The cluster entry is excluded from the troubled-count badge so the badge keeps
    // describing namespace trouble specifically.
    expect(container.querySelector('.ns-trouble')).toBeNull()
    // Filter doesn't drop the pinned entry — operator can always jump to cluster scope.
    fireEvent.input(getByPlaceholderText(/Filter/), { target: { value: 'aaa' } })
    expect(getByText('[cluster]')).toBeTruthy()
    // Click forwards CLUSTER_SCOPE through onSelect — the server uses this exact value in URLs.
    fireEvent.click(getByText('[cluster]'))
    expect(onSelect).toHaveBeenCalledWith(CLUSTER_SCOPE)
    // "[cluster]" is jargon — its hover must explain what lives here, then the health hint.
    const title = container.querySelector('.ns-cluster')?.getAttribute('title') ?? ''
    expect(title).toContain('outside any namespace')
    expect(title).toContain('Degraded')
  })

  // A programmatic jump (Alt+T / first-load) bumps the flash tick; the selected row pulses so the
  // landing is visible even when 'nearest' scrolling didn't move anything (cycle 332/R5).
  it('flashes the selected row when the flash tick changes', async () => {
    const [flash, setFlash] = createSignal(0)
    const { container } = render(() => (
      <Sidebar namespaces={namespaces} selected="zzz-broken" onSelect={noop} loading={false} failed={false} flash={flash()} />
    ))
    const active = () => container.querySelector('.ns-list button.active')
    expect(active()?.textContent).toContain('zzz-broken') // sanity: the right row is active
    expect(active()?.classList.contains('ns-flash')).toBe(false)
    setFlash(1)
    await Promise.resolve() // flush the queueMicrotask the flash effect schedules
    expect(active()?.classList.contains('ns-flash')).toBe(true)
  })
})
