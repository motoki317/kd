import type { KNode } from './types'

// Built-in kinds that always offer a Logs tab: a Pod, or a workload controller whose descendant pods'
// logs the server aggregates. Kept as the fast path AND the floor — a Pod owns no pods, and a workload
// scaled to 0 (or whose pod hasn't been created yet) still conceptually has logs, so it stays loggable
// even when hasDescendantPod is momentarily false.
export const LOGGABLE_KINDS = new Set(['Pod', 'ReplicaSet', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'])

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
