import { createMemo, createSignal } from 'solid-js'
import { type CapTipData } from '../../capacityTooltips'
import type { Health, KNode } from '../../types'

// Hover state for the Nodes (capacity) view, lifted from Topology.tsx: the cursor-following
// tooltip payload plus the hover-to-spotlight fade that composes with the standard
// selection/search/filter fade (nodeFaded) when nothing is hovered.
export function createCapacityHover(src: {
  // The cluster-wide capacity feed's nodes (props.capacity?.nodes) — maps a hovered pod id to its host.
  capacityNodes: () => KNode[]
  nodeFaded: (n: { id: string; health: string; kind: string }) => boolean
  selectedId: () => string | null
  matches: () => Set<string> | null
  healthFilter: () => Health | null | undefined
}) {
  // Rich hover tooltip for the capacity bars (item: Grafana-style panels). Holds normalized tooltip
  // data + the pointer position; an HTML overlay (not an SVG <title>) follows the cursor so the bar's
  // name/usage/request/limit read instantly instead of after the browser's ~700ms title delay. The
  // bullets/segments no longer print these numbers inline (too cluttered) — the tooltip carries them.
  const [capTip, setCapTip] = createSignal<{ d: CapTipData; x: number; y: number } | null>(null)
  // The tooltip payload builders (tipFromSeg / tipFromAgg / tipFromNodeUse) are pure and live in
  // capacityTooltips.ts; here we just thread the active resource and pointer position through. A
  // segment's contributed metric (use vs req) depends on which bar it sits on, so the caller passes it.
  const showTip = (d: CapTipData, e: PointerEvent) => setCapTip({ d, x: e.clientX, y: e.clientY })

  // Capacity-view spotlight: hovering a pod segment/bullet (not just clicking it) spotlights it and
  // fades the rest, like a Grafana panel — faster than click-to-select for reading the bars. capHover
  // holds the hovered element's key: a pod id, a `small:<host>` / `other:<host>` aggregate marker, or
  // `overhead:<host>` for the node-usage backdrop (no segment matches it, so everything else fades).
  // When something is hovered it wins; with nothing hovered we fall back to the standard
  // selection/search/filter fade (nodeFaded), so a selected pod stays spotlit after the cursor leaves.
  const [capHover, setCapHover] = createSignal<string | null>(null)
  // The spotlight originally dimmed only the pod SEGMENTS, leaving every node row's frame, tracks, value
  // labels and name fully bright — a half-applied "fades the rest" that left a dozen bright frames and a
  // column of bright totals competing with the one hovered pod. capRowFaded recedes a WHOLE row's chrome
  // when the hover belongs to a DIFFERENT node, so only the spotlit pod's node stays lit (Contrast).
  const capHoverHost = createMemo<string | null>(() => {
    const h = capHover()
    if (!h) return null
    const colon = h.indexOf(':') // small:/other:/overhead:<host> markers carry the host
    if (colon >= 0) return h.slice(colon + 1)
    for (const n of src.capacityNodes()) if (n.id === h) return n.host ?? null // pod id → its node
    return null
  })
  const capRowFaded = (host: string) => {
    const hh = capHoverHost()
    return hh !== null && hh !== host
  }
  const capSegFaded = (n: { id: string; health: string; kind: string; host?: string }) => {
    const h = capHover()
    // A segment on a fully-dimmed OTHER row is recessed by capRowFaded already — don't double-fade it
    // (it would compound to near-invisible and read dimmer than its own row frame). Only the hovered
    // row's own siblings fade individually here.
    if (h) return capRowFaded(n.host ?? '') ? false : n.id !== h
    return src.nodeFaded(n)
  }
  // An aggregate block stands for many pods and is never the single spotlighted pod, so it fades
  // whenever a specific element is in focus — a hovered sibling, or a selected/searched/filtered pod.
  // (Fixes the bug where the bright accent block stayed lit while every individual segment faded.)
  const capAggFaded = (marker: string) => {
    const h = capHover()
    if (h) return capRowFaded(marker.slice(marker.indexOf(':') + 1)) ? false : marker !== h
    return !!src.selectedId() || !!src.matches() || !!src.healthFilter()
  }

  return { capTip, setCapTip, showTip, setCapHover, capRowFaded, capSegFaded, capAggFaded }
}
