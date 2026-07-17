import type { KNode } from './types'

// childrenByOwner indexes nodes by each ownerUID they carry, so a downward ownership walk builds the
// index once (O(nodes)) before descendantPods traverses the selected subtree.
function childrenByOwner(nodes: KNode[]): Map<string, KNode[]> {
  const childrenOf = new Map<string, KNode[]>()
  for (const n of nodes) {
    for (const owner of n.ownerUIDs ?? []) {
      const arr = childrenOf.get(owner)
      if (arr) arr.push(n)
      else childrenOf.set(owner, [n])
    }
  }
  return childrenOf
}

// descendantPods collects every Pod transitively owned by rootId in the current graph for workload
// usage rollups. It de-dupes a diamond owner graph so each pod contributes once.
export function descendantPods(rootId: string, nodes: KNode[]): KNode[] {
  const childrenOf = childrenByOwner(nodes)
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
