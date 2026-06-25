import { describe, expect, it } from 'vitest'
import { showCommitChip } from './buildInfo'

// Fictional SHAs (abc1234…) per the leakage rule — never a real commit from this repo.
describe('showCommitChip', () => {
  it('shows the chip on a clean semver tag — the tag carries no SHA', () => {
    expect(showCommitChip({ version: 'v0.3.1', commit: 'abc1234def567890abc1234def567890abc12345' })).toBe(true)
  })

  it('hides the chip off-tag — git describe already embeds the abbreviated SHA', () => {
    expect(showCommitChip({ version: 'v0.3.0-4-gabc1234', commit: 'abc1234def567890abc1234def567890abc12345' })).toBe(false)
  })

  it('hides the chip on a dirty off-tag build', () => {
    expect(showCommitChip({ version: 'v0.3.0-2-gabc1234-dirty', commit: 'abc1234def567890abc1234def567890abc12345' })).toBe(false)
  })

  it('hides the chip when the Nix short rev IS the version', () => {
    expect(showCommitChip({ version: 'abc1234', commit: 'abc1234def567890abc1234def567890abc12345' })).toBe(false)
  })

  it('hides the chip when no VCS info was stamped (dev/unknown)', () => {
    expect(showCommitChip({ version: 'dev', commit: 'unknown' })).toBe(false)
  })
})
