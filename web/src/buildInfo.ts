import type { BuildInfo } from './api'

// Whether the commit deserves its own chip beside the version. git describe stamps an off-tag build
// as "vX.Y.Z-N-gSHA[-dirty]" and the Nix build uses the short rev as the version itself — both
// already carry the hash, so a separate chip just repeats it. Only a clean semver tag ("v0.3.1")
// omits the SHA, so only then does the chip add information.
export function showCommitChip(build: BuildInfo): boolean {
  const { version, commit } = build
  if (!commit || commit === 'unknown') return false
  return !version.includes(commit.slice(0, 7))
}
