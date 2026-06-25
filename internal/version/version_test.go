package version

import "testing"

func TestResolve(t *testing.T) {
	tests := []struct {
		name        string
		ldVersion   string
		ldCommit    string
		vcsRev      string
		vcsModified bool
		wantVersion string
		wantCommit  string
	}{
		{
			name:      "ldflags win over the vcs stamp",
			ldVersion: "v0.3.0-2-gabc1234", ldCommit: "abc1234fullsha",
			vcsRev: "ignored", vcsModified: true,
			wantVersion: "v0.3.0-2-gabc1234", wantCommit: "abc1234fullsha",
		},
		{
			name:   "vcs fallback, clean tree → short commit as version",
			vcsRev: "0123456789abcdef0123456789abcdef01234567",
			// truncated to 12 for the version stand-in; the commit keeps the full sha.
			wantVersion: "0123456789ab", wantCommit: "0123456789abcdef0123456789abcdef01234567",
		},
		{
			name:   "vcs fallback, dirty tree marks the version",
			vcsRev: "0123456789abcdef", vcsModified: true,
			wantVersion: "0123456789ab-dirty", wantCommit: "0123456789abcdef",
		},
		{
			name:        "no data at all → dev/unknown",
			wantVersion: "dev", wantCommit: "unknown",
		},
		{
			name:      "ldflags version, vcs supplies the commit",
			ldVersion: "v1.2.3", vcsRev: "deadbeefcafebabe",
			wantVersion: "v1.2.3", wantCommit: "deadbeefcafebabe",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolve(tt.ldVersion, tt.ldCommit, tt.vcsRev, tt.vcsModified)
			if got.Version != tt.wantVersion || got.Commit != tt.wantCommit {
				t.Errorf("resolve(%q, %q, %q, %v) = %+v; want {Version:%q Commit:%q}",
					tt.ldVersion, tt.ldCommit, tt.vcsRev, tt.vcsModified, got, tt.wantVersion, tt.wantCommit)
			}
		})
	}
}
