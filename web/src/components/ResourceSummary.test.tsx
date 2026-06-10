import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import ResourceSummary from './ResourceSummary'
import { isFloatingImageTag, parseImageRef } from './ImageRef'
import type { KNode } from '../types'

afterEach(cleanup)

const base = { owners: [], onNavigate: () => {} }

describe('ResourceSummary hero health gloss', () => {
  it('explains the health-tint colour via a title gloss — gray "Unknown" reads as a fault otherwise', () => {
    const node: KNode = { id: 'x', kind: 'VMServiceScrape', name: 'metrics', health: 'Unknown' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const hero = container.querySelector('.drawer-hero')
    expect(hero?.getAttribute('title')).toContain("can't classify")
  })
  it('carries the matching gloss for a healthy resource too (consistent with the sidebar dots)', () => {
    const node: KNode = { id: 'd', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    expect(container.querySelector('.drawer-hero')?.getAttribute('title')?.toLowerCase()).toContain('healthy')
  })
  // The root carries .drawer-summary so the expanded drawer can cap + scroll it, yielding the freed
  // height to the active tab panel (logs/manifest). jsdom can't measure the CSS cap, so assert the hook.
  it('exposes a .drawer-summary root so the expanded drawer can reclaim its height for the tab panel', () => {
    const node: KNode = { id: 'd', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    expect(container.querySelector('.drawer-summary')).toBeTruthy()
  })
})

describe('ResourceSummary container status dots', () => {
  const podWith = (statuses: KNode['containerStatuses']): KNode => ({
    id: 'p', kind: 'Pod', name: 'job-x', health: 'Healthy', containerStatuses: statuses,
  })
  it('grays a cleanly-terminated container — green is reserved for a live, running container', () => {
    const { container } = render(() => (
      <ResourceSummary node={podWith([{ name: 'main', ready: false, state: 'Terminated: Completed' }])} {...base} />
    ))
    const card = container.querySelector('.container-card')!
    expect(card.classList.contains('done')).toBe(true)
    expect(card.classList.contains('h-healthy')).toBe(false) // not green
    const dot = card.querySelector('.dot') as HTMLElement
    expect(dot.style.background).toContain('--text-dim') // gray
    // A done container is not flagged "not-ready" either — it's finished, not broken.
    expect(card.classList.contains('not-ready')).toBe(false)
  })
  it('keeps green for a running, ready container and red for a failed termination', () => {
    const { container } = render(() => (
      <ResourceSummary
        node={podWith([
          { name: 'app', ready: true, state: 'Running' },
          { name: 'sidecar', ready: false, state: 'Terminated: Error' },
        ])}
        {...base}
      />
    ))
    const cards = container.querySelectorAll('.container-card')
    expect(cards[0].classList.contains('h-healthy')).toBe(true) // running+ready stays green
    expect(cards[1].classList.contains('h-degraded')).toBe(true) // failed exit stays red, not gray
  })
  // "Which container is using it" reads VISUALLY: the pod gauge stacks one coloured segment per
  // container (proportional widths, hover names the share), each card carries the matching colour
  // swatch, and the card itself shows only the container's DECLARED bounds — live usage is not
  // repeated as text. A container's memory crossing 90% of its own limit still alarms in words on
  // the card (the one per-container emergency a pod-total gauge can hide).
  it('stacks the pod gauge fill per container and keys each card with a colour swatch', () => {
    const mi = 1024 * 1024
    const { container } = render(() => (
      <ResourceSummary
        node={{
          ...podWith([
            { name: 'app', ready: true, state: 'Running', cpuRequestMilli: 100, cpuLimitMilli: 500, memLimitBytes: 256 * mi },
            { name: 'sidecar', ready: true, state: 'Running' }, // nothing declared → no bounds row
          ]),
          limits: { cpuMilli: 500, memBytes: 256 * mi },
        }}
        {...base}
        usage={{
          cpuMilli: 300,
          memBytes: 300 * mi,
          containers: [
            { name: 'app', cpuMilli: 250, memBytes: 240 * mi }, // ~94% of its own mem limit
            { name: 'sidecar', cpuMilli: 50, memBytes: 60 * mi },
          ],
        }}
      />
    ))
    // Each rendered bar stacks both containers' segments, proportional to their share and named on
    // hover. (One Lim bar per resource here — only limits are declared.)
    const cpuSegs = [...container.querySelectorAll('.metric-fill-stack')][0].querySelectorAll('.metric-seg')
    expect(cpuSegs.length).toBe(2)
    expect(cpuSegs[0].getAttribute('title')).toBe('app · 250m')
    expect(cpuSegs[1].getAttribute('title')).toBe('sidecar · 50m')
    expect((cpuSegs[0] as HTMLElement).style.flexGrow).toBe('250')
    expect((cpuSegs[1] as HTMLElement).style.flexGrow).toBe('50')
    // Both cards carry swatches in distinct colours (the join to the segments above).
    const swatches = [...container.querySelectorAll('.container-swatch')] as HTMLElement[]
    expect(swatches.length).toBe(2)
    expect(swatches[0].style.background).not.toBe(swatches[1].style.background)
    // Cards show declared bounds only, each number explicitly labelled req/lim (a bare "x / y"
    // reads like the gauges' usage pairs — user feedback); undeclared sides are simply omitted.
    const rows = container.querySelectorAll('.container-usage')
    expect(rows.length).toBe(1) // sidecar declares nothing → no bounds row
    expect(rows[0].textContent).toBe('cpureq100m·lim500m|memlim256Mi')
    // The OOM alarm still reads in words on the affected card, driven by live usage.
    const warn = container.querySelectorAll('.container-near-limit')
    expect(warn.length).toBe(1)
    expect(warn[0].textContent).toContain('240Mi')
    expect(warn[0].textContent).toContain('OOM')
    expect(warn[0].closest('.container-card')?.querySelector('.container-name')?.textContent).toBe('app')
  })
  it('keeps the plain single fill (no stack, no swatches) without a multi-container breakdown', () => {
    const mi = 1024 * 1024
    const { container } = render(() => (
      <ResourceSummary
        node={{
          ...podWith([{ name: 'main', ready: true, state: 'Running' }]),
          limits: { cpuMilli: 500, memBytes: 256 * mi },
        }}
        {...base}
        usage={{ cpuMilli: 50, memBytes: 16 * mi }}
      />
    ))
    expect(container.querySelectorAll('.metric-fill').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.metric-fill-stack').length).toBe(0)
    expect(container.querySelectorAll('.container-swatch').length).toBe(0)
    expect(container.querySelectorAll('.container-usage').length).toBe(0) // nothing declared per container
  })
  it('says "not ready" in words on a Running container failing its readiness probe', () => {
    const { container } = render(() => (
      <ResourceSummary node={podWith([{ name: 'main', ready: false, state: 'Running' }])} {...base} />
    ))
    const state = container.querySelector('.container-state')!
    expect(state.textContent).toBe('Running · not ready')
    expect(state.getAttribute('title')).toContain('readiness probe')
    // A ready container carries no suffix — the words appear only when something is wrong.
    const { container: ok } = render(() => (
      <ResourceSummary node={podWith([{ name: 'main', ready: true, state: 'Running' }])} {...base} />
    ))
    expect(ok.querySelector('.container-state')?.textContent).toBe('Running')
  })
})

describe('ResourceSummary pod usage gauges', () => {
  const pod: KNode = {
    id: 'p1',
    kind: 'Pod',
    name: 'web-1',
    health: 'Healthy',
    requests: { cpuMilli: 100, memBytes: 256 * 1024 * 1024 },
    limits: { cpuMilli: 500, memBytes: 512 * 1024 * 1024 },
  }
  it('renders a Lim bar over a Req bar per resource, each filled by usage against its own bound', () => {
    const usage = { cpuMilli: 120, memBytes: 300 * 1024 * 1024 }
    const { container } = render(() => <ResourceSummary node={pod} {...base} usage={usage} />)
    expect([...container.querySelectorAll('.metric-group-label')].map((e) => e.textContent)).toEqual(['CPU', 'Mem'])
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    expect([...rows].map((r) => r.querySelector('.metric-sublabel')?.textContent)).toEqual(['Lim', 'Req', 'Lim', 'Req'])
    // Both CPU bars show the SAME usage (120m), gauged against the limit (500m) then the request (100m).
    expect(rows[0].querySelector('.metric-val b')?.textContent).toBe('120m')
    expect(rows[0].textContent).toContain('Lim')
    expect(rows[0].textContent).toContain('/ 500m')
    expect(rows[1].querySelector('.metric-val b')?.textContent).toBe('120m') // usage again, not the request
    expect(rows[1].textContent).toContain('/ 100m')
  })
  it('sizes each bar to its bound and hatches the overshoot when usage runs past a shorter bound', () => {
    // CPU 120m, limit 500m, request 100m → groupMax 500. The fill (0.24) is the SAME on both bars; the
    // bars differ in TRACK LENGTH: the Lim track spans the full scale (limit IS the group max), the Req
    // track only 0.2 (100m / 500m). Usage is under the limit but over the (shorter) request.
    const usage = { cpuMilli: 120, memBytes: 100 * 1024 * 1024 }
    const { container } = render(() => <ResourceSummary node={pod} {...base} usage={usage} />)
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    // Both bars carry one fill; equal usage ⇒ equal fill width (24%).
    expect((rows[0].querySelector('.metric-fill') as HTMLElement).style.width).toBe('24%')
    expect((rows[1].querySelector('.metric-fill') as HTMLElement).style.width).toBe('24%')
    // Track length encodes the bound: the Lim bar reaches the full scale; the Req bar's track stops at
    // its 0.2 ceiling — except the usage bursts past it, so the track extends to the fill (24%).
    expect((rows[0].querySelector('.metric-track') as HTMLElement).style.width).toBe('100%')
    expect((rows[1].querySelector('.metric-track') as HTMLElement).style.width).toBe('24%')
    // Lim bar: usage under the limit → no overshoot hatch. Req bar: usage over the request → hatched.
    expect(rows[0].querySelector('.metric-burst')).toBeNull()
    expect(rows[1].querySelector('.metric-burst')).toBeTruthy()
  })
  it('falls back to the host-node capacity as the ceiling for an unconstrained pod', () => {
    const noBounds: KNode = { id: 'p2', kind: 'Pod', name: 'web-2', health: 'Healthy', host: 'ip-10-0-0-1' }
    const { container } = render(() => (
      <ResourceSummary node={noBounds} {...base} usage={{ cpuMilli: 200 }} hostCapacity={{ cpuMilli: 4000 }} />
    ))
    const cpu = container.querySelector('.pod-metrics .metric-row')!
    expect(cpu.querySelector('.metric-sublabel')?.textContent).toBe('Node')
    expect(cpu.querySelector('.metric-bar.unconstrained')).toBeNull() // it IS gauged — against the node
    expect(cpu.textContent).toContain('/ 4') // 4000m → 4 cores, the ceiling (sublabel 'Node' names it)
  })
  it('shows a dashed unconstrained track when there is no bound and no host capacity at all', () => {
    const noBounds: KNode = { id: 'p3', kind: 'Pod', name: 'web-3', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={noBounds} {...base} usage={{ cpuMilli: 18 }} />)
    const cpu = container.querySelector('.pod-metrics .metric-row')!
    expect(cpu.querySelector('.metric-bar.unconstrained')).toBeTruthy()
    expect(cpu.querySelector('.metric-fill')).toBeNull()
    expect(cpu.textContent).toContain('unset')
  })
  it('shows the bars (empty) from spec bounds even without metrics, but nothing for an unrelated kind', () => {
    // No usage feed, but the pod's limit/request are known from its spec — the bounds are still worth
    // showing (empty bars), so the operator sees them even when metrics-server is down.
    const { container } = render(() => <ResourceSummary node={pod} {...base} />)
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    expect([...rows].every((r) => r.querySelector('.metric-fill') === null)).toBe(true) // empty, no fill
    // Track length still encodes the relative bounds without metrics: Lim spans the full scale, Req is
    // its fraction (CPU 100m/500m = 20%, Mem 256Mi/512Mi = 50%).
    expect([...rows].map((r) => (r.querySelector('.metric-track') as HTMLElement).style.width)).toEqual(['100%', '20%', '100%', '50%'])
    expect(rows[0].textContent).toContain('/ 500m') // the bound still reads
    cleanup()
    const svc: KNode = { id: 's', kind: 'Service', name: 'web', health: 'Healthy' }
    const withUsage = render(() => <ResourceSummary node={svc} {...base} usage={{ cpuMilli: 50 }} />)
    expect(withUsage.container.querySelector('.pod-metrics')).toBeNull()
  })
  it('renders a workload rollup with Lim/Req bars and a "summed across N pods" caption', () => {
    const dep: KNode = { id: 'd1', kind: 'Deployment', name: 'web', health: 'Healthy' }
    const workloadUsage = {
      usage: { cpuMilli: 240, memBytes: 600 * 1024 * 1024 },
      requests: { cpuMilli: 200, memBytes: 512 * 1024 * 1024 },
      limits: { cpuMilli: 1000, memBytes: 1024 * 1024 * 1024 },
      podCount: 3,
      meteredPods: 3,
    }
    const { container } = render(() => <ResourceSummary node={dep} {...base} workloadUsage={workloadUsage} />)
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    // CPU Lim bar: summed usage (240m) against the summed limit (1 core) → "0.24 / 1 lim".
    expect(rows[0].querySelector('.metric-val b')?.textContent).toBe('0.24')
    expect(rows[0].textContent).toContain('/ 1')
    expect(rows[1].textContent).toContain('/ 0.2') // summed request as the Req ceiling
    expect(container.querySelector('.metric-caption')?.textContent).toBe('summed across 3 pods')
  })
  it('caption notes partial metering when some replicas have no reading yet', () => {
    const dep: KNode = { id: 'd2', kind: 'StatefulSet', name: 'db', health: 'Healthy' }
    const workloadUsage = {
      usage: { cpuMilli: 100, memBytes: 200 * 1024 * 1024 },
      requests: { cpuMilli: 100 },
      podCount: 3,
      meteredPods: 2,
    }
    const { container } = render(() => <ResourceSummary node={dep} {...base} workloadUsage={workloadUsage} />)
    expect(container.querySelector('.metric-caption')?.textContent).toBe('summed across 2 of 3 pods')
  })
  it('gauges a Node by Cap + Alloc bars, both filled by node usage', () => {
    const node: KNode = {
      id: 'n1',
      kind: 'Node',
      name: 'ip-10-0-0-1',
      health: 'Healthy',
      allocatable: { cpuMilli: 3800, memBytes: 7 * 1024 * 1024 * 1024 },
      capacityRes: { cpuMilli: 4000, memBytes: 8 * 1024 * 1024 * 1024 },
    }
    // CPU usage 3900m: under the 4000m capacity (Cap) but past the 3800m allocatable (Alloc), so the
    // Alloc bar bursts past its ceiling while the Cap bar does not.
    const { container } = render(() => (
      <ResourceSummary node={node} {...base} usage={{ cpuMilli: 3900, memBytes: 2 * 1024 * 1024 * 1024 }} />
    ))
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    expect([...rows].map((r) => r.querySelector('.metric-sublabel')?.textContent)).toEqual(['Cap', 'Alloc', 'Cap', 'Alloc'])
    expect(rows[0].textContent).toContain('3.9 / 4') // cores, capacityRes drives the unit (sublabel 'Cap' names the bound)
    expect(rows[0].querySelector('.metric-burst')).toBeNull() // under capacity → no overshoot
    expect(rows[1].querySelector('.metric-burst')).toBeTruthy() // past allocatable → fill runs past the Alloc ceiling
  })
})

describe('ResourceSummary service selector', () => {
  it('shows a Service pod selector so "no endpoints" has a visible cause', () => {
    const svc: KNode = {
      id: 's', kind: 'Service', name: 'web', health: 'Degraded',
      clusterIP: '10.0.0.1', selector: 'app=web, tier=frontend',
      endpoints: { ready: 0, total: 0 },
    }
    const { container } = render(() => <ResourceSummary node={svc} {...base} />)
    const chip = container.querySelector('.drawer-ports .port-addr.port-caution')
    expect(chip?.textContent).toContain('selector')
    expect(chip?.textContent).toContain('app=web, tier=frontend')
    // 0 endpoints → the selector is the suspect, so it carries the caution tint (same idiom as PDB "0").
    expect(chip).toBeTruthy()
    // The selector is a terminal-paste target (`kubectl get pods -l …`), so it carries a CopyButton —
    // the same idiom as the clusterIP/image rows (Repetition).
    expect(chip?.querySelector('.copy-btn')).toBeTruthy()
  })
  it('shows the selector without the caution tint when the Service has ready backends', () => {
    const svc: KNode = {
      id: 's2', kind: 'Service', name: 'web', health: 'Healthy',
      clusterIP: '10.0.0.2', selector: 'app=web', endpoints: { ready: 2, total: 2 },
    }
    const { container } = render(() => <ResourceSummary node={svc} {...base} />)
    expect(container.querySelector('.drawer-ports .port-caution')).toBeNull()
    expect(container.textContent).toContain('app=web')
  })
})

describe('ResourceSummary external address', () => {
  it('explains a pending LoadBalancer address (caution tint + why, no copy button)', () => {
    // "pending" is the server's placeholder for a LoadBalancer with no assigned ingress — it is not
    // an address, so it must not read like one: caution tint, an explanatory title (provisioning vs
    // a cluster with no LB controller), and no copy affordance for a non-pasteable value.
    const svc: KNode = {
      id: 's3', kind: 'Service', name: 'lb', health: 'Healthy',
      clusterIP: '10.0.0.3', externalIP: 'pending',
    }
    const { container } = render(() => <ResourceSummary node={svc} {...base} />)
    const ext = container.querySelector('.port-ext')!
    expect(ext.classList.contains('port-caution')).toBe(true)
    expect(ext.getAttribute('title')).toContain('LoadBalancer')
    expect(ext.getAttribute('title')).toContain('pending forever')
    expect(ext.querySelector('.copy-btn')).toBeNull()
  })
  it('keeps a real external address plain and copyable', () => {
    const svc: KNode = {
      id: 's4', kind: 'Service', name: 'lb', health: 'Healthy',
      clusterIP: '10.0.0.4', externalIP: '203.0.113.7',
    }
    const { container } = render(() => <ResourceSummary node={svc} {...base} />)
    const ext = container.querySelector('.port-ext')!
    expect(ext.classList.contains('port-caution')).toBe(false)
    expect(ext.getAttribute('title')).toContain('External address')
    expect(ext.querySelector('.copy-btn')).toBeTruthy()
  })
  it('explains the "headless" address sentinel and offers no copy for it', () => {
    // "headless" is a sentinel like the LB "pending": jargon, not a pasteable address, so it gets an
    // explanatory title and no copy button, while a real cluster IP keeps both.
    const headless: KNode = {
      id: 's5', kind: 'Service', name: 'hl', health: 'Healthy', clusterIP: 'headless',
    }
    const { container } = render(() => <ResourceSummary node={headless} {...base} />)
    const addr = container.querySelector('.drawer-ports .port-addr')!
    expect(addr.getAttribute('title')).toContain('Headless')
    expect(addr.querySelector('.copy-btn')).toBeNull()
  })
  it('titles a real cluster IP as the in-cluster service address, copyable', () => {
    const svc: KNode = {
      id: 's6', kind: 'Service', name: 'web', health: 'Healthy', clusterIP: '10.0.0.6',
    }
    const { container } = render(() => <ResourceSummary node={svc} {...base} />)
    const addr = container.querySelector('.drawer-ports .port-addr')!
    expect(addr.getAttribute('title')).toContain('Service address')
    expect(addr.querySelector('.copy-btn')).toBeTruthy()
  })
})

describe('ResourceSummary labels', () => {
  it('renders labels in a collapsed-by-default <details> (a Pod can carry 20+ operator-internal labels)', () => {
    // The drawer must not lead with a wall of labels — they live behind a "Labels · N" disclosure that
    // is closed until the operator asks. The CSS hides the chips while closed; the DOM contract that
    // enables it is the <details> having NO `open` attribute. Regression guard: a stray `open` (or
    // dropping the <details>) brings the noise wall back.
    const node: KNode = {
      id: 'p', kind: 'Pod', name: 'es-0', health: 'Healthy',
      labels: { 'app.kubernetes.io/name': 'es', 'node-data': 'true', 'node-master': 'true' },
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const details = container.querySelector('details.drawer-labels')
    expect(details).toBeTruthy()
    expect(details?.hasAttribute('open')).toBe(false) // collapsed by default
    expect(details?.querySelector('summary')?.textContent).toBe('Labels · 3')
    expect(details?.querySelectorAll('.label-chip')).toHaveLength(3)
  })
})

describe('ResourceSummary data keys', () => {
  it('lists a ConfigMap\'s keys with the size split into a dim suffix', () => {
    const node: KNode = {
      id: 'cm', kind: 'ConfigMap', name: 'coredns', health: 'Healthy',
      dataKeys: ['Corefile · 600B', 'extra.conf · 12B'],
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const rows = [...container.querySelectorAll('.route-row.data-key')]
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.data-key-name')?.textContent).toBe('Corefile')
    expect(rows[0].querySelector('.data-key-size')?.textContent).toBe('600B')
  })

  it('leads a Secret with its type and never renders values', () => {
    const node: KNode = {
      id: 's', kind: 'Secret', name: 'tls', health: 'Healthy',
      secretType: 'kubernetes.io/tls', dataKeys: ['tls.crt · 1Ki', 'tls.key · 2Ki'],
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const typeRow = container.querySelector('.route-row.secret-type')
    expect(typeRow?.textContent).toContain('kubernetes.io/tls')
    // only names + sizes — the rendered summary must not leak a value-looking blob
    expect(container.querySelectorAll('.route-row.data-key')).toHaveLength(2)
  })

  it('renders no data section for a kind without keys', () => {
    const node: KNode = { id: 'p', kind: 'Pod', name: 'web', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    expect(container.querySelector('.data-key')).toBeNull()
    expect(container.querySelector('.secret-type')).toBeNull()
  })

  it('shows a DaemonSet\'s node selector, cautioned when nothing is scheduled (0/0)', () => {
    const node: KNode = {
      id: 'ds', kind: 'DaemonSet', name: 'gpu-agent', health: 'Healthy', status: '0/0',
      nodeSelector: 'gpu=true',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const chip = [...container.querySelectorAll('.port-addr')].find((c) => c.textContent?.includes('node selector'))!
    expect(chip.textContent).toContain('gpu=true')
    expect(chip.classList.contains('port-caution')).toBe(true) // 0/0 → the selector is the suspect
    // Scheduled somewhere → informational, no caution tint.
    const ok = render(() => (
      <ResourceSummary node={{ ...node, id: 'ds2', status: '3/3' }} {...base} />
    ))
    const okChip = [...ok.container.querySelectorAll('.port-addr')].find((c) => c.textContent?.includes('node selector'))!
    expect(okChip.classList.contains('port-caution')).toBe(false)
  })

  it('lists a ResourceQuota\'s used/hard rows with the same key/value split', () => {
    const node: KNode = {
      id: 'q', kind: 'ResourceQuota', name: 'tiny', health: 'Healthy',
      quotaUsage: ['requests.cpu · 50m / 100m', 'requests.memory · 0 / 128Mi'],
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const rows = [...container.querySelectorAll('.route-row.data-key')]
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.data-key-name')?.textContent).toBe('requests.cpu')
    expect(rows[0].querySelector('.data-key-size')?.textContent).toBe('50m / 100m')
  })
})

describe('ResourceSummary batch', () => {
  it('shows a CronJob\'s last-run time and active count', () => {
    const node: KNode = {
      id: 'cj', kind: 'CronJob', name: 'backup', health: 'Healthy', status: '0 2 * * *',
      lastRun: new Date(Date.now() - 3 * 3600_000).toISOString(), active: 1,
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const text = container.querySelector('.drawer-ports')?.textContent ?? ''
    expect(text).toContain('last run')
    expect(text).toContain('ago')
    expect(text).toContain('active')
    expect(container.querySelector('.port-failed')).toBeNull() // no failures → no failed chip
  })

  it('flags a Job\'s failed count with the degraded-coloured chip', () => {
    const node: KNode = { id: 'j', kind: 'Job', name: 'migrate', health: 'Degraded', status: '0/1', failed: 5 }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const failed = container.querySelector('.port-failed')
    expect(failed?.textContent).toContain('5')
    expect(failed?.querySelector('.addr-label')?.textContent).toBe('failed')
  })
})

describe('ResourceSummary PDB', () => {
  it('shows the policy and allowed disruptions', () => {
    const node: KNode = {
      id: 'pdb', kind: 'PodDisruptionBudget', name: 'web', health: 'Healthy',
      status: '3/2 healthy', pdbPolicy: 'min 2', disruptions: '1',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const text = container.querySelector('.drawer-ports')?.textContent ?? ''
    expect(text).toContain('min 2')
    expect(text).toContain('can disrupt')
    expect(text).toContain('1')
    expect(container.querySelector('.port-caution')).toBeNull() // 1 allowed → no caution
  })

  it('flags 0 allowed disruptions with the caution chip (a drain would block)', () => {
    const node: KNode = {
      id: 'pdb', kind: 'PodDisruptionBudget', name: 'tight', health: 'Healthy',
      pdbPolicy: 'max 0', disruptions: '0',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const caution = container.querySelector('.port-caution')
    expect(caution?.querySelector('.addr-label')?.textContent).toBe('can disrupt')
    expect(caution?.textContent).toContain('0')
  })
})

describe('ResourceSummary HPA', () => {
  it('shows the driving metric as a labelled chip — why/when it scales', () => {
    const hpa: KNode = {
      id: 'h2', kind: 'HorizontalPodAutoscaler', name: 'web', health: 'Healthy',
      scaleReplicas: '3', scaleRange: '2–10', scaleMetrics: 'cpu 72% / 80%',
    }
    const { container } = render(() => <ResourceSummary node={hpa} {...base} />)
    const chips = [...container.querySelectorAll('.drawer-ports .port-addr')]
    const metric = chips.find((c) => c.textContent?.includes('metric'))
    expect(metric?.textContent).toContain('cpu 72% / 80%')
  })

  it('shows replica state and bounds as labelled chips', () => {
    const node: KNode = {
      id: 'hpa', kind: 'HorizontalPodAutoscaler', name: 'web', health: 'Healthy',
      scaleReplicas: '3 → 5', scaleRange: '2–10',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const labels = [...container.querySelectorAll('.port-addr .addr-label')].map((e) => e.textContent)
    expect(labels).toEqual(expect.arrayContaining(['replicas', 'range']))
    const text = container.querySelector('.drawer-ports')?.textContent ?? ''
    expect(text).toContain('3 → 5')
    expect(text).toContain('2–10')
  })
})

describe('ResourceSummary ArgoCD Application', () => {
  it('shows the deploy destination and synced revision as labelled chips', () => {
    // kd's graph is namespace-scoped: the dest chip is the pointer from the argocd namespace to
    // where the app's workloads (and their trouble) actually live; rev answers "what's deployed".
    const app: KNode = {
      id: 'a', kind: 'Application', name: 'shop', health: 'Progressing',
      appDest: 'team-a', appRevision: '01234567',
    }
    const { container } = render(() => <ResourceSummary node={app} {...base} />)
    const chips = [...container.querySelectorAll('.drawer-ports .port-addr')]
    expect(chips.find((c) => c.textContent?.includes('dest'))?.textContent).toContain('team-a')
    const rev = chips.find((c) => c.textContent?.includes('rev'))
    expect(rev?.textContent).toContain('01234567')
    expect(rev?.querySelector('.copy-btn')).toBeTruthy() // a revision is a git-log paste target
  })
})

describe('ResourceSummary RBAC', () => {
  it('flags a wildcard-verb rule with an explicit tag + caution class, leaving bounded rules plain', () => {
    const node: KNode = {
      id: 'cr', kind: 'ClusterRole', name: 'admin', health: 'Healthy',
      rules: ['*.*: *', 'pods, pods/log: get, list, watch'],
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const rows = [...container.querySelectorAll('.route-row')]
    expect(rows[0].classList.contains('route-priv')).toBe(true)
    expect(rows[0].querySelector('.route-priv-tag')?.textContent).toBe('wildcard')
    expect(rows[1].classList.contains('route-priv')).toBe(false)
    expect(rows[1].querySelector('.route-priv-tag')).toBeNull()
  })
})

describe('ResourceSummary NetworkPolicy', () => {
  it('renders the target + per-direction summary lines', () => {
    const node: KNode = {
      id: 'np', kind: 'NetworkPolicy', name: 'api-a', health: 'Healthy',
      netpol: ['targets: app.kubernetes.io/name=api-a', 'Ingress: 1 rule'],
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const text = [...container.querySelectorAll('.route-row')].map((r) => r.textContent)
    expect(text).toContain('targets: app.kubernetes.io/name=api-a')
    expect(text).toContain('Ingress: 1 rule')
  })
})

describe('ResourceSummary Node', () => {
  it('surfaces scheduling taints with the caution chip — why pods will not land here', () => {
    const node: KNode = {
      id: 'n', kind: 'Node', name: 'ip-10-8-69-217', health: 'Healthy',
      taints: 'eks.amazonaws.com/compute-type=fargate:NoSchedule',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const caution = container.querySelector('.port-caution')
    expect(caution?.querySelector('.addr-label')?.textContent).toBe('taints')
    expect(caution?.textContent).toContain('fargate:NoSchedule')
  })

  it('omits the taints chip for an untainted node', () => {
    const node: KNode = { id: 'n', kind: 'Node', name: 'worker-1', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    expect(container.querySelector('.port-caution')).toBeNull()
  })
})

describe('ResourceSummary StorageClass', () => {
  it('shows reclaim, binding, and an expandable flag as policy chips (provisioner is the hero status)', () => {
    // The provisioner moved to the hero status (storageClassSummary) so it reads as the headline,
    // not one chip among equals — see internal/kube/graph TestStorageClassSummary. The chips carry
    // only the policy details now.
    const node: KNode = {
      id: 'sc', kind: 'StorageClass', name: 'gp3', health: 'Healthy',
      provisioner: 'ebs.csi.aws.com', reclaimPolicy: 'Retain', volumeBinding: 'WaitForFirstConsumer', expandable: true,
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const text = container.querySelector('.drawer-ports')?.textContent ?? ''
    expect(text).not.toContain('ebs.csi.aws.com') // provisioner is the status headline, not a chip
    expect(text).toContain('Retain')
    expect(text).toContain('WaitForFirstConsumer')
    expect([...container.querySelectorAll('.port-chip')].some((c) => c.textContent === 'expandable')).toBe(true)
  })

  it('omits the expandable flag when not allowed', () => {
    const node: KNode = { id: 'sc', kind: 'StorageClass', name: 'std', health: 'Healthy', provisioner: 'k8s.io/minikube-hostpath', reclaimPolicy: 'Delete' }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    expect([...container.querySelectorAll('.port-chip')].some((c) => c.textContent === 'expandable')).toBe(false)
  })
})

describe('ResourceSummary storage', () => {
  it('shows a PVC\'s access modes and storage class as labelled chips', () => {
    const node: KNode = {
      id: 'pvc', kind: 'PersistentVolumeClaim', name: 'data', health: 'Healthy',
      status: 'Bound 10Gi', accessModes: 'RWO', storageClass: 'gp3',
    }
    const { container } = render(() => <ResourceSummary node={node} {...base} />)
    const labels = [...container.querySelectorAll('.port-addr .addr-label')].map((e) => e.textContent)
    expect(labels).toEqual(expect.arrayContaining(['access', 'class']))
    const text = container.querySelector('.drawer-ports')?.textContent ?? ''
    expect(text).toContain('RWO')
    expect(text).toContain('gp3')
  })
})

describe('isFloatingImageTag', () => {
  it('treats a digest reference as pinned', () => {
    expect(isFloatingImageTag('nginx@sha256:abc')).toBe(false)
    expect(isFloatingImageTag('registry.example.com/team/app:v1@sha256:def')).toBe(false)
  })

  it('treats a versioned tag as pinned', () => {
    expect(isFloatingImageTag('nginx:1.25')).toBe(false)
    expect(isFloatingImageTag('registry.example.com/team/app:v2.3.4')).toBe(false)
  })

  it('flags an image without any tag as floating (implicit :latest)', () => {
    expect(isFloatingImageTag('nginx')).toBe(true)
    expect(isFloatingImageTag('registry.example.com/team/app')).toBe(true)
  })

  it('flags well-known moving pointers as floating', () => {
    expect(isFloatingImageTag('nginx:latest')).toBe(true)
    expect(isFloatingImageTag('foo:stable')).toBe(true)
    expect(isFloatingImageTag('foo:main')).toBe(true)
    expect(isFloatingImageTag('foo:master')).toBe(true)
    expect(isFloatingImageTag('foo:edge')).toBe(true)
  })

  it('does not confuse a registry port for a missing tag', () => {
    expect(isFloatingImageTag('registry:5000/app:1.2.3')).toBe(false)
    expect(isFloatingImageTag('registry:5000/app')).toBe(true)
  })

  it('is case-insensitive on the floating tag itself', () => {
    expect(isFloatingImageTag('foo:LATEST')).toBe(true)
    expect(isFloatingImageTag('foo:Main')).toBe(true)
  })
})

describe('parseImageRef', () => {
  it('splits a full ECR ref into dim prefix, repo name, and emphasised tag', () => {
    expect(parseImageRef('111122223333.dkr.ecr.us-west-2.amazonaws.com/argoproj/argoexec:v4.0.5')).toEqual({
      prefix: '111122223333.dkr.ecr.us-west-2.amazonaws.com/argoproj/',
      name: 'argoexec',
      tag: ':v4.0.5',
    })
  })

  it('keeps the whole digest as the emphasised part', () => {
    expect(parseImageRef('registry.example.com/team/app@sha256:abcdef')).toEqual({
      prefix: 'registry.example.com/team/',
      name: 'app',
      tag: '@sha256:abcdef',
    })
  })

  it('does not treat a registry port as the tag (port stays in the prefix)', () => {
    expect(parseImageRef('registry:5000/app:1.2.3')).toEqual({ prefix: 'registry:5000/', name: 'app', tag: ':1.2.3' })
  })

  it('a bare image has no prefix and an empty (implicit-latest) tag', () => {
    expect(parseImageRef('nginx')).toEqual({ prefix: '', name: 'nginx', tag: '' })
    expect(parseImageRef('nginx:1.25')).toEqual({ prefix: '', name: 'nginx', tag: ':1.25' })
  })
})
