import { createMemo, For, Show } from 'solid-js'
import { healthColor } from '../health'
import { kindFromRef, kindIcon } from '../icons'
import { relativeAge } from '../time'
import type { ContainerStatus, Health, KNode } from '../types'
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

interface Props {
  node: KNode
  owners: KNode[]
  onNavigate: (id: string) => void
  // Optional "Kind/name" → select navigator; lets the host meta jump to its Node when present.
  onNavigateRef?: (kindSlashName: string) => boolean
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
    <div>
      <div class="drawer-kind">
        <span class="dot" style={{ background: healthColor(props.node.health) }} />
        {/* Same silhouette as the topology card so the drawer reads as the "expanded view" of
            the resource you clicked — visual continuity across click. */}
        <svg class="drawer-kind-icon" viewBox="0 0 14 14" width="13" height="13" aria-hidden="true">
          {kindIcon(props.node.kind)}
        </svg>
        {props.node.kind}
      </div>
      <div class="drawer-name">
        {props.node.name}
        <CopyButton text={() => props.node.name} title="Copy name" />
      </div>
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
              on {props.node.host}
            </button>
          ) : (
            <span class="drawer-age">on {props.node.host}</span>
          )}
        </Show>
        <Show when={props.node.capacity}>
          <span class="drawer-age">{props.node.capacity}</span>
        </Show>
      </div>
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
      {/* An Ingress's routing table (host/path → backend) — the network view's entry point, so
          it should say where external traffic goes without opening the manifest. */}
      <Show when={(props.node.routes?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.routes}>{(r) => <code class="route-row">{r}</code>}</For>
        </div>
      </Show>
      {/* A Role/ClusterRole's grants ("resources: verbs") — the whole point of the resource,
          surfaced for the RBAC view instead of buried in the manifest. */}
      <Show when={(props.node.rules?.length ?? 0) > 0}>
        <div class="drawer-routes">
          <For each={props.node.rules}>{(r) => <code class="route-row">{r}</code>}</For>
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
      {/* The image(s) are usually the first thing checked ("what version is live?"), so
          surface them prominently with per-image copy for pasting into kubectl/registry. */}
      <Show when={(props.node.images?.length ?? 0) > 0}>
        <div class="drawer-images">
          <For each={props.node.images}>
            {(img) => (
              <div class="drawer-image" title={img}>
                <code>{img}</code>
                <CopyButton text={() => img} title="Copy image" />
              </div>
            )}
          </For>
        </div>
      </Show>
      {/* Per-container state so a multi-container pod reveals which container is unready or
          crash-looping, not just an aggregate restart count. */}
      <Show when={(props.node.containerStatuses?.length ?? 0) > 0}>
        <div class="drawer-containers">
          <For each={props.node.containerStatuses}>
            {(cs) => (
              <div class="container-row" classList={{ 'not-ready': !cs.ready && !cs.init }}>
                <span class="dot" style={{ background: healthColor(containerHealth(cs)) }} />
                <span class="container-name">
                  {cs.name}
                  <Show when={cs.init}>
                    <span class="container-init"> init</span>
                  </Show>
                </span>
                <span class="container-state">{cs.state}</span>
                <Show when={(cs.restarts ?? 0) > 0}>
                  <span class="container-restarts" title={`${cs.restarts} restarts`}>
                    ↻ {cs.restarts}
                  </span>
                </Show>
              </div>
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
      {/* Collapsible so a Helm-managed resource's label noise can be tucked away, but open
          by default since labels are usually what the operator came to check. */}
      <Show when={labels().length > 0}>
        <details class="drawer-labels" open>
          <summary>Labels · {labels().length}</summary>
          <div class="label-chips">
            <For each={labels()}>
              {([k, v]) => (
                <span class="label-chip" title={`${k}=${v}`}>
                  <span class="label-key">{k}</span>
                  <Show when={v}>
                    <span class="label-val">{v}</span>
                  </Show>
                </span>
              )}
            </For>
          </div>
        </details>
      </Show>
    </div>
  )
}
