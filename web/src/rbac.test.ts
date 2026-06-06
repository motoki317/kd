import { describe, expect, it } from 'vitest'
import { ruleHasWildcardVerb } from './rbac'

describe('ruleHasWildcardVerb', () => {
  it('flags a rule whose verbs are (or include) the wildcard — it can do anything', () => {
    expect(ruleHasWildcardVerb('*.*: *')).toBe(true) // cluster-admin shape
    expect(ruleHasWildcardVerb('secrets: get, *, list')).toBe(true)
    expect(ruleHasWildcardVerb('pods [web-0]: *')).toBe(true)
  })
  it('does not flag a bounded verb set', () => {
    expect(ruleHasWildcardVerb('pods, pods/log: get, list, watch')).toBe(false)
    expect(ruleHasWildcardVerb('deployments.apps: get, update')).toBe(false)
  })
  it('reads only the verbs — a wildcard in a non-resource URL path is not a wildcard verb', () => {
    expect(ruleHasWildcardVerb('/api/*: get')).toBe(false)
    expect(ruleHasWildcardVerb('/healthz, /metrics/*: get')).toBe(false)
  })
})
