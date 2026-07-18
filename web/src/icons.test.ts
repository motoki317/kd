import { describe, expect, it } from 'vitest'
import { hasKindIcon, kindFromRef, kindInitials } from './icons'

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
      // Cluster-scoped kinds surfaced by the dynamic-informer store.
      'PersistentVolume',
      'CustomResourceDefinition',
      'StorageClass',
      // Common cluster-scope / policy kinds: show up in real namespaces or the
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

describe('kindInitials', () => {
  it('takes the first two capitals of a CamelCase kind', () => {
    expect(kindInitials('IngressRoute')).toBe('IR')
    expect(kindInitials('ValidatingAdmissionPolicyBinding')).toBe('VA')
  })
  it('uses the single capital of a one-word kind', () => {
    expect(kindInitials('Certificate')).toBe('C')
  })
  it('upcases the first letter when the kind has no capitals', () => {
    expect(kindInitials('foo')).toBe('F')
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
