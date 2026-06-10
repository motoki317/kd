import { createMemo, For, Show } from 'solid-js'
import { formatPair, formatQuantity } from '../capacityLayout'
import { healthColor, healthHint, healthTextColor } from '../health'
import { kindFromRef, kindIcon } from '../icons'
import { shortNodeName } from '../names'
import { ruleHasWildcardVerb } from '../rbac'
import { drawerResourceBars, type ResGroupModel } from '../resourceBars'
import { relativeAge } from '../time'
import { useNow } from '../clock'
import type { Health, KNode, Resources, ResourceUsage } from '../types'
import type { WorkloadUsage } from '../usageAggregate'
import ContainerCards, { containerColorMap, paletteColor } from './ContainerCards'
import CopyButton from './CopyButton'
import ImageRef from './ImageRef'

// endpointHealth colors a Service's endpoint readout like everything else: no backends at all is a
// Degraded misconfiguration (selector matches nothing), some-but-not-all ready is Progressing (a
// rollout), and fully ready is Healthy.
function endpointHealth(ep: { ready: number; total: number }): Health {
  if (ep.total === 0) return 'Degraded'
  if (ep.ready < ep.total) return 'Progressing'
  return 'Healthy'
}

// MetaChip is the drawer's "labelled fact" idiom: a dim `addr-label` next to a bright `<code>` value,
// shared by every kind-spec block (PVC access/class, Job runtime, HPA scale, PDB policy, StorageClass)
// so they read as one visual language (Repetition) and a new essence field is a one-liner instead of a
// copy-pasted 4-line span. `class` appends a state modifier on the same `port-addr` element the bare
// blocks used (e.g. `port-failed` for a degraded count, `port-caution` for an operationally critical 0).
// `copy` adds the address-row's hover-reveal CopyButton for the labelled facts that are terminal-paste
// targets (a Service selector → `kubectl get pods -l …`), matching the clusterIP/image rows' idiom. Most
// facts (access modes, PDB policy) aren't pasted anywhere, so copy stays opt-in rather than universal.
function MetaChip(props: { label: string; value: string | number; title: string; class?: string; copy?: boolean }) {
  return (
    <span class="port-addr" classList={props.class ? { [props.class]: true } : undefined} title={props.title}>
      <span class="addr-label">{props.label}</span>
      <code>{props.value}</code>
      <Show when={props.copy}>
        <CopyButton text={() => String(props.value)} title={`Copy ${props.label}`} />
      </Show>
    </span>
  )
}

// KeyValRow renders one "key · value" string from the server as a chip row with the key bright and
// the value dim + right-aligned (Contrast + Alignment — the same value/capacity treatment the node
// bars use). Shared by the data-keys and quota rows so the split-at-"·" wire format lives in one
// place; a row without the separator falls back to plain text.
function KeyValRow(props: { row: string; title?: string }) {
  const sep = () => props.row.lastIndexOf(' · ')
  return (
    <Show when={sep() >= 0} fallback={<code class="route-row">{props.row}</code>}>
      <code class="route-row data-key" title={props.title}>
        <span class="data-key-name">{props.row.slice(0, sep())}</span>
        <span class="data-key-size">{props.row.slice(sep() + 3)}</span>
      </code>
    </Show>
  )
}

interface Props {
  node: KNode
  owners: KNode[]
  onNavigate: (id: string) => void
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

// UsageSegment is one container's share of a pod's usage fill — the bars stack one coloured segment
// per container (joined to its card by the swatch) so "which container is using it" reads visually
// instead of as a second set of numbers under the cards.
export interface UsageSegment {
  name: string
  color: string
  cpuMilli: number
  memBytes: number
}

// workloadSegments builds the rolled-up gauge's stack from the fleet-summed breakdown (same visual
// language as the pod gauge — one colour per container name). A workload's breakdown can undercount
// its total mid-rollout (a pod reporting only one of its containers carries no breakdown but still
// counts in the sum), so any shortfall past 2% becomes an explicit dim "not yet attributed" segment —
// the stack must never stretch partial shares to fill the whole width.
function workloadSegments(u: ResourceUsage): UsageSegment[] {
  const breakdown = u.containers
  if (!breakdown || breakdown.length < 2) return []
  const segs = breakdown.map((c, i) => ({
    name: c.name,
    color: paletteColor(i),
    cpuMilli: c.cpuMilli ?? 0,
    memBytes: c.memBytes ?? 0,
  }))
  const cpuRest = (u.cpuMilli ?? 0) - segs.reduce((s, x) => s + x.cpuMilli, 0)
  const memRest = (u.memBytes ?? 0) - segs.reduce((s, x) => s + x.memBytes, 0)
  if (cpuRest > (u.cpuMilli ?? 0) * 0.02 || memRest > (u.memBytes ?? 0) * 0.02) {
    segs.push({ name: 'not yet attributed', color: 'var(--text-dim)', cpuMilli: Math.max(0, cpuRest), memBytes: Math.max(0, memRest) })
  }
  return segs
}

// UsageGauges renders the CPU + memory resource bars: per resource, one bar per bound (a Pod's Lim +
// Req, a Node's Cap + Alloc). Every bar in a group shares ONE linear scale (like the Nodes capacity
// view), so the fill — LIVE USAGE — draws the SAME length on both bars, and each bar's TRACK LENGTH
// encodes its bound: the bar ENDS at its ceiling (a 256Mi limit bar is visibly shorter than a 281Mi
// request bar), not a tick on a fixed-width track. Usage past a bound EXTENDS the track past that
// ceiling with the overshoot hatched — the Nodes-view "over its request/limit" idiom. Built by
// drawerResourceBars. With `segments` (a multi-container pod), the fill is a stack of per-container
// colours; the stack's total width is identical to the plain fill, since the breakdown sums to the
// pod total by construction (joinUsage).
const pct = (f: number) => `${Math.min(100, f * 100)}%`
function UsageGauges(props: { groups: ResGroupModel[]; caption?: string; segments?: UsageSegment[]; legend?: boolean }) {
  const segsFor = (res: 'cpu' | 'memory') =>
    (props.segments ?? [])
      .map((s) => ({ name: s.name, color: s.color, value: res === 'cpu' ? s.cpuMilli : s.memBytes }))
      .filter((s) => s.value > 0)
  return (
    <Show when={props.groups.length > 0}>
      <div class="pod-metrics" role="group" aria-label="Resource usage against limits and requests">
        <For each={props.groups}>
          {(g) => (
            <div class="metric-group">
              {/* The resource heading groups its bars (Proximity); the per-bar Lim/Req (or Cap/Alloc)
                  label names which bound each tick marks. */}
              <div class="metric-group-label">{g.label}</div>
              <For each={g.bars}>
                {(b) => {
                  const pair = formatPair(b.usage, b.ceil, g.res, g.unitRef)
                  const ref = b.unconstrained ? 'unset' : `${pair.cap} ${b.label.toLowerCase()}`
                  const ratio = b.usage != null && b.ceil ? b.usage / b.ceil : 0
                  // The visible track ends AT the bound (its ceiling), or past it — at the usage — when
                  // usage overshoots. So a smaller bound draws a shorter bar (Req shorter than Lim) and a
                  // burst grows the bar past its ceiling, like a Nodes-view bullet.
                  const extentFrac = Math.max(b.fillFrac, b.boundFrac ?? 0)
                  return (
                    <div class="metric-row">
                      <span class="metric-sublabel">{b.label}</span>
                      {/* An unconstrained bar (no bound) shows a dashed empty track — never a fake-full bar. */}
                      <div class="metric-bar" classList={{ unconstrained: b.unconstrained }} title={b.unconstrained ? `${pair.value} used · ungauged` : `${pair.value} used · ${ref}${b.over ? ` · ${ratio.toFixed(1)}× over` : ''}`}>
                        <Show when={!b.unconstrained}>
                          {/* Track length = the bound: the bar's right edge IS its ceiling (or the usage
                              when it bursts past). The relative bound lengths read directly off the bars. */}
                          <div class="metric-track" style={{ width: pct(extentFrac) }} />
                          {/* Usage fill on the shared scale (same length across this group's bars).
                              Multi-container pods stack one coloured segment per container (each
                              proportional to its share; hover names it) — same total width as the
                              plain fill, so the bound-vs-usage read is unchanged. */}
                          <Show when={b.usage != null}>
                            <Show
                              when={segsFor(g.res).length > 1}
                              fallback={<div class="metric-fill" classList={{ over: b.over }} style={{ width: pct(b.fillFrac) }} />}
                            >
                              {/* role=img + aria-label: the shares are otherwise hover-only (segment
                                  titles on plain divs) — one label per stack keeps them readable
                                  to a screen reader without N virtual-cursor stops. */}
                              <div
                                class="metric-fill metric-fill-stack"
                                classList={{ over: b.over }}
                                style={{ width: pct(b.fillFrac) }}
                                role="img"
                                aria-label={`per container: ${segsFor(g.res)
                                  .map((s) => `${s.name} ${formatQuantity(s.value, g.res)}`)
                                  .join(', ')}`}
                              >
                                <For each={segsFor(g.res)}>
                                  {(s) => (
                                    <div
                                      class="metric-seg"
                                      style={{ 'flex-grow': String(s.value), background: s.color }}
                                      title={`${s.name} · ${formatQuantity(s.value, g.res)}`}
                                    />
                                  )}
                                </For>
                              </div>
                            </Show>
                            {/* Overshoot: hatch the portion of the fill beyond the ceiling (where the track
                                grew past the bound). */}
                            <Show when={b.over && b.boundFrac != null}>
                              <div class="metric-burst" style={{ left: pct(b.boundFrac!), width: `${Math.min(100, b.fillFrac * 100) - b.boundFrac! * 100}%` }} />
                            </Show>
                          </Show>
                        </Show>
                      </div>
                      {/* Bare "value / bound" — the row's sublabel already names the bound, so a "req"
                          suffix would print it twice; matches the capacity view's bare pairs. The
                          worded form stays on the bar's hover title. */}
                      <span class="metric-val">
                        <b>{pair.value}</b>
                        <span class="metric-ref"> / {b.unconstrained ? 'unset' : pair.cap}</span>
                      </span>
                    </div>
                  )
                }}
              </For>
            </div>
          )}
        </For>
        {/* Legend naming each segment colour — for gauges with no container cards below (the
            workload rollup), where the colours would otherwise be hover-only (explicit over
            implicit). The pod gauge skips it: its cards carry the swatches. */}
        <Show when={props.legend && (props.segments?.length ?? 0) > 1}>
          <div class="metric-legend">
            <For each={props.segments}>
              {(s) => (
                <span class="metric-legend-item">
                  <span class="container-swatch" style={{ background: s.color }} />
                  {s.name}
                </span>
              )}
            </For>
          </div>
        </Show>
        {/* For a rolled-up workload gauge: name what the bars sum so the operator doesn't read a
            Deployment's "3 cores" as one pod's (explicit over implicit). */}
        <Show when={props.caption}>
          <div class="metric-caption">{props.caption}</div>
        </Show>
      </div>
    </Show>
  )
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

  // Per-container usage segments for the pod gauge, in card order (init first, then app) so the
  // stack reads left-to-right like the cards read top-to-bottom, coloured by the shared map the
  // card swatches use. Empty for single-container pods (the server omits their breakdown) and for
  // containers without a reading — the stack then falls back to the plain accent fill.
  const usageSegments = createMemo<UsageSegment[]>(() => {
    const breakdown = props.usage?.containers
    if (!breakdown || breakdown.length < 2) return []
    const colors = containerColorMap(props.node.containerStatuses ?? [])
    const order = (props.node.containerStatuses ?? []).map((cs) => cs.name)
    return [...breakdown]
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
      .map((c) => ({
        name: c.name,
        color: colors.get(c.name) ?? 'var(--accent)',
        cpuMilli: c.cpuMilli ?? 0,
        memBytes: c.memBytes ?? 0,
      }))
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
      {/* CPU/memory resource bars — live usage gauged against each bound (a Pod's Lim + Req, a Node's
          Cap + Alloc), each bar's length sized to its ceiling and the fill extending past it (hatched)
          on a burst. The "am I bursting past my request / spilling past allocatable" answer the operator
          otherwise gets only from `kubectl top` + `describe`. Shown when there's anything to gauge —
          usage OR a declared bound. */}
      <Show when={props.node.kind === 'Pod' || props.node.kind === 'Node'}>
        <UsageGauges
          groups={drawerResourceBars({
            isNode: props.node.kind === 'Node',
            usage: props.usage,
            capacity: props.node.capacityRes,
            allocatable: props.node.allocatable,
            request: props.node.requests,
            limit: props.node.limits,
            hostCapacity: props.hostCapacity,
          })}
          segments={usageSegments()}
        />
      </Show>
      {/* A workload's rolled-up usage (its replicas summed), gauged against the summed requests/limits —
          the "how much is this Deployment actually using vs reserving?" answer no single pod can give.
          Rendered like a Pod gauge (same request/limit semantics) with a caption naming the rollup. */}
      <Show when={props.workloadUsage}>
        {(wu) => (
          <UsageGauges
            groups={drawerResourceBars({
              isNode: false,
              usage: wu().usage,
              request: wu().requests,
              limit: wu().limits,
            })}
            segments={workloadSegments(wu().usage)}
            legend
            caption={
              wu().meteredPods < wu().podCount
                ? `summed across ${wu().meteredPods} of ${wu().podCount} pods`
                : `summed across ${wu().podCount} ${wu().podCount === 1 ? 'pod' : 'pods'}`
            }
          />
        )}
      </Show>
      {/* A Service's reachable address and port mappings — the network view's core question
          ("what routes here, on which port?"), otherwise buried in the manifest. The address
          is copyable for pasting into a curl/port-forward. */}
      <Show when={props.node.clusterIP || props.node.externalIP || (props.node.ports?.length ?? 0) > 0 || props.node.selector}>
        <div class="drawer-ports">
          {/* "headless" is the server's sentinel for ClusterIP: None — jargon, not an address, so it
              gets the "pending" external-IP treatment: an explanatory title and no copy affordance
              (copying the literal word is meaningless; the pods themselves are the addresses). */}
          <Show when={props.node.clusterIP}>
            <span
              class="port-addr"
              title={
                props.node.clusterIP === 'headless'
                  ? 'Headless — no service IP; DNS returns the pod IPs directly'
                  : // Type-neutral on purpose: this value is a cluster IP for a ClusterIP/NodePort/LB
                    // service but the aliased EXTERNAL host for an ExternalName one — "reachable inside
                    // the cluster" would misdescribe the latter. The hero's type line disambiguates.
                    'Service address — what the service name resolves to'
              }
            >
              <code>{props.node.clusterIP}</code>
              <Show when={props.node.clusterIP !== 'headless'}>
                <CopyButton text={() => props.node.clusterIP!} title="Copy address" />
              </Show>
            </span>
          </Show>
          {/* For a LoadBalancer/NodePort service the external address is the actual "reach it from
              outside" answer the cluster IP can't give — surface it labelled, and copyable unless
              it's still "pending" (no address assigned yet). "pending" is a placeholder, not an
              address, so it wears the caution tint + an explanatory title: the usual reasons (the
              provider is still provisioning, or this cluster has no LoadBalancer controller at all
              — where it stays pending forever) are exactly what the operator drilling into an
              unreachable Service needs to hear. */}
          <Show when={props.node.externalIP}>
            <span
              class="port-addr port-ext"
              classList={{ 'port-caution': props.node.externalIP === 'pending' }}
              title={
                props.node.externalIP === 'pending'
                  ? 'No address yet — the LoadBalancer is provisioning. With no LoadBalancer controller it stays pending forever.'
                  : 'External address'
              }
            >
              <span class="addr-label">ext</span>
              <code>{props.node.externalIP}</code>
              <Show when={props.node.externalIP !== 'pending'}>
                <CopyButton text={() => props.node.externalIP!} title="Copy external address" />
              </Show>
            </span>
          </Show>
          <For each={props.node.ports}>{(p) => <span class="port-chip">{p}</span>}</For>
          <Show when={props.node.endpoints}>
            {(ep) => (
              <span class="endpoint-stat" title="Ready pods backing this Service">
                <span class="dot" style={{ background: healthColor(endpointHealth(ep())) }} />
                {ep().total === 0 ? 'no endpoints' : `${ep().ready}/${ep().total} ready`}
              </span>
            )}
          </Show>
          {/* The pod selector — the "why no endpoints" answer. A Service with 0 backends is the network
              view's most common failure, and the selector (a typo'd label, a renamed workload) is what
              an operator otherwise opens the manifest to find. Carries the caution tint exactly when it
              matches nothing (total 0), so the eye lands on the suspect, matching the PDB "can disrupt 0"
              idiom. The Service→Pod edges already show what it DOES match when it matches. */}
          <Show when={props.node.selector}>
            <MetaChip
              label="selector"
              value={props.node.selector!}
              title="Labels a Pod must have to back this Service"
              class={props.node.endpoints?.total === 0 ? 'port-caution' : undefined}
              copy
            />
          </Show>
        </div>
      </Show>
      {/* A DaemonSet's node selector — "which nodes does this run on" is its defining fact, and a
          selector matching no node is exactly why one shows a contented "0/0" with no pods anywhere.
          Caution tint when nothing is scheduled, mirroring the Service selector's matches-nothing cue. */}
      <Show when={props.node.nodeSelector}>
        <div class="drawer-ports">
          <MetaChip
            label="node selector"
            value={props.node.nodeSelector!}
            title="Runs only on nodes carrying these labels"
            class={props.node.status === '0/0' ? 'port-caution' : undefined}
            copy
          />
        </div>
      </Show>
      {/* A PVC/PV's access modes + storage class — the rest of its essence past the status's "Bound
          10Gi": can more than one pod mount it (RWO vs RWX), and which provisioner/tier (gp3 vs
          standard). Labelled chips (explicit over implicit), reusing the Service address row's idiom. */}
      <Show when={props.node.accessModes || props.node.storageClass}>
        <div class="drawer-ports">
          <Show when={props.node.accessModes}>
            <MetaChip label="access" value={props.node.accessModes!} title="Access modes" />
          </Show>
          <Show when={props.node.storageClass}>
            <MetaChip label="class" value={props.node.storageClass!} title="Storage class" />
          </Show>
        </div>
      </Show>
      {/* A Job/CronJob's runtime progress the status line omits: when a CronJob last fired ("did it
          actually run?"), how many pods/jobs are running now, and a Job's failed count — burning retries
          the "succeeded/total" status hides (a Job at "0/1" with 5 failures looks merely pending). The
          failed chip carries the degraded colour so it reads as trouble, matching the health vocabulary. */}
      <Show when={props.node.lastRun || (props.node.active ?? 0) > 0 || (props.node.failed ?? 0) > 0}>
        <div class="drawer-ports">
          <Show when={props.node.lastRun}>
            <MetaChip label="last run" value={`${relativeAge(props.node.lastRun!, useNow())} ago`} title="Last schedule time" />
          </Show>
          <Show when={(props.node.active ?? 0) > 0}>
            <MetaChip label="active" value={props.node.active!} title="Running now" />
          </Show>
          <Show when={(props.node.failed ?? 0) > 0}>
            <MetaChip label="failed" value={props.node.failed!} title="Failed pods" class="port-failed" />
          </Show>
        </div>
      </Show>
      {/* An HPA's scale state: how many replicas it's running (with a → arrow mid-scale), the
          min–max bounds it works within — "is it at the ceiling?" — and the metric driving the
          decision ("cpu 72% / 80%", current / target): how close to the trigger is it, and is the
          signal even arriving ("—" current = metrics not sampled). Labelled chips beside the
          status, reusing the address-row idiom. The HPA→target edge already shows what it scales. */}
      <Show when={props.node.scaleReplicas || props.node.scaleRange || props.node.scaleMetrics}>
        <div class="drawer-ports">
          <Show when={props.node.scaleReplicas}>
            <MetaChip label="replicas" value={props.node.scaleReplicas!} title="Running replicas — shows the target while scaling" />
          </Show>
          <Show when={props.node.scaleRange}>
            <MetaChip label="range" value={props.node.scaleRange!} title="Allowed replica range" />
          </Show>
          <Show when={props.node.scaleMetrics}>
            <MetaChip label="metric" value={props.node.scaleMetrics!} title="Scaling metric: current / target" />
          </Show>
        </div>
      </Show>
      {/* An ArgoCD Application's deploy destination + synced revision: kd's graph is namespace-
          scoped, so without the dest chip an Application card gives no pointer from the argocd
          namespace to where its workloads (and their trouble) actually live; the revision answers
          "what's deployed". The status line already pairs health with OutOfSync. */}
      <Show when={props.node.appDest || props.node.appRevision}>
        <div class="drawer-ports">
          <Show when={props.node.appDest}>
            <MetaChip label="dest" value={props.node.appDest!} title="Namespace this Application deploys into" />
          </Show>
          <Show when={props.node.appRevision}>
            <MetaChip label="rev" value={props.node.appRevision!} title="Last synced revision" copy />
          </Show>
        </div>
      </Show>
      {/* A PodDisruptionBudget's configured policy (min N / max N) and how many voluntary evictions it
          allows right now. "can disrupt 0" is the operationally critical state — a node drain/upgrade
          blocks here — so it carries the caution colour to draw the eye (the status's "healthy" count
          can't say this). The PDB→pods edge already shows what it guards. */}
      <Show when={props.node.pdbPolicy || props.node.disruptions}>
        <div class="drawer-ports">
          <Show when={props.node.pdbPolicy}>
            <MetaChip label="policy" value={props.node.pdbPolicy!} title="Disruption budget policy" />
          </Show>
          <Show when={props.node.disruptions}>
            <MetaChip
              label="can disrupt"
              value={props.node.disruptions!}
              title="Pods that may be evicted right now — 0 blocks a node drain"
              class={props.node.disruptions === '0' ? 'port-caution' : undefined}
            />
          </Show>
        </div>
      </Show>
      {/* A Node's scheduling taints — the answer to "why won't a pod land here without a matching
          toleration", otherwise manifest-only. A NoSchedule/NoExecute taint blocks scheduling, so it
          carries the caution colour like the PDB "can disrupt 0" state (explicit over implicit). */}
      <Show when={props.node.taints}>
        <div class="drawer-ports">
          <MetaChip label="taints" value={props.node.taints!} title="A pod needs a matching toleration to run on this node" class="port-caution" />
        </div>
      </Show>
      {/* A StorageClass's policy details. The provisioner (+ default marker) is the hero status now —
          so it reads as the headline, not one chip among equals (Contrast) — leaving the reclaim
          policy (does deleting a PVC destroy the data — Delete vs Retain), binding mode, and whether
          PVCs can grow as the supporting chips. The `provisioner` field still gates the block (it marks
          a StorageClass). */}
      <Show when={props.node.provisioner}>
        <div class="drawer-ports">
          <Show when={props.node.reclaimPolicy}>
            <MetaChip label="reclaim" value={props.node.reclaimPolicy!} title="What happens to the volume when its claim is deleted" />
          </Show>
          <Show when={props.node.volumeBinding}>
            <MetaChip label="binding" value={props.node.volumeBinding!} title="Volume binding mode" />
          </Show>
          <Show when={props.node.expandable}>
            <span class="port-chip" title="PVCs on this class can be expanded">expandable</span>
          </Show>
        </div>
      </Show>
      {/* An Ingress/HTTPRoute/IngressRoute routing table (match → backend) — the network view's entry
          point, so it should say where external traffic goes without opening the manifest. */}
      <Show when={(props.node.routes?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.routes}>{(r) => <code class="route-row">{r}</code>}</For>
        </div>
      </Show>
      {/* A Role/ClusterRole's grants ("resources: verbs") — the whole point of the resource,
          surfaced for the RBAC view instead of buried in the manifest. A rule granting the `*` verb
          can do ANYTHING to its resources (the cluster-admin shape), so it carries a caution tint and
          an explicit "wildcard" tag — the over-privilege an auditor scans for, made to look different
          (contrast) rather than hiding as one more identical row. */}
      <Show when={(props.node.rules?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.rules}>
            {(r) => {
              const broad = ruleHasWildcardVerb(r)
              return (
                <code class="route-row" classList={{ 'route-priv': broad }} title={broad ? 'This rule allows every action on its resources' : undefined}>
                  <Show when={broad}>
                    <span class="route-priv-tag">wildcard</span>
                  </Show>
                  {r}
                </code>
              )
            }}
          </For>
        </div>
      </Show>
      {/* A NetworkPolicy's essence for "why can't A reach B": which pods it targets and, per governed
          direction, whether it denies all or allows N rule-sets — otherwise buried in the manifest.
          Same route-row idiom as Role rules / Ingress routes (repetition). */}
      <Show when={(props.node.netpol?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.netpol}>{(r) => <code class="route-row">{r}</code>}</For>
        </div>
      </Show>
      {/* A ServiceMonitor/VMServiceScrape's scrape target: which services it selects and each
          endpoint's port/path/interval — the "what does this scrape, how often" answer for a metrics
          gap, otherwise buried in the manifest. Same route-row idiom (repetition). */}
      <Show when={(props.node.scrapes?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.scrapes}>{(r) => <code class="route-row">{r}</code>}</For>
        </div>
      </Show>
      {/* A binding's target role and grantees: User/Group subjects have no node, so this is the
          only place they're visible — the "who got access" answer for an RBAC audit. Each row
          prepends the kind's icon so Role/CR vs User/Group/SA reads at a glance, matching the
          card / drawer / owner-chip pattern. */}
      <Show when={props.node.roleRef || (props.node.subjects?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <Show when={props.node.roleRef}>
            <code class="route-row">
              <span class="route-arrow">→</span>
              <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                {kindIcon(kindFromRef(props.node.roleRef!))}
              </svg>
              {props.node.roleRef}
            </code>
          </Show>
          <For each={props.node.subjects}>
            {(s) => (
              <code class="route-row">
                <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                  {kindIcon(kindFromRef(s))}
                </svg>
                {s}
              </code>
            )}
          </For>
        </div>
      </Show>
      {/* A ConfigMap/Secret's data keys ("key · size") — the "what does this hold?" answer, the
          declarative essence the manifest otherwise buries (mirrors routes/rules for Ingress/Role). A
          Secret leads with its type (the operationally-important classifier: tls vs dockerconfigjson vs
          Opaque). NEVER values — only key names + sizes, strictly less than the RBAC-gated Manifest tab. */}
      <Show when={props.node.secretType || (props.node.dataKeys?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <Show when={props.node.secretType}>
            <code class="route-row secret-type" title="Secret type">
              <span class="addr-label">type</span>
              {props.node.secretType}
            </code>
          </Show>
          <For each={props.node.dataKeys}>{(k) => <KeyValRow row={k} />}</For>
        </div>
      </Show>
      {/* A ResourceQuota's consumption ("resource · used / hard") — the only fact an operator wants
          from a quota: how much room is left. Reuses the data-key row idiom (name bright, numbers
          dim) so quota rows read like every other key/value chip. */}
      <Show when={(props.node.quotaUsage?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.quotaUsage}>
            {(row) => <KeyValRow row={row} title="Used / limit in this namespace" />}
          </For>
        </div>
      </Show>
      {/* A Pod's per-container cards (status + usage + image — see ContainerCards). Workloads expose
          no per-container runtime, so they fall back to the distinct image list. */}
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
      <Show when={props.owners.length > 0}>
        <div class="drawer-owners">
          <For each={props.owners}>
            {(o) => (
              <button class="owner-chip" onClick={() => props.onNavigate(o.id)} title={`Go to ${o.kind} ${o.name}`}>
                <span class="owner-arrow">↑</span>
                <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                  {kindIcon(o.kind)}
                </svg>
                {o.kind} <span class="owner-name">{o.name}</span>
              </button>
            )}
          </For>
        </div>
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
