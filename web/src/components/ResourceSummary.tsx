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
      {/* Drawer "hero" header (cycle 128): a card-sized kind silhouette plus the kind label and
          name stacked beside it — mirrors the topology card's icon-forward design so the drawer
          reads as the "blown up" version of the card you just clicked. The icon's host <g> picks
          up the health color (.health-tint*) so the hero pops in the row even before the eye
          reads the kind text or name. */}
      <div class="drawer-hero" classList={{ [`health-tint-${props.node.health.toLowerCase()}`]: true }}>
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
        </div>
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
              <For each={props.node.images}>
                {(img) => (
                  <div class="drawer-image" title={img}>
                    <code>{img}</code>
                    <Show when={isFloatingImageTag(img)}>
                      <span
                        class="image-floating-tag"
                        title="Image lacks a pinned digest or version tag — rolling restart can change the running image"
                      >
                        floating tag
                      </span>
                    </Show>
                    <CopyButton text={() => img} title="Copy image" />
                  </div>
                )}
              </For>
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
                        <Show when={cs.image}>
                          <div class="container-image" title={cs.image}>
                            <code>{cs.image}</code>
                            <Show when={isFloatingImageTag(cs.image!)}>
                              <span
                                class="image-floating-tag"
                                title="Image lacks a pinned digest or version tag — rolling restart can change the running image"
                              >
                                floating tag
                              </span>
                            </Show>
                            <CopyButton text={() => cs.image!} title="Copy image" />
                          </div>
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
      {/* Collapsible so a Helm-managed resource's label noise can be tucked away, but open
          by default since labels are usually what the operator came to check. */}
      <Show when={labels().length > 0}>
        <details class="drawer-labels" open>
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
