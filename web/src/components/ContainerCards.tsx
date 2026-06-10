import { For, Show } from 'solid-js'
import { formatQuantity } from '../capacityLayout'
import { healthColor, healthTextColor } from '../health'
import type { ContainerStatus, Health, ResourceUsage } from '../types'
import ImageRef from './ImageRef'

// containerHealth maps a container's runtime state to the shared Health enum so its dot uses the
// same colors as the rest of the UI: a crash-loop or non-Completed exit is Degraded, a not-yet-ready
// Running container is Progressing. A clean exit (Terminated: Completed) is NOT Healthy here — green
// is reserved for a live, ready container (see containerDot); it resolves to Unknown and is recoloured.
function containerHealth(cs: ContainerStatus): Health {
  if (cs.state.startsWith('Waiting:')) return 'Degraded'
  if (cs.state.startsWith('Terminated:')) return cs.state.includes('Completed') ? 'Unknown' : 'Degraded'
  if (cs.state === 'Running') return cs.ready ? 'Healthy' : 'Progressing'
  return 'Unknown'
}

// isDone is a container that exited cleanly (a completed init container, or a Job/CronJob pod's main
// container after success). It is finished, not running — so it reads as a neutral gray "done", never
// the live green that an operator scans for to mean "this is up right now".
function isDone(cs: ContainerStatus): boolean {
  return cs.state.startsWith('Terminated:') && cs.state.includes('Completed')
}

// containerDot returns the dot/state colours and the card's status class in lockstep, so a completed
// container is gray everywhere on its card. A done container is gray (--text-dim); everything else
// uses its health hue — the dot vivid, the state TEXT in the darker text ink (see healthTextColor).
function containerDot(cs: ContainerStatus): { color: string; text: string; cls: string } {
  if (isDone(cs)) return { color: 'var(--text-dim)', text: 'var(--text-dim)', cls: 'done' }
  const h = containerHealth(cs)
  return { color: healthColor(h), text: healthTextColor(h), cls: `h-${h.toLowerCase()}` }
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

// CONTAINER_PALETTE colours the per-container segments of the pod usage bars and the matching card
// swatches. First slot is the accent so a stack's lead segment matches the single-fill colour a
// one-container pod draws; the rest are mid-tone hues picked to stay clear of the health vocabulary
// (no green/red/amber — a segment colour must never read as a status) and legible on both themes.
const CONTAINER_PALETTE = ['var(--accent)', '#9a6cf0', '#18a999', '#d6609a', '#7a8699', '#2aa3c8']

// paletteColor cycles the palette — also used directly by the workload gauge, whose drawer has no
// container cards (no swatches to join), so position alone keys its segment colours.
export function paletteColor(i: number): string {
  return CONTAINER_PALETTE[i % CONTAINER_PALETTE.length]
}

// containerColorMap assigns each container its palette colour by position in the pod's container
// order (init first, then app — the order the cards render in), so the bar segments and the card
// swatches agree without threading indices around. Stable while the pod exists; palette cycles past
// six containers.
export function containerColorMap(statuses: ContainerStatus[]): Map<string, string> {
  const m = new Map<string, string>()
  statuses.forEach((cs, i) => m.set(cs.name, paletteColor(i)))
  return m
}

// BoundsCell renders one resource's declared bounds with each number explicitly labelled —
// "cpu req 10m · lim 500m" — because a bare "10m / 500m" reads like the gauges' usage-vs-bound
// pairs and leaves which side is the request ambiguous (user feedback). Undeclared sides are
// simply omitted (no "—"/"unset" placeholders): the row states what the spec states, nothing more.
// Each side formats independently: these are the operator's own spec'd numbers, so "512Mi · 1Gi"
// reads as written, no unit normalisation.
function BoundsCell(props: { label: string; req?: number; lim?: number; res: 'cpu' | 'memory' }) {
  return (
    <>
      <span class="container-usage-label">{props.label}</span>
      <Show when={props.req}>
        <span class="container-usage-label">req</span>
        <span class="container-usage-val">{formatQuantity(props.req!, props.res)}</span>
      </Show>
      <Show when={props.req && props.lim}>
        <span class="container-usage-sep">·</span>
      </Show>
      <Show when={props.lim}>
        <span class="container-usage-label">lim</span>
        <span class="container-usage-val">{formatQuantity(props.lim!, props.res)}</span>
      </Show>
    </>
  )
}

// ContainerCards is a Pod's per-container section (cycle 338): runtime state and image belong
// together — "which container is broken and what's it running?" — so each container is one card
// pairing status (dot + state + restarts) with its declared bounds, last exit, and image, grouped
// into Init vs app containers with counts so "how many of each, what images, are they OK" reads at
// a glance. LIVE usage is NOT repeated here — the pod gauge above stacks one coloured segment per
// container, joined to its card by the swatch next to the name. A floating tag (":latest"/none)
// flags an image a rolling restart could silently change.
export default function ContainerCards(props: { statuses: ContainerStatus[]; usage?: ResourceUsage }) {
  const colors = () => containerColorMap(props.statuses)
  // Swatches only when the bars actually stack (a breakdown exists): a colour key without coloured
  // segments to join to is noise.
  const hasSegments = () => (props.usage?.containers?.length ?? 0) > 1
  const usageFor = (name: string) => props.usage?.containers?.find((c) => c.name === name)
  return (
    <div class="drawer-containers">
      <For each={containerGroups(props.statuses)}>
        {(group) => (
          <Show when={group.items.length > 0}>
            <div class="container-group">
              <div class="container-group-head">
                {group.label}
                <span class="container-group-count">{group.items.length}</span>
              </div>
              <For each={group.items}>
                {(cs) => {
                  const dot = containerDot(cs)
                  // A Running container that isn't ready is failing its readiness probe — say so
                  // in words (explicit over implicit): the blue dot alone doesn't explain why the
                  // pod shows 0/1 and the Service routes nothing to it.
                  const notReady = cs.state === 'Running' && !cs.ready && !cs.init
                  // The one per-container emergency worth words on the card: memory over 90% of its
                  // own limit means an OOM kill is imminent — a fact the pod-total gauge can hide
                  // when another container has headroom. Live-checked against the usage feed even
                  // though the card otherwise shows only declared bounds.
                  const nearMemLimit = () => {
                    const cu = usageFor(cs.name)
                    return cu && cs.memLimitBytes ? (cu.memBytes ?? 0) / cs.memLimitBytes >= 0.9 : false
                  }
                  const hasBounds = cs.cpuRequestMilli || cs.cpuLimitMilli || cs.memRequestBytes || cs.memLimitBytes
                  return (
                    <div
                      class="container-card"
                      classList={{
                        'not-ready': !cs.ready && !cs.init && !isDone(cs),
                        [dot.cls]: true,
                      }}
                    >
                      <div class="container-card-head">
                        <span class="dot" style={{ background: dot.color }} />
                        <span class="container-name">{cs.name}</span>
                        {/* The colour key to this container's segment in the usage bars above — a
                            square so it never reads as a (round) health dot. Only rendered when the
                            container has a reading, i.e. a segment exists to point at. */}
                        <Show when={hasSegments() && usageFor(cs.name)}>
                          <span
                            class="container-swatch"
                            style={{ background: colors().get(cs.name) }}
                            title="This container's colour in the usage bars above"
                          />
                        </Show>
                        <span
                          class="container-state"
                          style={{ color: dot.text }}
                          title={notReady ? 'Running, but not passing its readiness probe — Services send it no traffic' : undefined}
                        >
                          {cs.state}
                          {notReady ? ' · not ready' : ''}
                        </span>
                        <Show when={(cs.restarts ?? 0) > 0}>
                          <span class="container-restarts" title={`${cs.restarts} restarts`}>
                            ↻ {cs.restarts}
                          </span>
                        </Show>
                      </div>
                      {/* The container's own declared bounds — "what did it reserve / what may it
                          burst to". Live usage lives in the pod gauge's coloured segments above, so
                          this row stays spec-only and the card doesn't repeat moving numbers. */}
                      <Show when={hasBounds}>
                        <div
                          class="container-usage"
                          title="Declared resources — req: reserved for scheduling · lim: the ceiling (memory past it is OOM-killed)"
                        >
                          <Show when={cs.cpuRequestMilli || cs.cpuLimitMilli}>
                            <BoundsCell label="cpu" req={cs.cpuRequestMilli} lim={cs.cpuLimitMilli} res="cpu" />
                          </Show>
                          <Show when={(cs.cpuRequestMilli || cs.cpuLimitMilli) && (cs.memRequestBytes || cs.memLimitBytes)}>
                            <span class="container-usage-sep">|</span>
                          </Show>
                          <Show when={cs.memRequestBytes || cs.memLimitBytes}>
                            <BoundsCell label="mem" req={cs.memRequestBytes} lim={cs.memLimitBytes} res="memory" />
                          </Show>
                        </div>
                      </Show>
                      <Show when={nearMemLimit()}>
                        <div
                          class="container-near-limit"
                          title="Live usage from metrics-server, gauged against this container's own memory limit"
                        >
                          mem {formatQuantity(usageFor(cs.name)!.memBytes ?? 0, 'memory')} — over 90% of its limit, at
                          risk of OOM kill
                        </div>
                      </Show>
                      <Show when={cs.lastTerminated}>
                        {/* Why it previously exited — surfaced inline next to the restart count so an
                            operator sees "OOMKilled" without digging into the manifest's lastState. */}
                        <div class="container-last-terminated" title="Why the container last restarted">
                          last exit: {cs.lastTerminated}
                        </div>
                      </Show>
                      <Show when={cs.image}>
                        <ImageRef image={cs.image!} wrapClass="container-image" />
                      </Show>
                    </div>
                  )
                }}
              </For>
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}
