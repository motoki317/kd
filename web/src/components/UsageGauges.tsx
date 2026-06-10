import { For, Show } from 'solid-js'
import { formatPair, formatQuantity } from '../capacityLayout'
import type { ResGroupModel } from '../resourceBars'

// UsageSegment is one container's share of a usage fill — the workload rollup stacks one coloured
// segment per container so "which container is using it" reads visually fleet-wide.
export interface UsageSegment {
  name: string
  color: string
  cpuMilli: number
  memBytes: number
}

// UsageGauges renders the CPU + memory resource bars: per resource, one bar per bound (a container's
// Lim + Req, a Node's Cap + Alloc, a workload's summed Lim + Req). Every bar in a group shares ONE
// linear scale (like the Nodes capacity view), so the fill — LIVE USAGE — draws the SAME length on
// both bars, and each bar's TRACK LENGTH encodes its bound: the bar ENDS at its ceiling (a 256Mi
// limit bar is visibly shorter than a 281Mi request bar), not a tick on a fixed-width track. Usage
// past a bound EXTENDS the track past that ceiling with the overshoot hatched — the Nodes-view "over
// its request/limit" idiom. Built by drawerResourceBars. With `segments` (the workload rollup), the
// fill is a stack of per-container colours; the stack's total width is identical to the plain fill,
// since the breakdown sums to the total by construction.
const pct = (f: number) => `${Math.min(100, f * 100)}%`
export default function UsageGauges(props: {
  groups: ResGroupModel[]
  caption?: string
  segments?: UsageSegment[]
  legend?: boolean
}) {
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
                              The workload rollup stacks one coloured segment per container (each
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
            implicit). */}
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
