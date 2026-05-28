import { describe, expect, it } from 'vitest'
import { hasKindIcon, kindFromRef } from './icons'

describe('kindIcon', () => {
  it('has an icon for every kind the server currently emits', () => {
    // Covers `kindFromType` in internal/kube/graph/build.go. Each is also a search alias /
    // appears as a topology card kind, so a missing icon means a card prints kind text at a
    // different x-offset than its peers — visually inconsistent.
    const kinds = [
      'Pod',
      'Service',
      'Node',
      'Namespace',
      'ConfigMap',
      'Secret',
      'PersistentVolumeClaim',
      'ServiceAccount',
      'Endpoints',
      'Deployment',
      'ReplicaSet',
      'StatefulSet',
      'DaemonSet',
      'Job',
      'CronJob',
      'Ingress',
      'Role',
      'RoleBinding',
      'ClusterRole',
      'ClusterRoleBinding',
      // Cluster-scoped kinds surfaced by the dynamic-informer store (cycle 177).
      'PersistentVolume',
      'CustomResourceDefinition',
      'StorageClass',
      // Common cluster-scope / policy kinds (cycle 212): show up in real namespaces or the
      // [cluster] view, so a fallback square is a downgrade.
      'APIService',
      'CSINode',
      'CSIDriver',
      'MutatingWebhookConfiguration',
      'ValidatingWebhookConfiguration',
      'HorizontalPodAutoscaler',
      'PodDisruptionBudget',
      'NetworkPolicy',
      'ResourceQuota',
      'LimitRange',
      'PriorityClass',
    ]
    for (const k of kinds) expect(hasKindIcon(k), `missing icon for ${k}`).toBe(true)
  })
})

describe('kindFromRef', () => {
  it('parses a binding roleRef ("Kind/name")', () => {
    expect(kindFromRef('Role/foo')).toBe('Role')
    expect(kindFromRef('ClusterRole/admin')).toBe('ClusterRole')
  })
  it('parses a binding subject ("Kind: name") regardless of whether the name has a slash', () => {
    expect(kindFromRef('User: alice')).toBe('User')
    expect(kindFromRef('Group: devs')).toBe('Group')
    expect(kindFromRef('ServiceAccount: default/builder')).toBe('ServiceAccount')
  })
  it('returns "" when neither separator is present', () => {
    expect(kindFromRef('anything')).toBe('')
  })
})
