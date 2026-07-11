// URL- and localStorage-seeded view state, plus the reflect-back effect. Extracted from App.tsx so
// the rules that make a kd link shareable — which params exist, their seed/fallback order, and the
// replace-not-push history semantics — read as one unit. Factories, not module state: App calls
// them inside its component body so the signals/effects run under its root.

import { createEffect, createSignal, type Accessor } from 'solid-js'
import type { ContextsResponse } from './api'
import type { CapResource } from './resource'
import { GROUP_OPTIONS } from './components/Topology'
import { toggleInSet } from './filterToggle'
import { readPref, readRawPref, writePref } from './prefs'
import { parseRels } from './relationships'
import type { GroupBy, KNode, RelCategory } from './types'

// Group-by is the layout strategy — how resources are arranged on the canvas. It replaced the old
// fixed view tabs: grouping is now orthogonal to *which relationships are drawn* (the composable
// relationship filter, see relationships.ts). The segmented control that sets it lives in the
// Topology toolbar (GROUP_OPTIONS is shared from there); App keeps the signal, the URL/localStorage
// persistence, the number-key shortcuts (1..3), and the help overlay listing.
const GROUP_IDS = GROUP_OPTIONS.map((g) => g.id)
export const DEFAULT_RELS = (): Set<RelCategory> => new Set<RelCategory>(['ownership'])

export function createUrlState() {
  // Seed namespace/ctx/grouping/relationships from the URL so a link or reload restores the same
  // place. Grouping + relationship filter also fall back to localStorage (then their defaults), so
  // a plain reload of an un-shared URL still remembers how the operator last arranged the canvas.
  const params = new URLSearchParams(location.search)
  const [ctx, setCtx] = createSignal<string | null>(params.get('ctx'))
  const [namespace, setNamespace] = createSignal<string | null>(params.get('ns'))
  const urlGroup = params.get('group') as GroupBy
  const [groupBy, setGroupBy] = createSignal<GroupBy>(
    GROUP_IDS.includes(urlGroup) ? urlGroup : readPref('kd:groupBy', 'relationship', GROUP_IDS),
  )
  createEffect(() => writePref('kd:groupBy', groupBy()))
  const [relFilter, setRelFilter] = createSignal<Set<RelCategory>>(
    parseRels(params.get('rels')) ?? parseRels(readRawPref('kd:rels')) ?? DEFAULT_RELS(),
  )
  createEffect(() => writePref('kd:rels', [...relFilter()].sort().join(',')))
  // Capacity-view resource (cpu|memory) — owned here, not in Topology, so it round-trips through the
  // URL like group/rels (the share button must capture "I'm looking at MEMORY pressure", or a shared
  // capacity-view link silently reverts the recipient to CPU). Falls back to localStorage then 'cpu'.
  const urlCapRes = params.get('capRes')
  const [capResource, setCapResource] = createSignal<CapResource>(
    urlCapRes === 'cpu' || urlCapRes === 'memory' ? urlCapRes : readPref('kd:capRes', 'cpu', ['cpu', 'memory']),
  )
  createEffect(() => writePref('kd:capRes', capResource()))
  // Show-orphaned (relationship view): unconnected resources hide by default so the canvas reads as the
  // relationship tree. Owned here so it round-trips through the URL + localStorage like group/rels — a
  // shared "?orphans=1" link restores the choice. Default off; the URL flag wins, then localStorage.
  const [showOrphaned, setShowOrphaned] = createSignal(
    params.get('orphans') === '1' || (params.get('orphans') === null && readRawPref('kd:orphans') === '1'),
  )
  createEffect(() => writePref('kd:orphans', showOrphaned() ? '1' : '0'))
  // Relationship + kind chips share one toggle/solo semantics — see toggleInSet.
  const toggleRel = (c: RelCategory, solo = false) => setRelFilter(toggleInSet(relFilter(), c, solo))
  // Kind filter (cycle 203): a multi-select set of kinds to spotlight, composing with search +
  // healthFilter. Lives in App so it resets on namespace/view change alongside the others. Seed
  // from `?kinds=` so a shared URL restores the filtered view (cycle 217).
  const urlKinds = params.get('kinds')
  const [kindFilter, setKindFilter] = createSignal<Set<string>>(
    new Set(urlKinds ? urlKinds.split(',').filter(Boolean) : []),
  )
  // Operators reach for solo when they want "show me ONLY Pods" without first clearing the prior
  // multi-select. Shared toggle/solo semantics — see toggleInSet.
  const toggleKind = (k: string, solo = false) => setKindFilter(toggleInSet(kindFilter(), k, solo))
  // The "?sel=" deep-link, returned raw: App owns the restore flow (it must coordinate with the
  // SSE snapshot resolution), so this module only reports what the URL asked for.
  const initialSel = params.get('sel')
  return {
    ctx,
    setCtx,
    namespace,
    setNamespace,
    groupBy,
    setGroupBy,
    relFilter,
    setRelFilter,
    toggleRel,
    capResource,
    setCapResource,
    showOrphaned,
    setShowOrphaned,
    kindFilter,
    setKindFilter,
    toggleKind,
    initialSel,
  }
}

export function createUrlSync(deps: {
  ctx: Accessor<string | null>
  contextsInfo: Accessor<ContextsResponse | null>
  namespace: Accessor<string | null>
  groupBy: Accessor<GroupBy>
  relFilter: Accessor<Set<RelCategory>>
  capResource: Accessor<CapResource>
  showOrphaned: Accessor<boolean>
  kindFilter: Accessor<Set<string>>
  selectedNode: Accessor<KNode | null>
}): void {
  const { ctx, contextsInfo, namespace, groupBy, relFilter, capResource, showOrphaned, kindFilter, selectedNode } = deps
  // Mirror ctx/namespace/view/selection back into the URL (replace, not push, so Back isn't spammed).
  // ctx is included only when the switcher is enabled (kubeconfig mode); in-cluster keeps URLs clean.
  // Kind filter (cycle 217) is included so a filtered view ("pods only") is shareable via URL.
  // Search and healthFilter are kept ephemeral — those are mid-investigation state, not view config.
  createEffect(() => {
    const p = new URLSearchParams()
    if (ctx() && contextsInfo()?.enabled) p.set('ctx', ctx()!)
    if (namespace()) p.set('ns', namespace()!)
    // Grouping + relationships are view config worth sharing; omit when at the defaults to keep
    // URLs clean. The relationship list round-trips even when empty (an explicit `?rels=`) so a
    // shared "all relationships off" link restores faithfully.
    if (groupBy() !== 'relationship') p.set('group', groupBy())
    const rels = [...relFilter()].sort().join(',')
    if (rels !== 'ownership') p.set('rels', rels)
    // capRes only changes the Nodes view, but mirror group/rels: write it whenever non-default so a
    // shared capacity-view link restores the resource. Omitted at the 'cpu' default to keep URLs clean.
    if (capResource() !== 'cpu') p.set('capRes', capResource())
    if (showOrphaned()) p.set('orphans', '1')
    // selectedNode resolves through the SAME graph→capacity fallback the drawer uses, so a Nodes-view
    // pod from another namespace — present only in the capacity feed — still writes a `sel` instead of
    // the Share link silently dropping it. Carry the namespace when it differs from the viewed scope
    // (the cluster-scope Nodes case) so the ref round-trips unambiguously.
    const n = selectedNode()
    if (n) p.set('sel', n.namespace && n.namespace !== namespace() ? `${n.kind}/${n.namespace}/${n.name}` : `${n.kind}/${n.name}`)
    if (kindFilter().size > 0) p.set('kinds', [...kindFilter()].sort().join(','))
    history.replaceState(null, '', `${location.pathname}?${p}`)
  })
}
