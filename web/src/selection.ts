// Memos deriving the selected resource into what the drawer needs: the capacity-feed fallback for
// pods absent from the namespace graph, live usage (own / rolled-up / host ceiling), the "deleted"
// terminal state, and owner navigation. Extracted from App.tsx as one block so the
// selectedNode/drawerNode distinction (live vs last-resolved) stays readable in one place.
// A factory of pure memos: App calls it inside its component body so they run under its root.

import { createMemo, type Accessor } from 'solid-js'
import type { GraphState } from './graphState'
import { descendantPods } from './loggable'
import { selectionLabel } from './names'
import { hostNodeCapacity } from './resourceBars'
import type { Capacity, KNode } from './types'
import { aggregateWorkloadUsage } from './usageAggregate'

export function createSelectionDetails(deps: {
  selectedId: Accessor<string | null>
  graph: GraphState
  capacity: Accessor<Capacity | null>
  nodes: Accessor<KNode[]>
}) {
  const { selectedId, graph, capacity, nodes } = deps
  // The Nodes view can select a pod that lives only in the cluster-wide capacity feed (another
  // namespace's pod, or any pod while in cluster scope — the namespace graph holds neither). Fall
  // back to the capacity feed so the drawer still opens with the pod's details (its YAML/logs are
  // fetched by namespace/name, which works cross-namespace).
  const capById = createMemo(() => new Map((capacity()?.nodes ?? []).map((n) => [n.id, n])))
  const selectedNode = createMemo(() => {
    const id = selectedId()
    if (!id) return null
    return graph.nodes[id] ?? capById().get(id) ?? null
  })
  // Live usage for the selected resource — the capacity feed keys it by UID (== node.id). Drives the
  // drawer's CPU/memory gauges for a Pod; undefined when metrics-server is absent.
  const selectedUsage = createMemo(() => {
    const n = selectedNode()
    return n ? capacity()?.usage?.items[n.id] : undefined
  })
  // A workload controller has no usage of its own, but the client already holds every descendant pod's
  // usage (capacity feed, keyed by UID) and the ownership edges — so its rolled-up gauge is a pure
  // client-side sum. Skip Pods/Nodes (they gauge their own `usage`); returns undefined when the kind
  // owns no pods or none have a reading yet, so the drawer shows nothing rather than an empty gauge.
  const selectedWorkloadUsage = createMemo(() => {
    const n = selectedNode()
    if (!n || n.kind === 'Pod' || n.kind === 'Node') return undefined
    return aggregateWorkloadUsage(descendantPods(n.id, nodes()), capacity()?.usage?.items) ?? undefined
  })
  // A selected Pod's host-node capacity, the ceiling its bar falls back to when the pod sets no
  // limit/request (so an unconstrained pod reads as a fraction of its node, not a bare value).
  const selectedHostCapacity = createMemo(() => {
    const n = selectedNode()
    if (!n || n.kind !== 'Pod') return undefined
    return hostNodeCapacity(n.host, capacity()?.nodes ?? [])
  })
  // Announce the current selection for assistive tech. j/k stepping deliberately keeps focus on the
  // body (so repeated presses work — see the keydown handler), and the drawer is a complementary
  // landmark, not a live region, so without this a screen-reader operator hears nothing as the
  // selection — and the detail behind it — changes. Mirrors the card tooltip: kind+name, then the
  // status and failure reason, so stepping through a degraded wall speaks each "why" aloud.
  const selectionAnnouncement = createMemo(() => selectionLabel(selectedNode()))
  // Last RESOLVED selection, kept so the drawer can show an explicit "deleted" terminal state
  // instead of silently closing when the inspected resource vanishes mid-investigation — a rollout
  // replaces the pod, a crashlooper is reaped, a finished job is cleaned up. The churn happens
  // exactly when the operator is watching closest. Stands in only while selectedId still points at
  // the vanished id; a new selection, an explicit deselect, or a namespace switch clears it.
  let lastResolved: KNode | null = null
  const drawerNode = createMemo(() => {
    const n = selectedNode()
    if (n) {
      lastResolved = n
      return n
    }
    const id = selectedId()
    return id && lastResolved && lastResolved.id === id ? lastResolved : null
  })
  const selectionDeleted = createMemo(() => !!drawerNode() && !selectedNode())
  // Owners present in the current graph, so the drawer can offer "walk up the tree" navigation.
  // Derived from drawerNode (not selectedNode) so a DELETED pod's owner chips keep working — the
  // ReplicaSet/Job chip is the one-click path to its replacement.
  const ownerNodes = createMemo<KNode[]>(() => {
    const n = drawerNode()
    return (n?.ownerUIDs ?? []).map((id) => graph.nodes[id]).filter((o): o is KNode => !!o)
  })

  return {
    capById,
    selectedNode,
    selectedUsage,
    selectedWorkloadUsage,
    selectedHostCapacity,
    selectionAnnouncement,
    drawerNode,
    selectionDeleted,
    ownerNodes,
  }
}
