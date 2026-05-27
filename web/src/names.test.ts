import { describe, expect, it } from 'vitest'
import { middleTruncate, relativeName } from './names'

describe('relativeName', () => {
  it('strips the owner prefix following the generated-name convention', () => {
    expect(relativeName('api-7d9f-2xkp', 'api-7d9f')).toBe('2xkp')
    expect(relativeName('api-7d9f', 'api')).toBe('7d9f')
  })
  it('leaves the name when the owner is not a prefix (e.g. a Node hosting a pod)', () => {
    expect(relativeName('api-7d9f-2xkp', 'docker-desktop')).toBe('api-7d9f-2xkp')
    expect(relativeName('web', undefined)).toBe('web')
  })
  it('does not strip when it would leave an empty string', () => {
    expect(relativeName('api', 'api')).toBe('api')
  })
})

describe('middleTruncate', () => {
  it('keeps short names intact', () => {
    expect(middleTruncate('web', 22)).toBe('web')
  })
  it('keeps head and tail, dropping the middle', () => {
    const out = middleTruncate('sample-app-with-a-very-long-name-5c4', 22)
    expect(out.length).toBe(22)
    expect(out.startsWith('sample')).toBe(true)
    expect(out.endsWith('5c4')).toBe(true)
    expect(out).toContain('…')
  })
})
