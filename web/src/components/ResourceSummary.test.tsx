import { describe, expect, it } from 'vitest'
import { isFloatingImageTag, parseImageRef } from './ResourceSummary'

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

describe('parseImageRef', () => {
  it('splits a full ECR ref into dim prefix, repo name, and emphasised tag', () => {
    expect(parseImageRef('111122223333.dkr.ecr.us-west-2.amazonaws.com/argoproj/argoexec:v4.0.5')).toEqual({
      prefix: '111122223333.dkr.ecr.us-west-2.amazonaws.com/argoproj/',
      name: 'argoexec',
      tag: ':v4.0.5',
    })
  })

  it('keeps the whole digest as the emphasised part', () => {
    expect(parseImageRef('registry.example.com/team/app@sha256:abcdef')).toEqual({
      prefix: 'registry.example.com/team/',
      name: 'app',
      tag: '@sha256:abcdef',
    })
  })

  it('does not treat a registry port as the tag (port stays in the prefix)', () => {
    expect(parseImageRef('registry:5000/app:1.2.3')).toEqual({ prefix: 'registry:5000/', name: 'app', tag: ':1.2.3' })
  })

  it('a bare image has no prefix and an empty (implicit-latest) tag', () => {
    expect(parseImageRef('nginx')).toEqual({ prefix: '', name: 'nginx', tag: '' })
    expect(parseImageRef('nginx:1.25')).toEqual({ prefix: '', name: 'nginx', tag: ':1.25' })
  })
})
