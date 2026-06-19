import { For, Show } from 'solid-js'
import { formatQuantity } from '../capacityLayout'
import { useNow } from '../clock'
import { healthColor, healthTextColor } from '../health'
import { relativeAge } from '../time'
import type { ContainerStatus, ContainerUsage, Health, ResourceUsage } from '../types'
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

// ContainerCards is a Pod's per-container section: runtime state and the per-container essentials
// belong together — "which container is broken?" — so each container is one card pairing status
// (dot + state + restarts) with its last exit and image, grouped into Init vs app containers with
// counts. A floating tag (":latest"/none) flags an image a rolling restart could silently change.
// Resource bars live in the drawer's segmented top gauge (the summed fill split by container), not
// here; the one per-container resource signal kept on the card is the OOM alarm (memory ≥90% of a
// container's OWN limit), since an imminent OOM kill is worth words even without a bar.
export default function ContainerCards(props: {
  statuses: ContainerStatus[]
  usage?: ResourceUsage
}) {
  // A container's own usage reading: multi-container pods carry a per-container breakdown; a
  // single-container pod's breakdown is omitted on the wire (it would repeat the total), so the
  // pod total IS that container's reading.
  const usageFor = (cs: ContainerStatus): ContainerUsage | undefined => {
    const breakdown = props.usage?.containers
    if (breakdown) return breakdown.find((c) => c.name === cs.name)
    if (props.usage && !cs.init && props.statuses.filter((s) => !s.init).length === 1) {
      return { name: cs.name, cpuMilli: props.usage.cpuMilli, memBytes: props.usage.memBytes }
    }
    return undefined
  }
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
                  // The one per-container emergency worth words: memory over 90% of its own limit
                  // means an OOM kill is imminent — explicit text on top of the bar's near-full read.
                  // Returns the reading itself so the message quotes the SAME value it was judged on
                  // (no second usageFor call hiding behind a non-null assertion).
                  const nearMemLimit = () => {
                    const cu = usageFor(cs)
                    return cu && cs.memLimitBytes && (cu.memBytes ?? 0) / cs.memLimitBytes >= 0.9 ? cu : undefined
                  }
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
                        {/* The age qualifies the count: "↻ 47" reads identically for an ancient
                            flaky week and an active crashloop until you know the last restart was
                            2 hours — or 60 days — ago. */}
                        <Show when={(cs.restarts ?? 0) > 0}>
                          <span
                            class="container-restarts"
                            title={
                              cs.lastRestartAt
                                ? `${cs.restarts} restarts — the last one ${relativeAge(cs.lastRestartAt, useNow())} ago`
                                : `${cs.restarts} restarts`
                            }
                          >
                            ↻ {cs.restarts}
                            {cs.lastRestartAt ? ` · ${relativeAge(cs.lastRestartAt, useNow())} ago` : ''}
                          </span>
                        </Show>
                      </div>
                      <Show when={nearMemLimit()}>
                        {(cu) => (
                          <div
                            class="container-near-limit"
                            title="Live usage from metrics-server, gauged against this container's own memory limit"
                          >
                            mem {formatQuantity(cu().memBytes ?? 0, 'memory')} — over 90% of its limit, at
                            risk of OOM kill
                          </div>
                        )}
                      </Show>
                      <Show when={cs.lastTerminated}>
                        {/* Why it previously exited — surfaced inline next to the restart count so an
                            operator sees "OOMKilled" without digging into the manifest's lastState.
                            The CrashLoopBackOff + clean-exit pairing reads as a contradiction
                            ("it succeeded, why is it red?"), so that one case gets its explanation
                            spelled out: the process finishing IS the failure for a Deployment. */}
                        <Show
                          when={cs.lastTerminated === 'Completed' && cs.state.includes('CrashLoopBackOff')}
                          fallback={
                            <div class="container-last-terminated" title="Why the container last restarted">
                              last exit: {cs.lastTerminated}
                            </div>
                          }
                        >
                          <div
                            class="container-last-terminated"
                            title="The container exits successfully, so Kubernetes restarts it and backs off — a Deployment expects a process that keeps running. One-shot work belongs in a Job or CronJob."
                          >
                            last exit: Completed — it keeps finishing and restarting; run one-shot work as a Job
                          </div>
                        </Show>
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
