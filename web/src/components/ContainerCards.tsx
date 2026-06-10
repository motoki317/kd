import { For, Show } from 'solid-js'
import { formatPair, type CapResource } from '../capacityLayout'
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

// ContainerUsageCell renders one resource's live "value / limit" on a container card — the gauge
// idiom (value bright, bound dim), bare value when the container declares no limit. formatPair keeps
// both sides in ONE unit; for CPU the unit follows the SMALLER nonzero side so a 2m draw under a
// 2-core limit reads "2m / 2000m", not the rounded-away "0 / 2" (integer-core rounding eats small
// draws). Memory keeps the LIMIT's unit: its one decimal keeps a small draw visible ("0.3Mi / 64Mi")
// while a value-side unit renders the bound hostile ("320Ki / 65536Ki" — caught live).
// Memory within 10% of its limit turns caution-coloured: past it the container is OOMKilled — the
// one per-container emergency a healthy-looking pod total hides. CPU gets no caution (over-limit
// merely throttles).
function ContainerUsageCell(props: { label: string; value: number; limit?: number; res: CapResource }) {
  const pair = () =>
    formatPair(
      props.value,
      props.limit,
      props.res,
      props.res === 'cpu' && props.value > 0 && props.limit ? Math.min(props.value, props.limit) : props.limit,
    )
  const nearLimit = () => props.res === 'memory' && !!props.limit && props.value / props.limit! >= 0.9
  return (
    <>
      <span class="container-usage-label">{props.label}</span>
      <span
        class="container-usage-val"
        classList={{ 'near-limit': nearLimit() }}
        title={nearLimit() ? 'Using over 90% of its memory limit — at risk of being OOM-killed' : undefined}
      >
        {pair().value}
      </span>
      <Show when={props.limit}>
        <span class="container-usage-cap">/ {pair().cap}</span>
      </Show>
    </>
  )
}

// ContainerCards is a Pod's per-container section (cycle 338): runtime state and image belong
// together — "which container is broken and what's it running?" — so each container is one card
// pairing status (dot + state + restarts) with its live usage, last exit, and image, grouped into
// Init vs app containers with counts so "how many of each, what images, are they OK" reads at a
// glance. A floating tag (":latest"/none) flags an image a rolling restart could silently change.
export default function ContainerCards(props: { statuses: ContainerStatus[]; usage?: ResourceUsage }) {
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
                      {/* This container's share of the pod's live draw (multi-container pods only —
                          the server omits single-container breakdowns). Answers "which container is
                          eating the memory?" right where the operator is already looking; the pod
                          gauge above only shows the sum. keyed: each 15s usage tick delivers a new
                          object, so the row re-renders with fresh numbers. */}
                      <Show when={props.usage?.containers?.find((c) => c.name === cs.name)} keyed>
                        {(cu) => (
                          <div
                            class="container-usage"
                            title="This container's live share of the pod's usage, from metrics-server — gauged against its own limit when one is set"
                          >
                            <ContainerUsageCell label="cpu" value={cu.cpuMilli ?? 0} limit={cs.cpuLimitMilli} res="cpu" />
                            <span class="container-usage-sep">·</span>
                            <ContainerUsageCell label="mem" value={cu.memBytes ?? 0} limit={cs.memLimitBytes} res="memory" />
                          </div>
                        )}
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
