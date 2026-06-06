import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import ResourceSummary from './ResourceSummary'
import { isFloatingImageTag, parseImageRef } from './ResourceSummary'
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

describe('ResourceSummary pod usage gauges', () => {
  const pod: KNode = {
    id: 'p1',
    kind: 'Pod',
    name: 'web-1',
    health: 'Healthy',
    requests: { cpuMilli: 100, memBytes: 256 * 1024 * 1024 },
    limits: { cpuMilli: 500, memBytes: 512 * 1024 * 1024 },
  }
  it('renders a Use-over-Req bar pair for CPU and memory — 4 bars, both gauged on the limit', () => {
    const usage = { cpuMilli: 120, memBytes: 300 * 1024 * 1024 }
    const { container } = render(() => <ResourceSummary node={pod} {...base} usage={usage} />)
    // Two resource groups (CPU, Mem), each with a Use bar over a Req bar → 4 rows total.
    expect([...container.querySelectorAll('.metric-group-label')].map((e) => e.textContent)).toEqual(['CPU', 'Mem'])
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    expect([...rows].map((r) => r.querySelector('.metric-sublabel')?.textContent)).toEqual(['Use', 'Req', 'Use', 'Req'])
    // CPU Use = live usage, CPU Req = the request — BOTH gauged against the 500m limit (shared track).
    expect(rows[0].querySelector('.metric-val b')?.textContent).toBe('120m')
    expect(rows[0].textContent).toContain('500m lim')
    expect(rows[1].querySelector('.metric-val b')?.textContent).toBe('100m') // the request
    expect(rows[1].textContent).toContain('500m lim')
    expect(rows[2].querySelector('.metric-val b')?.textContent).toBe('300Mi') // mem Use
  })
  it('marks an over-limit Use bar as pressure (Contrast), never the Req bar', () => {
    // CPU usage 600m exceeds the 500m limit → the Use fill carries the degraded class; Req never does.
    const usage = { cpuMilli: 600, memBytes: 100 * 1024 * 1024 }
    const { container } = render(() => <ResourceSummary node={pod} {...base} usage={usage} />)
    const cpuRows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(cpuRows[0].querySelector('.metric-fill.over')).toBeTruthy() // Use, over the limit
    expect(cpuRows[1].querySelector('.metric-fill.over')).toBeNull() // Req (the request) never recolours
  })
  it('falls back to the host-node capacity for an unconstrained pod, rather than a fake-full bar', () => {
    // A pod with usage but NO cpu request/limit — point 3: gauge it against its node's capacity.
    const noBounds: KNode = { id: 'p2', kind: 'Pod', name: 'web-2', health: 'Healthy', host: 'ip-10-0-0-1' }
    const { container } = render(() => (
      <ResourceSummary node={noBounds} {...base} usage={{ cpuMilli: 200 }} hostCapacity={{ cpuMilli: 4000 }} />
    ))
    const cpu = container.querySelector('.pod-metrics .metric-row')!
    expect(cpu.querySelector('.metric-bar.unconstrained')).toBeNull() // it IS gauged — against the node
    expect(cpu.textContent).toContain('node') // the ceiling label
    expect(cpu.querySelector('.metric-fill')).toBeTruthy()
  })
  it('shows a dashed unconstrained track when there is no bound and no host capacity at all', () => {
    const noBounds: KNode = { id: 'p3', kind: 'Pod', name: 'web-3', health: 'Healthy' }
    const { container } = render(() => <ResourceSummary node={noBounds} {...base} usage={{ cpuMilli: 18 }} />)
    const cpu = container.querySelector('.pod-metrics .metric-row')!
    expect(cpu.querySelector('.metric-bar.unconstrained')).toBeTruthy()
    expect(cpu.querySelector('.metric-fill')).toBeNull()
    expect(cpu.textContent).toContain('unset')
  })
  it('shows the Req bars from spec even without metrics, but nothing for an unrelated kind', () => {
    // No usage feed, but the pod's requests are known from its spec — the reservation is still worth
    // showing (Req bars), so the operator sees what it reserves even when metrics-server is down.
    const { container } = render(() => <ResourceSummary node={pod} {...base} />)
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(2) // Req only (no Use without usage), CPU + mem
    expect([...rows].every((r) => r.querySelector('.metric-sublabel')?.textContent === 'Req')).toBe(true)
    cleanup()
    const svc: KNode = { id: 's', kind: 'Service', name: 'web', health: 'Healthy' }
    const withUsage = render(() => <ResourceSummary node={svc} {...base} usage={{ cpuMilli: 50 }} />)
    expect(withUsage.container.querySelector('.pod-metrics')).toBeNull()
  })
  it('renders a workload rollup with Use-over-Req bars and a "summed across N pods" caption', () => {
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
    // CPU Use = summed usage; formatPair keeps value + summed-limit in one unit; the 1-core summed limit
    // drives cores ("0.24 / 1 lim"). The Req bar shows the summed request (0.2).
    expect(rows[0].querySelector('.metric-val b')?.textContent).toBe('0.24')
    expect(rows[0].textContent).toContain('1 lim')
    expect(rows[1].querySelector('.metric-val b')?.textContent).toBe('0.2') // summed request
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
  it('gauges a Node: Use vs total capacity (over on spillover), Req = Σpod-requests vs allocatable', () => {
    const node: KNode = {
      id: 'n1',
      kind: 'Node',
      name: 'ip-10-0-0-1',
      health: 'Healthy',
      allocatable: { cpuMilli: 940, memBytes: 7 * 1024 * 1024 * 1024 },
      capacityRes: { cpuMilli: 1000, memBytes: 8 * 1024 * 1024 * 1024 }, // total capacity → the unit + Use track
    }
    // CPU usage 1100m spills past the 1000m capacity → Use flagged over. Σrequest 900m vs 940m alloc → fine.
    const { container } = render(() => (
      <ResourceSummary node={node} {...base} usage={{ cpuMilli: 1100, memBytes: 2 * 1024 * 1024 * 1024 }} nodeReqSum={{ cpuMilli: 900, memBytes: 3 * 1024 * 1024 * 1024 }} />
    ))
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows.length).toBe(4)
    // Use row: cores, not millicores — capacityRes (≥1 core) drives the unit ("1.1 / 1 cap", the same
    // value the Nodes capacity track shows). Req row: Σrequest gauged against allocatable ("0.9 / 0.94 alloc").
    expect(rows[0].textContent).toContain('1 cap')
    expect(rows[0].querySelector('.metric-fill.over')).toBeTruthy() // 1100m > 1000m capacity
    expect(rows[1].textContent).toContain('0.94 alloc')
    expect(rows[1].textContent).not.toContain('940m')
    expect(rows[1].querySelector('.metric-fill.over')).toBeNull() // 900m < 940m allocatable — fine
  })
  it('flags node overcommit — Σrequest past allocatable recolours the Req bar', () => {
    const node: KNode = {
      id: 'n2', kind: 'Node', name: 'ip-10-0-0-2', health: 'Healthy',
      allocatable: { cpuMilli: 1000 }, capacityRes: { cpuMilli: 1000 },
    }
    const { container } = render(() => (
      <ResourceSummary node={node} {...base} usage={{ cpuMilli: 300 }} nodeReqSum={{ cpuMilli: 1200 }} />
    ))
    const rows = container.querySelectorAll('.pod-metrics .metric-row')
    expect(rows[1].querySelector('.metric-sublabel')?.textContent).toBe('Req')
    expect(rows[1].querySelector('.metric-fill.over')).toBeTruthy() // overcommit
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
