import type { KNode } from './types'

// Built-in kinds that always offer a Logs tab: a Pod, or a workload controller whose descendant pods'
// logs the server aggregates. Kept as the fast path AND the floor — a Pod owns no pods, and a workload
// scaled to 0 (or whose pod hasn't been created yet) still conceptually has logs, so it stays loggable
// even when hasDescendantPod is momentarily false.
//
// Argo's Workflow is included though it's a CRD: a FINISHED Workflow owns only completed pods, which
// the displayed graph drops, so hasDescendantPod can't see them — without this a running Workflow
// showed a Logs tab but a finished one didn't. The server's BuildForLogs still reaches those pods.
export const LOGGABLE_KINDS = new Set(['Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Workflow'])

// hasDescendantPod reports whether rootId transitively owns any Pod in the current graph — the client
// mirror of the server's podsForResource (graph.DescendantPodNames). It walks ownerUIDs downward, so a
// pod-owning resource the hardcoded kind list can't know about (an Argo Workflow, or any operator's
// custom workload CRD) is recognised as loggable too: the server already aggregates such a resource's
// pod logs, only the client's kind gate hid the tab.
export function hasDescendantPod(rootId: string, nodes: KNode[]): boolean {
  const childrenOf = new Map<string, KNode[]>()
  for (const n of nodes) {
    for (const owner of n.ownerUIDs ?? []) {
      const arr = childrenOf.get(owner)
      if (arr) arr.push(n)
      else childrenOf.set(owner, [n])
    }
  }
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const child of childrenOf.get(id) ?? []) {
      if (child.kind === 'Pod') return true
      if (!seen.has(child.id)) {
        seen.add(child.id)
        stack.push(child.id)
      }
    }
  }
  return false
}

// isLoggable decides whether the drawer shows a Logs tab (and defaults to it) for a node: a built-in
// workload/Pod by kind, or any resource that owns Pods in the graph. Null-safe so callers can pass the
// raw selection.
export function isLoggable(node: KNode | null | undefined, nodes: KNode[]): boolean {
  if (!node) return false
  return LOGGABLE_KINDS.has(node.kind) || hasDescendantPod(node.id, nodes)
}

// descendantPods collects every Pod transitively owned by rootId in the current graph — the list form of
// hasDescendantPod, used to aggregate a workload's resource usage from its replicas. Walks ownerUIDs
// downward (Deployment→ReplicaSet→Pod, or any owner chain), de-duping so a diamond owner graph counts
// each pod once.
export function descendantPods(rootId: string, nodes: KNode[]): KNode[] {
  const childrenOf = new Map<string, KNode[]>()
  for (const n of nodes) {
    for (const owner of n.ownerUIDs ?? []) {
      const arr = childrenOf.get(owner)
      if (arr) arr.push(n)
      else childrenOf.set(owner, [n])
    }
  }
  const pods: KNode[] = []
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.kind === 'Pod') pods.push(child)
      else stack.push(child.id)
    }
  }
  return pods
}
