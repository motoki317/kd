import { createSignal } from 'solid-js'
import { render } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import ContextSwitcher, { shortContextName } from './ContextSwitcher'
import type { ContextsResponse } from '../api'

describe('shortContextName', () => {
  it('trims an EKS ARN to the cluster name (operators think of clusters by their tail)', () => {
    expect(
      shortContextName('arn:aws:eks:us-west-2:111122223333:cluster/prod-cluster'),
    ).toBe('prod-cluster')
  })

  it('passes through a plain context name unchanged (no "/" → no trim)', () => {
    expect(shortContextName('docker-desktop')).toBe('docker-desktop')
  })

  it('returns the original when the path ends in a trailing slash (no useful tail to extract)', () => {
    expect(shortContextName('weird/')).toBe('weird/')
  })

  it('does NOT split on a colon — only "/" is a trim point (pins the comment contract)', () => {
    // A colon-delimited name with no "/" passes through whole; we never trim to a ":"-suffix.
    expect(shortContextName('cluster:6443')).toBe('cluster:6443')
    // With both, the LAST "/" wins regardless of a later-looking colon prefix.
    expect(shortContextName('arn:aws:eks:us-west-2:111122223333:cluster/prod-cluster')).toBe('prod-cluster')
  })
})

describe('ContextSwitcher', () => {
  const info = (staging: 'ready' | 'pending' | 'error'): ContextsResponse => ({
    enabled: true,
    default: 'docker-desktop',
    contexts: [
      { name: 'staging-cluster', status: staging, error: staging === 'error' ? 'cred expired' : undefined },
      { name: 'prod-cluster', status: 'pending' },
      { name: 'docker-desktop', status: 'ready' },
    ],
  })

  it('keeps the CURRENT context selectable and selected even after it turns error', () => {
    // The dead-credentials walk (D79): the operator switches to a context, its cache build fails,
    // the contexts refetch marks it status=error. Disabling the selected option moved the native
    // selection to the next enabled option, so the topbar named a different cluster than the URL.
    const [i, setI] = createSignal<ContextsResponse>(info('pending'))
    const { container } = render(() => (
      <ContextSwitcher info={i()} current="staging-cluster" onSelect={() => {}} />
    ))
    setI(info('error'))
    const sel = container.querySelector('select')!
    const current = [...sel.options].find((o) => o.value === 'staging-cluster')!
    expect(current.disabled).toBe(false) // never lock out the option the operator is ON
    expect(current.selected).toBe(true) // the displayed name must match the URL truth
    // Other broken contexts stay locked out.
    setI({ ...info('error'), contexts: info('error').contexts.map((c) => (c.name === 'prod-cluster' ? { ...c, status: 'error' as const } : c)) })
    const prod = [...container.querySelector('select')!.options].find((o) => o.value === 'prod-cluster')!
    expect(prod.disabled).toBe(true)
  })
})
