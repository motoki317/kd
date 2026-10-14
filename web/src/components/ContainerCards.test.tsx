import { cleanup, render } from '@solidjs/testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import ContainerCards from './ContainerCards'

afterEach(cleanup)

describe('ContainerCards container groups', () => {
  it('shows init, app, and ephemeral groups in order and preserves each group order', () => {
    const { container } = render(() => (
      <ContainerCards statuses={[
        { name: 'debug-b', ready: false, state: 'Running', ephemeral: true },
        { name: 'app', ready: true, state: 'Running' },
        { name: 'setup', ready: false, state: 'Terminated: Completed', init: true },
        { name: 'debug-a', ready: false, state: 'Running', ephemeral: true },
      ]} />
    ))
    const groups = [...container.querySelectorAll('.container-group')]
    expect(groups.map((g) => g.querySelector('.container-group-head')?.firstChild?.textContent)).toEqual([
      'Init containers', 'App containers', 'Ephemeral containers',
    ])
    expect(groups.map((g) => g.querySelector('.container-group-count')?.textContent)).toEqual(['1', '1', '2'])
    expect(groups.map((g) => [...g.querySelectorAll('.container-name')].map((n) => n.textContent))).toEqual([
      ['setup'], ['app'], ['debug-b', 'debug-a'],
    ])
  })

  it('shows a running ephemeral state, image, and restarts without a readiness warning or tint', () => {
    const { container } = render(() => (
      <ContainerCards statuses={[
        { name: 'debugger', ready: false, state: 'Running', ephemeral: true, image: 'example/debug:v1', restarts: 2 },
      ]} />
    ))
    expect(container.querySelectorAll('.container-group')).toHaveLength(1)
    expect(container.querySelector('.container-group-head')?.firstChild?.textContent).toBe('Ephemeral containers')
    const card = container.querySelector('.container-card')!
    expect(card.querySelector('.container-state')?.textContent).toBe('Running')
    expect(card.querySelector('.container-state')?.getAttribute('title')).toBeNull()
    expect(card.classList.contains('not-ready')).toBe(false)
    expect(card.classList.contains('h-progressing')).toBe(false)
    expect(card.classList.contains('h-healthy')).toBe(true)
    expect(card.querySelector('.container-image')?.textContent).toContain('example/debug:v1')
    expect(card.querySelector('.container-restarts')?.textContent).toBe('↻ 2')
  })

  it('keeps the single app reading for its OOM alarm when an ephemeral status is present', () => {
    const mi = 1024 * 1024
    const { container } = render(() => (
      <ContainerCards
        statuses={[
          { name: 'app', ready: true, state: 'Running', memLimitBytes: 256 * mi },
          { name: 'debugger', ready: false, state: 'Running', ephemeral: true },
        ]}
        usage={{ memBytes: 240 * mi }}
      />
    ))
    const warnings = container.querySelectorAll('.container-near-limit')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].closest('.container-card')?.querySelector('.container-name')?.textContent).toBe('app')
    expect(warnings[0].textContent).toContain('over 90% of its limit')
  })
})
