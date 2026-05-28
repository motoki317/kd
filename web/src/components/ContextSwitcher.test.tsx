import { describe, expect, it } from 'vitest'
import { shortContextName } from './ContextSwitcher'

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
})
