// Package version reports the build identity of the running kd binary — the git-describe semver and
// the commit it was cut from. The two values are stamped at link time via -ldflags "-X" on every
// build path (just build, GoReleaser, Docker, Nix); a plain `go build`/`go run` leaves them empty,
// and Get falls back to the VCS metadata the Go toolchain embeds automatically. Surfaced in the UI's
// About card (via the /api/v1/contexts bootstrap) and by `kd --version`.
package version

import (
	"runtime/debug"
	"sync"
)

// Stamped via -ldflags "-X github.com/motoki317/kd/internal/version.version=… -X …commit=…".
// Left empty by a plain build; see resolve for the fallback chain.
var (
	version string
	commit  string
)

// Info is the build identity, JSON-encoded into the contexts bootstrap response and printed by
// `kd --version`.
type Info struct {
	// Version is git-describe output: "v0.3.0" on an exact release tag, "v0.3.0-5-gabc1234" five
	// commits past it (so a non-release build is distinguishable), with a "-dirty" suffix when the
	// work tree had uncommitted changes. "dev" when no VCS data is available.
	Version string `json:"version"`
	// Commit is the full SHA the build was cut from ("unknown" when unavailable).
	Commit string `json:"commit"`
}

var (
	once   sync.Once
	cached Info
)

// Get returns the build identity, resolved once and cached.
func Get() Info {
	once.Do(func() {
		rev, modified := vcsStamp()
		cached = resolve(version, commit, rev, modified)
	})
	return cached
}

// resolve merges the link-time values with the Go-embedded VCS stamp. Pure (no globals, no I/O) so
// every branch is unit-testable. Precedence: ldflags win; else the VCS stamp gives the commit and a
// short-commit stand-in for the (tag-less) version; else dev/unknown placeholders.
func resolve(ldVersion, ldCommit, vcsRev string, vcsModified bool) Info {
	v, c := ldVersion, ldCommit
	if c == "" {
		c = vcsRev
	}
	if v == "" && vcsRev != "" {
		// No tag is recoverable from the VCS stamp (Go embeds the revision, not git describe), so
		// stand in with the short commit, marked dirty for a modified tree — still distinguishable.
		v = vcsRev
		if len(v) > 12 {
			v = v[:12]
		}
		if vcsModified {
			v += "-dirty"
		}
	}
	if v == "" {
		v = "dev"
	}
	if c == "" {
		c = "unknown"
	}
	return Info{Version: v, Commit: c}
}

// vcsStamp reads the revision + dirty flag the Go toolchain embeds for a build inside a work tree
// (no git binary or ldflags required). Empty when build info is unavailable (e.g. some test binaries).
func vcsStamp() (rev string, modified bool) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "", false
	}
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = s.Value
		case "vcs.modified":
			modified = s.Value == "true"
		}
	}
	return rev, modified
}
