import { describe, expect, it } from 'vitest'
import { isFloatingImageTag } from './ResourceSummary'

describe('isFloatingImageTag', () => {
  it('treats a digest reference as pinned', () => {
    expect(isFloatingImageTag('nginx@sha256:abc')).toBe(false)
    expect(isFloatingImageTag('registry.example.com/team/app:v1@sha256:def')).toBe(false)
  })

  it('treats a versioned tag as pinned', () => {
    expect(isFloatingImageTag('nginx:1.25')).toBe(false)
    expect(isFloatingImageTag('registry.example.com/team/app:v2.3.4')).toBe(false)
  })

  it('flags an image without any tag as floating (implicit :latest)', () => {
    expect(isFloatingImageTag('nginx')).toBe(true)
    expect(isFloatingImageTag('registry.example.com/team/app')).toBe(true)
  })

  it('flags well-known moving pointers as floating', () => {
    expect(isFloatingImageTag('nginx:latest')).toBe(true)
    expect(isFloatingImageTag('foo:stable')).toBe(true)
    expect(isFloatingImageTag('foo:main')).toBe(true)
    expect(isFloatingImageTag('foo:master')).toBe(true)
    expect(isFloatingImageTag('foo:edge')).toBe(true)
  })

  it('does not confuse a registry port for a missing tag', () => {
    expect(isFloatingImageTag('registry:5000/app:1.2.3')).toBe(false)
    expect(isFloatingImageTag('registry:5000/app')).toBe(true)
  })

  it('is case-insensitive on the floating tag itself', () => {
    expect(isFloatingImageTag('foo:LATEST')).toBe(true)
    expect(isFloatingImageTag('foo:Main')).toBe(true)
  })
})
