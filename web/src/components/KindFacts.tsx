import { For, Show } from 'solid-js'
import { useNow } from '../clock'
import { healthColor } from '../health'
import { kindFromRef, kindIcon } from '../icons'
import { ruleHasWildcardVerb } from '../rbac'
import { relativeAge, relativeUntil } from '../time'
import type { Health, KNode } from '../types'
import CopyButton from './CopyButton'

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

// KindFacts is the drawer's per-kind "declarative essence" section — the spec facts each kind's
// operators actually ask for (a Service's address/ports/selector, an Ingress's routes, a Role's
// rules, a PDB's policy, a ConfigMap's keys…), each block a Show gated on the server-extracted
// field. It is the presentation counterpart of the server's spec.go extractors: one chip/row idiom
// (MetaChip / KeyValRow / route-row) per fact, so adding a kind's essence stays a one-block change
// here + one extractor there (see the recipe in internal/kube/graph/spec.go).
export default function KindFacts(props: { node: KNode }) {
  return (
    <>
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
      {/* A cert-manager Certificate's essence: which names it secures (the first question at a TLS
          failure), which issuer signs it (the staging-vs-prod mix-up), and when it expires —
          "expires in 84d", relative like the restart dates. An expired/failed cert alarms via its
          Ready-condition health; these chips carry the facts, not the alarm. */}
      <Show when={props.node.certNames || props.node.certIssuer || props.node.certExpiry}>
        <div class="drawer-ports">
          <Show when={props.node.certNames}>
            <MetaChip label="for" value={props.node.certNames!} title="Names this certificate secures (commonName + dnsNames)" />
          </Show>
          <Show when={props.node.certExpiry}>
            {(() => {
              // A live cert expires in the future ("in 84d"); a renewal-failed cert is already past
              // its notAfter, where "in 0s" reads as nonsense on the red card. Flip to "expired Nd
              // ago" with the caution tint so the debugging moment (a TLS error) names the cause.
              const expired = () => new Date(props.node.certExpiry!).getTime() < useNow().getTime()
              return (
                <MetaChip
                  label={expired() ? 'status' : 'expires'}
                  value={expired() ? `expired ${relativeAge(props.node.certExpiry!, useNow())} ago` : `in ${relativeUntil(props.node.certExpiry!, useNow())}`}
                  title="Certificate validity end (status.notAfter) — cert-manager renews before this"
                  class={expired() ? 'port-failed' : undefined}
                />
              )
            })()}
          </Show>
          <Show when={props.node.certIssuer}>
            <MetaChip label="issuer" value={props.node.certIssuer!} title="Issuer that signs this certificate" />
          </Show>
        </div>
      </Show>
      {/* A cert-manager Issuer/ClusterIssuer's backing CA — "what actually signs my certs?". The
          ACME staging endpoint issues UNTRUSTED certs (the #1 cert-manager mistake), so a staging
          issuer wears the caution tint to make the prod-vs-staging distinction unmissable. */}
      <Show when={props.node.issuerConfig}>
        <div class="drawer-ports">
          <MetaChip
            label="issues via"
            value={props.node.issuerConfig!}
            title="The certificate authority this issuer signs with"
            class={props.node.issuerConfig!.includes('untrusted') ? 'port-caution' : undefined}
          />
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
            {/* "· at max" = ScalingLimited/TooManyReplicas: demand exceeds the ceiling while
                everything still reads green — caution-tint it so the saturation is explicit. */}
            <MetaChip
              label="replicas"
              value={props.node.scaleReplicas!}
              title={
                props.node.scaleReplicas!.includes('at max')
                  ? 'Demand wants more replicas than maxReplicas allows — the workload may be saturated; raise the ceiling if this persists'
                  : 'Running replicas — shows the target while scaling'
              }
              class={props.node.scaleReplicas!.includes('at max') ? 'port-caution' : undefined}
            />
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
    </>
  )
}
