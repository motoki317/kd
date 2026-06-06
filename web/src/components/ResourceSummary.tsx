import { createMemo, For, Show } from 'solid-js'
import { formatQuantity } from '../capacityLayout'
import { healthColor, healthHint } from '../health'
import { kindFromRef, kindIcon } from '../icons'
import { shortNodeName } from '../names'
import { ruleHasWildcardVerb } from '../rbac'
import { relativeAge } from '../time'
import type { ContainerStatus, Health, KNode, Resources, ResourceUsage } from '../types'
import CopyButton from './CopyButton'

// containerHealth maps a container's runtime state to the shared Health enum so its dot uses the
// same colors as the rest of the UI: a crash-loop or non-Completed exit is Degraded, a not-yet-ready
// Running container is Progressing, a completed init container is Healthy (done).
function containerHealth(cs: ContainerStatus): Health {
  if (cs.state.startsWith('Waiting:')) return 'Degraded'
  if (cs.state.startsWith('Terminated:')) return cs.state.includes('Completed') ? 'Healthy' : 'Degraded'
  if (cs.state === 'Running') return cs.ready ? 'Healthy' : 'Progressing'
  return 'Unknown'
}

// endpointHealth colors a Service's endpoint readout like everything else: no backends at all is a
// Degraded misconfiguration (selector matches nothing), some-but-not-all ready is Progressing (a
// rollout), and fully ready is Healthy.
function endpointHealth(ep: { ready: number; total: number }): Health {
  if (ep.total === 0) return 'Degraded'
  if (ep.ready < ep.total) return 'Progressing'
  return 'Healthy'
}

// isFloatingImageTag returns true when the image reference isn't pinned to an immutable revision:
// no tag at all (implicit :latest), explicit :latest, or "stable"/"main"/"edge" — common moving
// pointers. A digest reference (@sha256:…) is always treated as pinned. Used to surface a quiet
// warning in the drawer so operators can spot images that can drift across restarts.
export function isFloatingImageTag(img: string): boolean {
  if (img.includes('@sha256:')) return false
  // Tag is everything after the last ":" that isn't a port — but registry paths can include a port,
  // e.g. "registry:5000/foo/bar:1.2.3". Split off any path first to make the ":port" case impossible
  // in the segment we inspect.
  const lastSlash = img.lastIndexOf('/')
  const tail = lastSlash >= 0 ? img.slice(lastSlash + 1) : img
  const colon = tail.lastIndexOf(':')
  if (colon < 0) return true // no tag → implicit :latest
  const tag = tail.slice(colon + 1).toLowerCase()
  return tag === 'latest' || tag === 'stable' || tag === 'main' || tag === 'master' || tag === 'edge'
}

// parseImageRef splits an image reference into the registry/path prefix (infra noise — usually the
// same across every container in a cluster), the repository name, and the tag-or-digest. The drawer
// dims the prefix and emphasises the tag so the operator's first question — "which version is
// running?" — reads at a glance instead of hiding at the end of a long ECR/GCR URL. Mirrors the
// registry split in isFloatingImageTag (path first, so a "registry:5000" port is never a false tag).
export function parseImageRef(img: string): { prefix: string; name: string; tag: string } {
  const lastSlash = img.lastIndexOf('/')
  const prefix = lastSlash >= 0 ? img.slice(0, lastSlash + 1) : ''
  const tail = lastSlash >= 0 ? img.slice(lastSlash + 1) : img
  // A digest pin (name@sha256:…) wins over a tag; keep the whole "@sha256:…" as the emphasised part.
  const at = tail.indexOf('@')
  if (at >= 0) return { prefix, name: tail.slice(0, at), tag: tail.slice(at) }
  const colon = tail.indexOf(':')
  if (colon >= 0) return { prefix, name: tail.slice(0, colon), tag: tail.slice(colon) }
  return { prefix, name: tail, tag: '' }
}

// ImageRef renders one image reference — dim registry/path prefix, normal repo name, emphasised
// tag/digest — plus the floating-tag warning and a copy button that yanks the FULL ref. Shared by the
// per-container cards and the workload image list so both read identically (one place to evolve).
function ImageRef(props: { image: string; wrapClass: string }) {
  const parts = createMemo(() => parseImageRef(props.image))
  return (
    <div class={props.wrapClass} title={props.image}>
      <code class="image-ref">
        <span class="image-ref-prefix">{parts().prefix}</span>
        {parts().name}
        <span class="image-ref-tag">{parts().tag}</span>
      </code>
      <Show when={isFloatingImageTag(props.image)}>
        <span
          class="image-floating-tag"
          title="Image lacks a pinned digest or version tag — rolling restart can change the running image"
        >
          floating tag
        </span>
      </Show>
      <CopyButton text={() => props.image} title="Copy image" />
    </div>
  )
}

// MetaChip is the drawer's "labelled fact" idiom: a dim `addr-label` next to a bright `<code>` value,
// shared by every kind-spec block (PVC access/class, Job runtime, HPA scale, PDB policy, StorageClass)
// so they read as one visual language (Repetition) and a new essence field is a one-liner instead of a
// copy-pasted 4-line span. `class` appends a state modifier on the same `port-addr` element the bare
// blocks used (e.g. `port-failed` for a degraded count, `port-caution` for an operationally critical 0).
function MetaChip(props: { label: string; value: string | number; title: string; class?: string }) {
  return (
    <span class="port-addr" classList={props.class ? { [props.class]: true } : undefined} title={props.title}>
      <span class="addr-label">{props.label}</span>
      <code>{props.value}</code>
    </span>
  )
}

// containerGroups splits a pod's container statuses into the two groups operators reason about
// separately: init containers (run once, in order, before the app starts) and the long-running app
// containers. Each carries a header label; order within a group is the server's (execution order).
// Returned even when empty so the caller can render the section headers conditionally.
function containerGroups(statuses: ContainerStatus[]): { label: string; items: ContainerStatus[] }[] {
  return [
    { label: 'Init containers', items: statuses.filter((c) => c.init) },
    { label: 'Containers', items: statuses.filter((c) => !c.init) },
  ]
}

interface Props {
  node: KNode
  owners: KNode[]
  onNavigate: (id: string) => void
  // Optional "Kind/name" → select navigator; lets the host meta jump to its Node when present.
  onNavigateRef?: (kindSlashName: string) => boolean
  // Live metrics-server consumption for this resource (Pods), keyed into by the drawer from the
  // capacity feed. Absent when metrics-server is unavailable or the kind isn't a Pod.
  usage?: ResourceUsage
}

// A compact usage gauge per resource: the live value fills toward the request/limit reference, with a
// faint tick at the other bound, so an operator sees "is this pod near its limit / over its request" at
// a glance — the metrics-server read otherwise reachable only via `kubectl top`. Returns null when the
// resource has neither a usage value nor a request/limit (nothing to gauge).
function metricBar(use: number | undefined, req: number | undefined, lim: number | undefined, res: 'cpu' | 'memory') {
  if (use == null && req == null && lim == null) return null
  const u = use ?? 0
  // Gauge against the limit (the hard ceiling) when set, else the request. With NEITHER set the bar has
  // no meaningful denominator — a full bar would falsely read as "maxed" — so the row shows the value
  // alone (unconstrained).
  const ceil = lim ?? req
  const unconstrained = ceil == null
  const track = Math.max(u, ceil ?? u, 1)
  const pct = (v: number | undefined) => (v == null ? null : Math.min(100, (v / track) * 100))
  // Only a real LIMIT breach is alarming (throttle/OOM); bursting past a request when no limit exists is
  // expected, so it stays the neutral accent — over-colouring normal bursting would cry wolf.
  const over = lim != null && u > lim
  const nearLimit = lim != null && u >= 0.9 * lim && u <= lim
  return {
    res,
    unconstrained,
    fillPct: unconstrained ? 0 : pct(u) ?? 0,
    // The request reads as a distinct tick only when the limit is the gauge (else request IS the ceiling).
    reqPct: lim != null ? pct(req) : null,
    over,
    nearLimit,
    // Explicit values (explicit over implicit): the live use bright, the bounds dim. The reference shown
    // is the ceiling the bar gauges against — limit when set, else request.
    use: formatQuantity(use, res),
    ref: lim != null ? `${formatQuantity(lim, res)} lim` : req != null ? `${formatQuantity(req, res)} req` : null,
  }
}

// PodMetrics renders the CPU + memory usage gauges for a Pod when metrics are present. Each row aligns
// a fixed label, the bar, and a right-aligned value (Alignment + Proximity: the number sits with its
// bar); the fill borrows the health palette under pressure (Contrast) so an over-request or near-limit
// pod pulls the eye.
function PodMetrics(props: { usage: ResourceUsage; requests?: Resources; limits?: Resources }) {
  const rows = createMemo(() =>
    [
      metricBar(props.usage.cpuMilli, props.requests?.cpuMilli, props.limits?.cpuMilli, 'cpu'),
      metricBar(props.usage.memBytes, props.requests?.memBytes, props.limits?.memBytes, 'memory'),
    ].filter((r): r is NonNullable<typeof r> => r !== null),
  )
  const LABEL: Record<'cpu' | 'memory', string> = { cpu: 'CPU', memory: 'Mem' }
  return (
    <Show when={rows().length > 0}>
      <div class="pod-metrics" role="group" aria-label="Live resource usage">
        <For each={rows()}>
          {(r) => (
            <div class="metric-row">
              <span class="metric-label">{LABEL[r.res]}</span>
              {/* Unconstrained (no request/limit): an empty track + a dim "no limit set" note rather than
                  a misleading full bar — the operator sees the value isn't being gauged against anything. */}
              <div class="metric-bar" classList={{ unconstrained: r.unconstrained }} title={r.ref ? `${r.use} used · ${r.ref}` : `${r.use} used · no request/limit set`}>
                <Show when={!r.unconstrained}>
                  <div class="metric-fill" classList={{ over: r.over, near: r.nearLimit }} style={{ width: `${r.fillPct}%` }} />
                  <Show when={r.reqPct != null}>
                    <div class="metric-tick metric-tick-req" style={{ left: `${r.reqPct}%` }} />
                  </Show>
                </Show>
              </div>
              <span class="metric-val">
                <b>{r.use}</b>
                <span class="metric-ref"> / {r.ref ?? 'unset'}</span>
              </span>
            </div>
          )}
        </For>
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
              style={{ color: props.node.health === 'Healthy' ? 'var(--text-dim)' : healthColor(props.node.health) }}
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
            {relativeAge(props.node.createdAt!)} old
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
      {/* Live CPU/memory usage gauges (metrics-server) — the "is this pod hot / near its limit" answer
          the operator otherwise gets only from `kubectl top`. Shown for a Pod when usage is present;
          absent when metrics-server is unavailable. */}
      <Show when={props.usage && props.node.kind === 'Pod'}>
        <PodMetrics usage={props.usage!} requests={props.node.requests} limits={props.node.limits} />
      </Show>
      {/* A Service's reachable address and port mappings — the network view's core question
          ("what routes here, on which port?"), otherwise buried in the manifest. The address
          is copyable for pasting into a curl/port-forward. */}
      <Show when={props.node.clusterIP || props.node.externalIP || (props.node.ports?.length ?? 0) > 0}>
        <div class="drawer-ports">
          <Show when={props.node.clusterIP}>
            <span class="port-addr">
              <code>{props.node.clusterIP}</code>
              <CopyButton text={() => props.node.clusterIP!} title="Copy address" />
            </span>
          </Show>
          {/* For a LoadBalancer/NodePort service the external address is the actual "reach it from
              outside" answer the cluster IP can't give — surface it labelled, and copyable unless
              it's still "pending" (no address assigned yet). */}
          <Show when={props.node.externalIP}>
            <span class="port-addr port-ext" title="External address (LoadBalancer / externalIPs)">
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
            <MetaChip label="last run" value={`${relativeAge(props.node.lastRun!)} ago`} title="Last schedule time" />
          </Show>
          <Show when={(props.node.active ?? 0) > 0}>
            <MetaChip label="active" value={props.node.active!} title="Running now" />
          </Show>
          <Show when={(props.node.failed ?? 0) > 0}>
            <MetaChip label="failed" value={props.node.failed!} title="Failed pods" class="port-failed" />
          </Show>
        </div>
      </Show>
      {/* An HPA's scale state: how many replicas it's running (with a → arrow mid-scale) and the
          min–max bounds it works within — "is it at the ceiling?". Labelled chips beside the status,
          reusing the address-row idiom. The HPA→target edge already shows what it scales. */}
      <Show when={props.node.scaleReplicas || props.node.scaleRange}>
        <div class="drawer-ports">
          <Show when={props.node.scaleReplicas}>
            <MetaChip label="replicas" value={props.node.scaleReplicas!} title="Current replicas (→ desired while scaling)" />
          </Show>
          <Show when={props.node.scaleRange}>
            <MetaChip label="range" value={props.node.scaleRange!} title="Min–max replica bounds" />
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
              title="Voluntary evictions allowed right now (0 → a node drain will block here)"
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
          <MetaChip label="taints" value={props.node.taints!} title="Taints — a pod needs a matching toleration to schedule here" class="port-caution" />
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
            <MetaChip label="reclaim" value={props.node.reclaimPolicy!} title="Reclaim policy — what happens to the PV when its PVC is deleted" />
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
                <code class="route-row" classList={{ 'route-priv': broad }} title={broad ? 'Wildcard verb — this rule grants every action on its resources' : undefined}>
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
          <For each={props.node.dataKeys}>
            {(k) => {
              // Server sends "key · size"; split so the key reads bright and its size dim + right-aligned
              // (Contrast + Alignment — the same value/capacity treatment the node bars use).
              const sep = k.lastIndexOf(' · ')
              return sep < 0 ? (
                <code class="route-row">{k}</code>
              ) : (
                <code class="route-row data-key">
                  <span class="data-key-name">{k.slice(0, sep)}</span>
                  <span class="data-key-size">{k.slice(sep + 3)}</span>
                </code>
              )
            }}
          </For>
        </div>
      </Show>
      {/* Containers (cycle 338): a Pod's per-container runtime state and its image belong together —
          "which container is broken and what's it running?" — so each container is one card pairing
          status (dot + state + restarts) with its image, grouped into Init vs app containers with
          counts so "how many of each, what images, are they OK" reads at a glance. A floating tag
          (":latest"/none) flags an image a rolling restart could silently change. Workloads expose no
          per-container runtime, so they fall back to the distinct image list. */}
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
        <div class="drawer-containers">
          <For each={containerGroups(props.node.containerStatuses ?? [])}>
            {(group) => (
              <Show when={group.items.length > 0}>
                <div class="container-group">
                  <div class="container-group-head">
                    {group.label}
                    <span class="container-group-count">{group.items.length}</span>
                  </div>
                  <For each={group.items}>
                    {(cs) => (
                      <div
                        class="container-card"
                        classList={{
                          'not-ready': !cs.ready && !cs.init,
                          [`h-${containerHealth(cs).toLowerCase()}`]: true,
                        }}
                      >
                        <div class="container-card-head">
                          <span class="dot" style={{ background: healthColor(containerHealth(cs)) }} />
                          <span class="container-name">{cs.name}</span>
                          <span class="container-state" style={{ color: healthColor(containerHealth(cs)) }}>
                            {cs.state}
                          </span>
                          <Show when={(cs.restarts ?? 0) > 0}>
                            <span class="container-restarts" title={`${cs.restarts} restarts`}>
                              ↻ {cs.restarts}
                            </span>
                          </Show>
                        </div>
                        <Show when={cs.lastTerminated}>
                          {/* Why it previously exited — surfaced inline next to the restart count so an
                              operator sees "OOMKilled" without digging into the manifest's lastState. */}
                          <div class="container-last-terminated" title="Reason the container previously exited (its last restart)">
                            last exit: {cs.lastTerminated}
                          </div>
                        </Show>
                        <Show when={cs.image}>
                          <ImageRef image={cs.image!} wrapClass="container-image" />
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </For>
        </div>
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
                  title={`Click to copy ${k}${v ? `=${v}` : ''}${v ? ' · Shift+click for value only' : ''}`}
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
