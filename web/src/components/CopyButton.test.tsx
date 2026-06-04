import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CopyButton from './CopyButton'

afterEach(cleanup)

// Stub the clipboard so the tests assert what would be written. jsdom doesn't ship a working
// navigator.clipboard, and we don't want the test runner to actually mutate the host clipboard.
let written: string[] = []
beforeEach(() => {
  written = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn((s: string) => { written.push(s); return Promise.resolve() }) },
  })
})

describe('CopyButton', () => {
  it('plain click copies the primary text', async () => {
    const { container } = render(() => <CopyButton text={() => 'plain'} title="Copy name" />)
    const btn = container.querySelector('.copy-btn') as HTMLButtonElement
    fireEvent.click(btn)
    await Promise.resolve() // let the click handler's await settle
    expect(written).toEqual(['plain'])
  })

  it('Shift+click copies altText when one is provided (cycle 287)', async () => {
    const { container } = render(() => (
      <CopyButton text={() => 'web'} title="Copy name" altText={() => 'Pod/web'} altTitle="for Kind/name" />
    ))
    const btn = container.querySelector('.copy-btn') as HTMLButtonElement
    fireEvent.click(btn, { shiftKey: true })
    await Promise.resolve()
    expect(written).toEqual(['Pod/web'])
  })

  it('Shift+click without altText still copies the primary text', async () => {
    const { container } = render(() => <CopyButton text={() => 'only'} />)
    const btn = container.querySelector('.copy-btn') as HTMLButtonElement
    fireEvent.click(btn, { shiftKey: true })
    await Promise.resolve()
    expect(written).toEqual(['only'])
  })

  it('exposes altTitle in the tooltip so the modifier is discoverable', () => {
    const { container } = render(() => (
      <CopyButton text={() => 'x'} title="Copy" altText={() => 'X/x'} altTitle="for Kind/name" />
    ))
    const btn = container.querySelector('.copy-btn') as HTMLButtonElement
    expect(btn.getAttribute('title')).toMatch(/Shift\+click for Kind\/name/)
  })

  it('has a stable aria-label and announces the copy via a polite live region', async () => {
    const { container } = render(() => <CopyButton text={() => 'plain'} title="Copy name" />)
    const btn = container.querySelector('.copy-btn') as HTMLButtonElement
    // The accessible name stays the descriptive title, not the toggling "Copy"/"Copied" text.
    expect(btn.getAttribute('aria-label')).toBe('Copy name')
    const status = container.querySelector('[role="status"]')!
    expect(status.classList.contains('sr-only')).toBe(true)
    expect(status.textContent).toBe('') // nothing announced until a copy happens
    fireEvent.click(btn)
    await Promise.resolve()
    // After a successful copy the live region populates, so a screen reader hears the confirmation.
    expect(status.textContent).toBe('Copied to clipboard')
  })
})
