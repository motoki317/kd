import { describe, expect, it } from 'vitest'
import { hasDescendantPod, LOGGABLE_KINDS } from './loggable'
import type { KNode } from './types'

// Minimal node factory — only the fields hasDescendantPod reads.
function node(id: string, kind: string, ownerUIDs: string[] = []): KNode {
  return { id, kind, name: id, health: 'Healthy', ownerUIDs } as KNode
}

describe('hasDescendantPod', () => {
  it('follows a multi-hop ownership chain to a Pod', () => {
    // Deployment -> ReplicaSet -> Pod
    const nodes = [node('dep', 'Deployment'), node('rs', 'ReplicaSet', ['dep']), node('pod', 'Pod', ['rs'])]
    expect(hasDescendantPod('dep', nodes)).toBe(true)
    expect(hasDescendantPod('rs', nodes)).toBe(true)
  })

  it('recognises a pod-owning CRD the kind list cannot enumerate (Argo Workflow)', () => {
    // Workflow owns its pods directly — the case the hardcoded LOGGABLE set missed.
    const nodes = [node('wf', 'Workflow'), node('wf-step', 'Pod', ['wf'])]
    expect(hasDescendantPod('wf', nodes)).toBe(true)
  })

  it('is false for a resource that owns no pods', () => {
    const nodes = [node('cm', 'ConfigMap'), node('dep', 'Deployment'), node('rs', 'ReplicaSet', ['dep'])]
    expect(hasDescendantPod('cm', nodes)).toBe(false)
    expect(hasDescendantPod('dep', nodes)).toBe(false) // RS present but no Pod under it
  })

  it('does not loop on a cycle in the ownership data', () => {
    // Defensive: malformed owner data shouldn't hang the drawer.
    const nodes = [node('a', 'X', ['b']), node('b', 'X', ['a'])]
    expect(hasDescendantPod('a', nodes)).toBe(false)
  })
})

describe('LOGGABLE_KINDS', () => {
  // The "kind floor": a finished Workflow/CronWorkflow owns only completed pods the display graph drops,
  // so hasDescendantPod sees none — membership here is what keeps its Logs tab (the server's BuildForLogs
  // still reaches those pods). The drawer's gate is LOGGABLE_KINDS.has(kind) || hasPods, so this set is
  // load-bearing for finished runs.
  it('includes Argo Workflow and CronWorkflow so a finished run keeps its Logs tab', () => {
    expect(LOGGABLE_KINDS.has('Workflow')).toBe(true)
    expect(LOGGABLE_KINDS.has('CronWorkflow')).toBe(true)
  })
})
