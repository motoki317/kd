import { createMemo, For, Show } from 'solid-js'
import {
  CAP_BAR_H,
  CAP_BULLET_BAR_GAP,
  CAP_BULLET_BAR_H,
  CAP_BULLET_PAD,
  formatPair,
  formatQuantity,
  type CapResource,
  type CapRow,
  type CapSeg,
} from '../capacityLayout'
import { tipFromAgg, tipFromNodeUse, tipFromSeg, type CapTipData } from '../capacityTooltips'
import type { KNode } from '../types'

// The viewport box a bullet-card click asks the host to zoom to (the card's bar region, not the
// full capacity-width card — see the focusBox comment at the click site).
export type CapFocusBox = { x: number; y: number; width: number; height: number }

// CapacityView renders the Nodes group-by's SVG content: per-node rows of stacked Req/Use bars with
// pod segments, aggregate folds, and (expanded) per-pod bullet cards. Extracted from Topology.tsx —
// the geometry-heavy, most actively-developed view deserved its own file — but deliberately kept
// PRESENTATIONAL: layout (capRows), fade/spotlight state, the hover tooltip overlay, and viewport
// fitting stay in Topology and arrive as props/callbacks, so this component owns SVG shape only and
// the host owns every signal. The DOM it emits is identical to the pre-extraction inline block.
//
// Reactivity note: props are accessed lazily (no destructuring), so the host's reactive expressions
// (`rows={capRows()}`, `scale={capInfo().scale}`) re-render exactly as the inline version did.
export default function CapacityView(props: {
  rows: CapRow[]
  scale: number
  hasUsage: boolean
  resource: CapResource
  selectedId?: string | null
  segFaded: (n: KNode) => boolean
  aggFaded: (key: string) => boolean
  rowFaded: (host: string) => boolean
  onSelect: (id: string) => void
  // A bullet-card click both selects the pod AND asks the host to zoom to the card's bar region.
  onSelectBullet: (id: string, focusBox: CapFocusBox) => void
  onToggleRow: (host: string) => void
  // Pointer entered a segment/fold/backdrop: `key` drives the hover spotlight (a pod id or a
  // `small:`/`other:`/`overhead:<host>` marker), `tip` the cursor tooltip the host renders.
  onHover: (key: string, tip: CapTipData, e: PointerEvent) => void
  onLeave: () => void
}) {
  return (
    <g class="cap-view">
      {/* Honesty hint: with no metrics-server, usage is unknown, so bars fall back to
          sizing by request — say so rather than implying the requests are usage. */}
      <Show when={props.rows.length > 0 && !props.hasUsage}>
        <text class="cap-hint" x={30} y={14}>
          metrics-server unavailable — bars sized by requests
        </text>
      </Show>
      <For each={props.rows}>
        {(row) => {
          const fmt = (v: number | undefined) => formatQuantity(v, props.resource)
          const pods = row.ownCount
          // Pods are a THIRD capacity axis: a node caps at ~110 pods and can hit that ceiling while
          // CPU/memory sit near-empty (many tiny pods), so pod slots — invisible behind a bare "N
          // pods" — become the binding constraint. Show "N / cap" like the CPU/mem bars' value/
          // capacity, and amber the count when the node nears its pod cap (scheduling will start to
          // fail). Cap is node-global, so it gauges the node TOTAL (own + other namespaces).
          // Show the denominator only when the node has real pod headroom to gauge (cap > 1). A cap of
          // 0 (some virtual-kubelet nodes report it, cpu/mem still set so the server's nil-guard passes)
          // would render "N / 0 pods" and amber on a N/0 = Infinity ratio. A cap of 1 is an EKS Fargate
          // node — one pod per micro-VM BY DESIGN, always 1/1 — so "1 / 1 pods" + the amber falsely read
          // as pod pressure on every Fargate pod. Both are dedicated/degenerate; fall back to the bare
          // count (verified on real Fargate nodes, tainted eks.amazonaws.com/compute-type=fargate).
          const podCap = row.node?.allocatable?.pods
          const showPodCap = podCap !== undefined && podCap > 1
          const totalPods = row.ownCount + row.otherCount
          const podPressure = showPodCap && totalPods / podCap! >= 0.9
          const expandable = pods > 0 || row.otherCount > 0
          // Aggregate folds carry no stopPropagation, so a click falls through to the row's
          // expand/collapse toggle. Their pointer cursor alone reads as "select this block" —
          // which a fold can't do — so the tooltip says what the click really does (explicit
          // over implicit). Pod segments need no hint: theirs is the normal selection idiom.
          const aggTip = (d: CapTipData): CapTipData =>
            expandable
              ? { ...d, hint: row.expanded ? 'Click to collapse the node row' : 'Click to expand into per-pod cards' }
              : d
          // The Use bar's right label is the node's REAL usage (NodeMetrics) — the sum of this
          // namespace's pod segments undercounts when other namespaces + system overhead also run
          // on the node, so max(pod sum, node usage) keeps the headline figure honest.
          const useShown = Math.max(row.useTotal, row.nodeUse ?? 0)
          // Node-row "value / capacity" labels: format BOTH stacked bars in one unit, picked from
          // the node's TOTAL capacity, so the Use bar (cap = total) and Req bar (cap = the smaller
          // allocatable) never clash — e.g. "0.06 / 1" Use over "480m / 940m" Req. See formatPair.
          const unitRef = row.useCap ?? row.cap
          const reqPair = formatPair(row.reqTotal, row.cap, props.resource, unitRef)
          const usePair = formatPair(useShown, row.useCap, props.resource, unitRef)
          const segClasses = (s: CapSeg) => ({
            over: s.over,
            near: s.nearLimit,
            faded: props.segFaded(s.node),
            selected: s.node.id === props.selectedId,
            [`h-${s.node.health.toLowerCase()}`]: true,
          })
          // The WHOLE node row is one big click target for expand/collapse (a bordered card),
          // not a tiny caret: clicking anywhere that isn't a pod segment toggles it. Pod segments
          // and bullets stopPropagation so selecting a pod doesn't also toggle the node.
          const fx = row.x - 34
          const fy = row.y - 6
          const fw = row.width + 42
          const fh = row.height + 12
          return (
            <g
              class="cap-row"
              classList={{ faded: props.rowFaded(row.host) }}
              onClick={() => expandable && props.onToggleRow(row.host)}
              // Expand/collapse is a discrete action with no keyboard equivalent elsewhere, so
              // (when foldable) the row is a real button: keyboard-focusable, Enter/Space toggles,
              // and a screen reader hears "<node>, N pods, collapsed/expanded, button". A
              // non-foldable node carries no button semantics. (Pod segments inside select pods by
              // mouse — reachable by keyboard via search-cycling — so they stay non-focusable.)
              role={expandable ? 'button' : undefined}
              tabindex={expandable ? 0 : undefined}
              aria-label={expandable ? `${row.label}, ${pods} pod${pods === 1 ? '' : 's'} — ${row.expanded ? 'collapse' : 'expand'} node` : undefined}
              aria-expanded={expandable ? row.expanded : undefined}
              onKeyDown={
                expandable
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        props.onToggleRow(row.host)
                      }
                    }
                  : undefined
              }
            >
              <rect
                class="cap-node-frame"
                classList={{ clickable: expandable, expanded: row.expanded, selected: !!row.node && row.node.id === props.selectedId }}
                x={fx}
                y={fy}
                width={fw}
                height={fh}
                rx="8"
              />
              {/* Node name packed into the card's top-left (no caret); CAP_HEADER_INSET=26 in
                  layout.ts reserves the matching left offset + card width so it never overflows. */}
              <text class="cap-row-label" classList={{ clickable: expandable }} x={row.x - 26} y={row.y + 14}>
                {/* The node NAME selects the Node resource (opens its drawer) — clicking a name to
                    inspect that thing mirrors how a pod segment selects its pod; the rest of the
                    card still toggles expand/collapse. stopPropagation keeps the two apart. The
                    orphan "Unscheduled" bucket has no Node, so its name stays inert. */}
                <tspan
                  class="cap-row-host"
                  classList={{ clickable: !!row.node, selected: !!row.node && row.node.id === props.selectedId }}
                  onClick={row.node ? (e) => { e.stopPropagation(); props.onSelect(row.node!.id) } : undefined}
                >
                  <Show when={row.node}>
                    <title>Open node details</title>
                  </Show>
                  {row.label}
                </tspan>
                {/* Node-level totals (capacity, use, req) used to live here, crowding the name;
                    they now sit next to the Req/Use bars they describe (proximity). The header
                    keeps only the node's identity + pod count. */}
                <tspan class="cap-row-meta" classList={{ 'near-cap': podPressure }}>
                  {row.otherCount === 0
                    ? showPodCap
                      ? ` · ${totalPods} / ${podCap} pods`
                      : ` · ${pods} pod${pods === 1 ? '' : 's'}`
                    : ` · ${pods} pod${pods === 1 ? '' : 's'} (+${row.otherCount} in other namespaces${
                        showPodCap ? ` · ${totalPods}/${podCap} on node` : ''
                      })`}
                </tspan>
                <Show when={row.overcommit}>
                  <tspan class="cap-warn"> · overcommit</tspan>
                </Show>
                {/* A cordoned node looks identical to a healthy one bar-wise (existing pods keep
                    running) — say it in words on the row, the same idiom as "· overcommit", so
                    "which node is the Suspended 1?" needs no hunting. */}
                <Show when={row.node?.status?.includes('SchedulingDisabled')}>
                  <tspan class="cap-cordoned">
                    {' · cordoned'}
                    <title>Scheduling disabled — new pods will not land on this node</title>
                  </tspan>
                </Show>
              </text>

              {/* Requested bar: this namespace's pods sized by request, then the single folded
                  "other namespaces" block. The "Req" axis label sits in the left gutter. */}
              <text class="cap-axis-label" x={row.x - 6} y={row.reqBarY + 12}>Req<title>Reserved by pod requests</title></text>
              <rect class="cap-track req" x={row.x} y={row.reqBarY} width={row.trackW} height={CAP_BAR_H} rx="2" />
              <For each={row.reqSegs}>
                {(s) => (
                  <rect
                    class="cap-seg req"
                    classList={{ faded: props.segFaded(s.node), selected: s.node.id === props.selectedId, [`h-${s.node.health.toLowerCase()}`]: true }}
                    x={s.x}
                    y={s.y}
                    width={Math.max(0.5, s.width - 0.5)}
                    height={s.height}
                    onClick={(e) => { e.stopPropagation(); props.onSelect(s.node.id) }}
                    onPointerMove={(e) => props.onHover(s.node.id, tipFromSeg(s, 'req', props.resource), e)}
                    onPointerLeave={() => props.onLeave()}
                  />
                )}
              </For>
              <Show when={row.smallReqSeg}>
                {(o) => (
                  <rect
                    class="cap-seg req small"
                    classList={{ faded: props.aggFaded(`small:${row.host}`) }}
                    x={o().x}
                    y={o().y}
                    width={Math.max(0.5, o().width - 0.5)}
                    height={o().height}
                    onPointerMove={(e) => props.onHover(`small:${row.host}`, aggTip(tipFromAgg(o(), 'req', props.resource)), e)}
                    onPointerLeave={() => props.onLeave()}
                  />
                )}
              </Show>
              <Show when={row.otherReqSeg}>
                {(o) => (
                  <rect
                    class="cap-seg req other"
                    classList={{ faded: props.aggFaded(`other:${row.host}`) }}
                    x={o().x}
                    y={o().y}
                    width={Math.max(0.5, o().width - 0.5)}
                    height={o().height}
                    onPointerMove={(e) => props.onHover(`other:${row.host}`, aggTip(tipFromAgg(o(), 'req', props.resource)), e)}
                    onPointerLeave={() => props.onLeave()}
                  />
                )}
              </Show>
              {/* Reserved (request) total, sat right after the request bar (proximity): "req / cap". */}
              <text class="cap-bar-value" x={row.x + Math.max(row.trackW, row.reqTotal * props.scale) + 8} y={row.reqBarY + 12}>
                <tspan class="cap-bar-value-strong">{reqPair.value}</tspan>
                {row.cap !== undefined ? ` / ${reqPair.cap}` : ''}
              </text>

              {/* Usage bar: this namespace's pods sized by actual usage, then the single folded
                  "other namespaces" block. The node's TOTAL usage (all namespaces incl. system
                  overhead, from NodeMetrics) is a faint backdrop so the segments read against
                  the node's real utilization. */}
              <text class="cap-axis-label" x={row.x - 6} y={row.trackY + 12}>Use<title>In use right now</title></text>
              <rect class="cap-track use" x={row.x} y={row.trackY} width={row.useTrackW} height={CAP_BAR_H} rx="2" />
              <Show when={row.nodeUse !== undefined}>
                <rect
                  class="cap-track-nodeuse"
                  x={row.x}
                  y={row.trackY}
                  width={Math.max(0, Math.min(row.nodeUse! * props.scale, row.useTrackW))}
                  height={CAP_BAR_H}
                  onPointerMove={(e) => { e.stopPropagation(); props.onHover(`overhead:${row.host}`, tipFromNodeUse(row, props.resource), e) }}
                  onPointerLeave={() => props.onLeave()}
                />
              </Show>
              <For each={row.useSegs}>
                {(s) => (
                  <Show when={s.width > 0}>
                    <g
                      class="cap-seg-g"
                      onClick={(e) => { e.stopPropagation(); props.onSelect(s.node.id) }}
                      onPointerMove={(e) => props.onHover(s.node.id, tipFromSeg(s, 'use', props.resource), e)}
                      onPointerLeave={() => props.onLeave()}
                    >
                      <rect
                        class="cap-seg use"
                        classList={segClasses(s)}
                        x={s.x}
                        y={s.y}
                        width={Math.max(0.5, s.width - 0.5)}
                        height={s.height}
                      />
                      {/* Bursting (usage > request): hatch overlay, color-independent. */}
                      <Show when={s.over && !props.segFaded(s.node)}>
                        <rect class="cap-burst-overlay" x={s.x} y={s.y} width={Math.max(0.5, s.width - 0.5)} height={s.height} />
                      </Show>
                      {/* Near-limit (≥90% of its limit — OOM/throttle risk): a FIXED-SIZE warning
                          notch above the segment. The .near outline stroke vanishes on a few-px
                          segment, and exactly those tight-limit tiny pods are the likeliest to sit
                          near their limit — the marker's size encodes the state, not the pod's
                          magnitude, so the bar's most urgent cue survives any segment width. */}
                      <Show when={s.nearLimit && !props.segFaded(s.node)}>
                        <path
                          class="cap-near-marker"
                          d={`M ${s.x + s.width / 2 - 5} ${s.y - 7} L ${s.x + s.width / 2 + 5} ${s.y - 7} L ${s.x + s.width / 2} ${s.y - 1.5} Z`}
                        />
                      </Show>
                    </g>
                  </Show>
                )}
              </For>
              <Show when={row.smallUseSeg}>
                {(o) => (
                  <rect
                    class="cap-seg use small"
                    classList={{ faded: props.aggFaded(`small:${row.host}`) }}
                    x={o().x}
                    y={o().y}
                    width={Math.max(0.5, o().width - 0.5)}
                    height={o().height}
                    onPointerMove={(e) => props.onHover(`small:${row.host}`, aggTip(tipFromAgg(o(), 'use', props.resource)), e)}
                    onPointerLeave={() => props.onLeave()}
                  />
                )}
              </Show>
              <Show when={row.otherUseSeg}>
                {(o) => (
                  <rect
                    class="cap-seg use other"
                    classList={{ faded: props.aggFaded(`other:${row.host}`) }}
                    x={o().x}
                    y={o().y}
                    width={Math.max(0.5, o().width - 0.5)}
                    height={o().height}
                    onPointerMove={(e) => props.onHover(`other:${row.host}`, aggTip(tipFromAgg(o(), 'use', props.resource)), e)}
                    onPointerLeave={() => props.onLeave()}
                  />
                )}
              </Show>
              {/* Allocatable (schedulable) boundary line, drawn when requests overcommit it or the
                  node's usage spills past it into the reserved region. The Use bar extends past
                  this to total capacity, so the line reads as "schedulable ends here". */}
              <Show when={row.cap !== undefined && (row.overcommit || useShown > row.cap)}>
                <line class="cap-capline" x1={row.x + row.trackW} y1={row.trackY - 3} x2={row.x + row.trackW} y2={row.reqBarY + CAP_BAR_H + 3} />
              </Show>
              {/* Actual usage total, sat right after the usage bar (proximity): "use / capacity".
                  The node's real usage (incl. overhead) gauged against TOTAL physical capacity,
                  not allocatable — usage can spill into the reserved region. */}
              <text class="cap-bar-value" x={row.x + Math.max(row.useTrackW, useShown * props.scale) + 8} y={row.trackY + 12}>
                <tspan class="cap-bar-value-strong">{usePair.value}</tspan>
                {row.useCap !== undefined ? ` / ${usePair.cap}` : ''}
              </text>

              {/* Per-pod bullets (expanded): each pod is its own bordered CARD — name header, then
                  two stacked bars (Use over Req) BOTH filling with actual USAGE at the global scale
                  (so the bar is comparable to the node track above). A tick marks the limit (Use) /
                  request (Req); usage past it extends + hatches. Clicking the card zooms the
                  viewport to it so the bars read clearly even when the global scale draws them small. */}
              <For each={row.bullets}>
                {(b) => {
                  const useStr = fmt(b.use)
                  const reqY = b.y + CAP_BULLET_BAR_H + CAP_BULLET_BAR_GAP
                  const hClass = `h-${b.node.health.toLowerCase()}`
                  const selected = b.node.id === props.selectedId
                  const box = b.box!
                  // Zoom-to-read frames the BAR region (focusW), not the full card — the card spans
                  // the node's whole capacity width, so fitting it would zoom OUT on a low-usage pod
                  // (its short bars sit in a sea of empty card). focusW reaches just past the bars +
                  // labels, so the click enlarges them. The card is still the full-width click target.
                  const focusBox = { x: box.x, y: box.y, width: b.focusW ?? box.width, height: box.height }
                  return (
                    <g
                      class="cap-bullet"
                      classList={{ faded: props.segFaded(b.node) }}
                      onClick={(e) => { e.stopPropagation(); props.onSelectBullet(b.node.id, focusBox) }}
                      onPointerMove={(e) => props.onHover(b.node.id, tipFromSeg(b, 'use', props.resource), e)}
                      onPointerLeave={() => props.onLeave()}
                    >
                      <rect class="cap-bullet-frame" classList={{ selected }} x={box.x} y={box.y} width={box.width} height={box.height} rx="6" />
                      <text class="cap-bullet-name" x={box.x + 8} y={box.y + CAP_BULLET_PAD + 10}>{b.node.name}</text>
                      <CapBulletBar x={b.x} y={b.y} value={b.use} refVal={b.lim} scale={props.scale} axis="Use" barClass="use" valueStr={useStr} refStr={b.lim !== undefined ? fmt(b.lim) : undefined} hClass={hClass} selected={selected} />
                      <CapBulletBar x={b.x} y={reqY} value={b.use} refVal={b.req} scale={props.scale} axis="Req" barClass="req" valueStr={useStr} refStr={b.req !== undefined ? fmt(b.req) : undefined} hClass={hClass} selected={selected} />
                    </g>
                  )
                }}
              </For>
              {/* Folded "other namespaces" card — one gray bar pair standing in for every pod outside
                  this namespace: the Use bar = Σ usage, the Req bar = Σ request, at the global scale.
                  Hoverable for its totals, not selectable. */}
              <Show when={row.otherBullet}>
                {(o) => {
                  const reqY = o().y + CAP_BULLET_BAR_H + CAP_BULLET_BAR_GAP
                  const box = o().box!
                  return (
                    <g
                      class="cap-bullet other"
                      classList={{ faded: props.aggFaded(`other:${row.host}`) }}
                      onPointerMove={(e) => props.onHover(`other:${row.host}`, aggTip(tipFromAgg(o(), 'use', props.resource)), e)}
                      onPointerLeave={() => props.onLeave()}
                    >
                      <rect class="cap-bullet-frame" x={box.x} y={box.y} width={box.width} height={box.height} rx="6" />
                      <text class="cap-bullet-name" x={box.x + 8} y={box.y + CAP_BULLET_PAD + 10}>
                        other namespaces · {o().count} pod{o().count === 1 ? '' : 's'}
                      </text>
                      <CapBulletBar x={o().x} y={o().y} value={o().use} scale={props.scale} axis="Use" barClass="use" valueStr={fmt(o().use)} other />
                      <CapBulletBar x={o().x} y={reqY} value={o().req} scale={props.scale} axis="Req" barClass="req" valueStr={fmt(o().req)} other />
                    </g>
                  )
                }}
              </Show>
            </g>
          )
        }}
      </For>
    </g>
  )
}

// CapBulletBar draws ONE expanded-pod bar at the global capacity scale (the same px-per-unit as the
// node tracks, so a pod's bar is directly comparable to its node's): an axis label ("Use"/"Req"), a
// faint track to the bar's reference extent, the actual usage as a fill, a TICK at the request/limit
// reference, and a "value / ref" label. When usage exceeds the reference the fill EXTENDS past the tick
// and the overshoot is hatched — so "over its request/limit" reads as a bar running past its marker
// rather than wrapping in lap colours. `ref` is the request (Req bar) / limit (Use bar); undefined (the
// folded other-namespaces card) draws no tick.
function CapBulletBar(props: {
  x: number
  y: number
  value: number
  refVal?: number // request (Req bar) / limit (Use bar) — NOT named `ref` (Solid reserves that for element refs)
  scale: number
  axis: string
  barClass: string // 'use' | 'req' — picks the matching node-bar track/segment styling
  valueStr: string
  refStr?: string
  hClass?: string
  selected?: boolean
  other?: boolean
}) {
  const fill = createMemo(() => Math.max(1, props.value * props.scale))
  const refLen = createMemo(() => (props.refVal !== undefined ? Math.max(1, props.refVal * props.scale) : 0))
  const extent = createMemo(() => Math.max(fill(), refLen()))
  const over = createMemo(() => props.refVal !== undefined && fill() > refLen() + 0.5)
  return (
    <>
      <text class="cap-axis-label" x={props.x - 6} y={props.y + 9}>
        {props.axis}
        <title>{props.axis === 'Req' ? 'Reserved by pod requests' : 'In use right now'}</title>
      </text>
      <rect class={`cap-track ${props.barClass}`} x={props.x} y={props.y} width={extent()} height={CAP_BULLET_BAR_H} rx="2" />
      <rect
        class={`cap-seg ${props.barClass}`}
        classList={{ [props.hClass ?? 'h-healthy']: !props.other, other: !!props.other, selected: !!props.selected }}
        x={props.x}
        y={props.y}
        width={fill()}
        height={CAP_BULLET_BAR_H}
        rx="2"
      />
      {/* Overshoot past the request/limit: hatch the portion beyond the tick (colour-independent). */}
      <Show when={over()}>
        <rect class={`cap-burst-overlay ${props.barClass}`} x={props.x + refLen()} y={props.y} width={Math.max(1, fill() - refLen())} height={CAP_BULLET_BAR_H} />
      </Show>
      {/* Reference tick: where the request (Req bar) / limit (Use bar) sits, so an overshoot is legible. */}
      <Show when={props.refVal !== undefined}>
        <line class="cap-bullet-tick" x1={props.x + refLen()} y1={props.y - 1} x2={props.x + refLen()} y2={props.y + CAP_BULLET_BAR_H + 1} />
      </Show>
      <text class="cap-bar-value" x={props.x + extent() + 8} y={props.y + 9}>
        <tspan class="cap-bar-value-strong">{props.valueStr}</tspan>
        {props.refStr ? ` / ${props.refStr}` : ''}
      </text>
    </>
  )
}
