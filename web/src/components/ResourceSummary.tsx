import { createEffect, createMemo, createSignal, on, For, Show } from 'solid-js'
import { healthHint, healthTextColor } from '../health'
import { kindIcon } from '../icons'
import { shortNodeName } from '../names'
import { readRawPref, writePref } from '../prefs'
import { drawerResourceBars } from '../resourceBars'
import { relativeAge } from '../time'
import { useNow } from '../clock'
import type { KNode, Resources, ResourceUsage } from '../types'
import type { WorkloadUsage } from '../usageAggregate'
import ContainerCards from './ContainerCards'
import CopyButton from './CopyButton'
import ImageRef from './ImageRef'
import KindFacts from './KindFacts'
import UsageGauges, { paletteColor, type UsageSegment } from './UsageGauges'

interface Props {
  node: KNode
  // Optional "Kind/name" → select navigator; lets the host meta jump to its Node when present.
  onNavigateRef?: (kindSlashName: string) => boolean
  // Live metrics-server consumption for this resource (Pods and Nodes), keyed into by the drawer from
  // the capacity feed. Absent when metrics-server is unavailable or the kind has no usage gauge.
  usage?: ResourceUsage
  // A workload's (Deployment/StatefulSet/…) usage summed across its descendant pods — the controller
  // has no metrics of its own, so the drawer rolls up its replicas'. Absent for Pods/Nodes (they use
  // `usage`) and when no descendant pod has a reading yet.
  workloadUsage?: WorkloadUsage
  // For a Pod: its host node's capacity — the ceiling its bar falls back to when the pod sets no limit
  // or request, so an unconstrained pod still reads as a fraction of its node rather than a bare value.
  hostCapacity?: Resources
}

// podShareName shortens a replica's name to its unique trailing segment ("…-7j2ql"), the same
// relative display the topology gives controller-generated children — the legend and the canvas then
// agree on what a pod is called. A pod not named under the workload keeps its full name.
function podShareName(pod: string, workload: string): string {
  return pod.startsWith(workload + '-') ? '…-' + pod.slice(pod.lastIndexOf('-') + 1) : pod
}

// containerSegments splits a single usage reading into one coloured share per container NAME, in the
// breakdown's order. Shared by the Pod gauge (split its own total — "which container is eating the
// pod?") and the workload's by-container view (per-container summed fleet-wide — "is the sidecar
// overhead material?"). Returns [] without a real split: no breakdown, or a single container (the
// wire omits a 1-container breakdown, which would just repeat the total). The breakdown can
// undercount its total when a pod reports no per-container split mid-report, so any shortfall past 2%
// becomes an explicit dim "not yet attributed" segment — the stack must never stretch partial shares
// to fill the whole width.
type SegBounds = { reqCpu?: number; reqMem?: number; limCpu?: number; limMem?: number }
function containerSegments(u: ResourceUsage | undefined, bounds?: (name: string) => SegBounds | undefined): UsageSegment[] {
  const breakdown = u?.containers
  if (!u || !breakdown || breakdown.length < 2) return []
  const segs: UsageSegment[] = breakdown.map((c, i) => ({
    name: c.name,
    color: paletteColor(i),
    cpuMilli: c.cpuMilli ?? 0,
    memBytes: c.memBytes ?? 0,
    ...bounds?.(c.name),
  }))
  const cpuRest = (u.cpuMilli ?? 0) - segs.reduce((s, x) => s + x.cpuMilli, 0)
  const memRest = (u.memBytes ?? 0) - segs.reduce((s, x) => s + x.memBytes, 0)
  if (cpuRest > (u.cpuMilli ?? 0) * 0.02 || memRest > (u.memBytes ?? 0) * 0.02) {
    segs.push({ name: 'not yet attributed', color: 'var(--text-dim)', cpuMilli: Math.max(0, cpuRest), memBytes: Math.max(0, memRest), synthetic: true })
  }
  return segs
}

// sumBy totals a per-segment number across the hidden segments — the amount to lift OUT of the
// gauge's existing total when those segments are toggled off.
function sumBy(segs: UsageSegment[], pick: (s: UsageSegment) => number | undefined): number {
  return segs.reduce((acc, s) => acc + (pick(s) ?? 0), 0)
}

// minusUsage / minusBound subtract the hidden segments' share from the gauge's TOTAL usage / bound,
// rather than re-summing the shown. So the unfiltered gauge stays byte-identical (nothing hidden →
// nothing subtracted), and a bounded-but-unmetered container the breakdown can't see still counts in
// the ceiling. A bound the resource never declared stays undefined (subtracting from "unset" is still
// unset, not 0).
function minusUsage(total: ResourceUsage | undefined, hidden: UsageSegment[]): ResourceUsage | undefined {
  if (!total || hidden.length === 0) return total
  return {
    ...total,
    cpuMilli: total.cpuMilli != null ? Math.max(0, total.cpuMilli - sumBy(hidden, (s) => s.cpuMilli)) : total.cpuMilli,
    memBytes: total.memBytes != null ? Math.max(0, total.memBytes - sumBy(hidden, (s) => s.memBytes)) : total.memBytes,
  }
}
function minusBound(total: Resources | undefined, hidden: UsageSegment[], kind: 'req' | 'lim'): Resources | undefined {
  if (!total || hidden.length === 0) return total
  const cpu = kind === 'req' ? (s: UsageSegment) => s.reqCpu : (s: UsageSegment) => s.limCpu
  const mem = kind === 'req' ? (s: UsageSegment) => s.reqMem : (s: UsageSegment) => s.limMem
  return {
    cpuMilli: total.cpuMilli != null ? Math.max(0, total.cpuMilli - sumBy(hidden, cpu)) : total.cpuMilli,
    memBytes: total.memBytes != null ? Math.max(0, total.memBytes - sumBy(hidden, mem)) : total.memBytes,
  }
}

// workloadSegments builds the rolled-up gauge's stack: one share per POD (the default — replicas
// should pull even weight, so an outlier segment IS the finding) or per container NAME summed
// fleet-wide. The pod split sums exactly to the total by construction (unmetered pods are excluded
// from both sides).
function workloadSegments(wu: WorkloadUsage, by: 'pod' | 'container', workload: string): UsageSegment[] {
  if (by === 'container') return containerSegments(wu.usage)
  return wu.pods.map((p, i) => ({
    name: podShareName(p.name, workload),
    color: paletteColor(i),
    cpuMilli: p.cpuMilli ?? 0,
    memBytes: p.memBytes ?? 0,
  }))
}

// ResourceSummary is the drawer header's "what is this resource" block: identity, the runtime meta
// line, and the kind-specific spec each view cares about (Service address/ports/endpoints, Ingress
// routes, Role rules, binding subjects), plus images, per-container status, owner navigation, and
// labels. It's the presentation counterpart to the server's spec.go — kept apart from DetailDrawer's
// tab/fetch orchestration so each reads as one concern.
export default function ResourceSummary(props: Props) {
  // Labels are high-signal metadata (app, version, team) the operator otherwise has to dig out of
  // the manifest. Sort by key for a stable, scannable order.
  const labels = createMemo(() => Object.entries(props.node.labels ?? {}).sort(([a], [b]) => a.localeCompare(b)))

  // Legend filter: the segment names the operator has toggled OFF the gauge. Held at the component top
  // (NOT inside a gauge's render scope) so it survives the per-tick re-render of the node/usage props;
  // the recompute below reads it. Reset when the inspected resource changes — a different resource's
  // container/pod names are a different name space.
  const [hidden, setHidden] = createSignal<Set<string>>(new Set())
  createEffect(on(() => props.node.id, () => setHidden(new Set<string>())))

  // The Pod gauge's per-container segments, each carrying its container's own req/lim (joined from the
  // pod's container statuses — app containers only; init containers carry no live usage so never become
  // a segment) so hiding a container can subtract its bound from the ceiling.
  const podSegments = createMemo(() =>
    props.node.kind === 'Pod'
      ? containerSegments(props.usage, (name) => {
          const cs = props.node.containerStatuses?.find((s) => s.name === name && !s.init)
          return cs && { reqCpu: cs.cpuRequestMilli, reqMem: cs.memRequestBytes, limCpu: cs.cpuLimitMilli, limMem: cs.memLimitBytes }
        })
      : [],
  )
  // The Pod/Node gauge bars, recomputed against the shown subset: lift every hidden container's usage
  // and bound out of the pod totals before building the bars (a Node never segments, so hidden stays
  // empty there and the bars are byte-identical to the unfiltered build).
  const podGroups = createMemo(() => {
    const hiddenSegs = podSegments().filter((s) => hidden().has(s.name))
    return drawerResourceBars({
      isNode: props.node.kind === 'Node',
      usage: minusUsage(props.usage, hiddenSegs),
      capacity: props.node.capacityRes,
      allocatable: props.node.allocatable,
      request: minusBound(props.node.requests, hiddenSegs, 'req'),
      limit: minusBound(props.node.limits, hiddenSegs, 'lim'),
      hostCapacity: props.hostCapacity,
    })
  })

  // Toggle a segment off/on. Refuses to hide the last shown real segment: an empty gauge (no fill, no
  // ceiling) is a dead end, and keeping one shown keeps the recompute well-defined.
  const toggleSegment = (name: string, segs: UsageSegment[]) =>
    setHidden((prev) => {
      const next = new Set<string>(prev)
      if (next.has(name)) {
        next.delete(name)
        return next
      }
      if (segs.filter((s) => !s.synthetic && !next.has(s.name)).length <= 1) return prev
      next.add(name)
      return next
    })

  return (
    <div class="drawer-summary">
      {/* Drawer "hero" header (cycle 128): a card-sized kind silhouette plus the kind label and
          name stacked beside it — mirrors the topology card's icon-forward design so the drawer
          reads as the "blown up" version of the card you just clicked. The icon's host <g> picks
          up the health color (.health-tint*) so the hero pops in the row even before the eye
          reads the kind text or name. */}
      {/* The hero's health tint is the only health signal in the drawer; a bare colour reads
          ambiguously for the uncommon states — gray "Unknown" especially looks like a fault when it
          just means kd has no rule for the kind. The same healthHint gloss the sidebar dots carry
          explains the colour on hover (explicit-over-implicit), so the operator isn't left inferring. */}
      <div
        class="drawer-hero"
        classList={{ [`health-tint-${props.node.health.toLowerCase()}`]: true }}
        title={healthHint[props.node.health]}
      >
        <svg class="drawer-hero-icon" viewBox="0 0 14 14" width="34" height="34" aria-hidden="true">
          {kindIcon(props.node.kind)}
        </svg>
        <div class="drawer-hero-text">
          <div class="drawer-kind">{props.node.kind}</div>
          <div class="drawer-name">
            {props.node.name}
            {/* Plain copy yields the bare name (chat-friendly); Shift+click yields "Kind/name" —
                the form `kubectl get` accepts directly, so operators don't have to retype the
                kind every time they paste a resource ref into a terminal. */}
            <CopyButton
              text={() => props.node.name}
              title="Copy name"
              altText={() => `${props.node.kind}/${props.node.name}`}
              altTitle="for Kind/name"
            />
          </div>
          {/* Echo the card's status string (phase / "Ready · yellow" / "Unschedulable" / "1/1") so
              drilling in keeps the same status language the operator just read on the card, rather
              than dropping it to a bare icon tint. Non-pod resources have no container cards, so this
              is otherwise the only place the status would appear. Health-coloured like the card, but
              a Healthy status stays dim — the hero icon tint already keeps healthy quiet so the eye
              lands on trouble first, and a prominent green "Running" on every healthy resource fights
              that. */}
          <Show when={props.node.status}>
            <div
              class="drawer-status"
              style={{ color: props.node.health === 'Healthy' ? 'var(--text-dim)' : healthTextColor(props.node.health) }}
            >
              {props.node.status}
            </div>
          </Show>
        </div>
      </div>
      {/* The failure reason behind an unhealthy resource (server only sets it for non-Healthy ones) —
          the WHY that otherwise hides in the manifest's status.message. Sits right under the hero so it
          reads next to the status it explains (proximity). Clamped to a few lines with the full text on
          hover (title), since k8s messages can be long; a left accent ties it to the trouble. */}
      <Show when={props.node.message}>
        <div class="drawer-message" title={props.node.message}>
          {props.node.message}
        </div>
      </Show>
      <div class="drawer-meta">
        <Show when={props.node.namespace}>
          <span>{props.node.namespace}</span>
        </Show>
        <Show when={props.node.createdAt}>
          <span class="drawer-age" title={props.node.createdAt}>
            {relativeAge(props.node.createdAt!, useNow())} old
          </span>
        </Show>
        <Show when={(props.node.restarts ?? 0) > 0}>
          <span class="drawer-age">↻ {props.node.restarts} restarts</span>
        </Show>
        <Show when={props.node.host}>
          {/* Clickable when the Node is in the current graph (Nodes view + Ownership both include
              it); otherwise render the same chrome as a static span so the line is consistent. */}
          {props.onNavigateRef ? (
            <button
              class="drawer-age drawer-host"
              title={`Go to Node ${props.node.host}`}
              onClick={() => props.onNavigateRef!(`Node/${props.node.host}`)}
            >
              on {shortNodeName(props.node.host!)}
            </button>
          ) : (
            <span class="drawer-age" title={props.node.host}>on {shortNodeName(props.node.host!)}</span>
          )}
        </Show>
        <Show when={props.node.capacity}>
          <span class="drawer-age">{props.node.capacity}</span>
        </Show>
      </div>
      {/* CPU/memory resource bars — live usage gauged against each bound (a Node's Cap + Alloc, a
          Pod's summed Req + Lim), each bar's length sized to its ceiling and the fill extending past
          it (hatched) on a burst. A multi-container Pod stacks this summed fill BY CONTAINER (one
          colour + a name legend per container — the same stacked-segment language the workload
          rollup uses), so "which container is eating the pod" reads at a glance and the per-card bars
          below are dropped. Clicking a legend container hides it — the fill AND the ceiling regauge
          against the remaining containers. A single-container pod (the wire omits its breakdown) stays
          a plain fill; a Node never segments. */}
      <Show when={props.node.kind === 'Node' || props.node.kind === 'Pod'}>
        <UsageGauges
          groups={podGroups()}
          segments={props.node.kind === 'Pod' ? podSegments() : undefined}
          hidden={hidden()}
          onToggleSegment={(name) => toggleSegment(name, podSegments())}
          legend
        />
      </Show>
      {/* A workload's rolled-up usage (its replicas summed), gauged against the summed requests/limits —
          the "how much is this Deployment actually using vs reserving?" answer no single pod can give.
          Rendered like a Pod gauge (same request/limit semantics) with a caption naming the rollup. */}
      <Show when={props.workloadUsage}>
        {(wu) => {
          // Which way the fill splits: per replica (default — an uneven pod is the finding) or per
          // container name fleet-wide. A display habit, so it persists like the other kd:* prefs.
          const [gaugeBy, setGaugeBy] = createSignal<'pod' | 'container'>(
            readRawPref('kd:workloadGaugeBy') === 'container' ? 'container' : 'pod',
          )
          const setBy = (v: 'pod' | 'container') => {
            setGaugeBy(v)
            writePref('kd:workloadGaugeBy', v)
          }
          const groupBtn = (v: 'pod' | 'container', label: string, title: string) => (
            <button class="gauge-group-btn" classList={{ active: gaugeBy() === v }} aria-pressed={gaugeBy() === v} onClick={() => setBy(v)} title={title}>
              {label}
            </button>
          )
          return (
            <UsageGauges
              groups={drawerResourceBars({
                isNode: false,
                usage: wu().usage,
                request: wu().requests,
                limit: wu().limits,
              })}
              segments={workloadSegments(wu(), gaugeBy(), props.node.name)}
              segmentsLabel={`per ${gaugeBy()}`}
              legend
              caption={
                wu().meteredPods < wu().podCount
                  ? `summed across ${wu().meteredPods} of ${wu().podCount} pods`
                  : `summed across ${wu().podCount} ${wu().podCount === 1 ? 'pod' : 'pods'}`
              }
              controls={
                // Only when there is a split to regroup — a 1-pod, 1-container rollup has one share
                // either way, and a dead toggle would just invite a no-op click.
                <Show when={wu().pods.length > 1 || (wu().usage.containers?.length ?? 0) > 1}>
                  <div class="gauge-groupby" role="group" aria-label="Split the usage fill by">
                    {groupBtn('pod', 'by pod', 'One colour per replica — an uneven pod stands out')}
                    {groupBtn('container', 'by container', 'One colour per container name, summed across replicas — sidecar overhead stands out')}
                  </div>
                </Show>
              }
            />
          )
        }}
      </Show>
      {/* The per-kind "declarative essence" blocks (Service ports, Ingress routes, Role rules, PDB
          policy, data keys…) — see KindFacts, the presentation counterpart of the server's spec.go. */}
      <KindFacts node={props.node} />
      {/* A Pod's per-container cards (runtime status + image, and the OOM alarm — see ContainerCards;
          the resource bars now live in the segmented top gauge). Workloads expose no per-container
          runtime, so they fall back to the distinct image list. */}
      <Show
        when={(props.node.containerStatuses?.length ?? 0) > 0}
        fallback={
          <Show when={(props.node.images?.length ?? 0) > 0}>
            <div class="drawer-images">
              <For each={props.node.images}>{(img) => <ImageRef image={img} wrapClass="drawer-image" />}</For>
            </div>
          </Show>
        }
      >
        <ContainerCards statuses={props.node.containerStatuses ?? []} usage={props.usage} />
      </Show>
      {/* Collapsed by default: most resources carry a long label set (Helm/kustomize noise) that
          pushes the rest of the summary below the fold — the operator expands it when needed. */}
      <Show when={labels().length > 0}>
        <details class="drawer-labels">
          <summary>Labels · {labels().length}</summary>
          <div class="label-chips">
            <For each={labels()}>
              {([k, v]) => (
                // Clicking copies "key=value" (or just "key" for valueless labels) — paste-ready
                // for `kubectl … -l <chip>`. Shift+click copies the value alone (handy when the
                // operator wants just the image tag, the version, the role, etc.). A brief
                // .copied state confirms without a tooltip.
                <button
                  class="label-chip"
                  title={`Copy ${k}${v ? `=${v}` : ''}${v ? ' · Shift+click: value only' : ''}`}
                  onClick={async (e) => {
                    // Capture el BEFORE await — DOM nulls currentTarget after the synchronous
                    // handler returns. Same pattern as the drawer share button (cycle 275/281).
                    const el = e.currentTarget as HTMLButtonElement
                    const text = e.shiftKey && v ? v : (v ? `${k}=${v}` : k)
                    try {
                      await navigator.clipboard.writeText(text)
                      el.classList.add('copied')
                      setTimeout(() => el.classList.remove('copied'), 900)
                    } catch {
                      /* clipboard unavailable */
                    }
                  }}
                >
                  <span class="label-key">{k}</span>
                  <Show when={v}>
                    <span class="label-val">{v}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </details>
      </Show>
    </div>
  )
}
