package rbac

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const aliceAdminYAML = "users:\n  alice: [admin]\n"

func TestLoadFile(t *testing.T) {
	t.Run("empty path yields the built-in default policy", func(t *testing.T) {
		p, err := LoadFile("")
		if err != nil {
			t.Fatalf("LoadFile: %v", err)
		}
		if !NewEnforcer(p).Enforce("anyone", nil, "default", "pods", "get") {
			t.Error("expected the viewer default to allow get")
		}
	})

	t.Run("reads and parses a policy file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "policy.yaml")
		if err := os.WriteFile(path, []byte(aliceAdminYAML), 0o600); err != nil {
			t.Fatal(err)
		}
		p, err := LoadFile(path)
		if err != nil {
			t.Fatalf("LoadFile: %v", err)
		}
		if !NewEnforcer(p).Enforce("alice", nil, "any", "secrets", "delete") {
			t.Error("expected alice to be admin from the loaded file")
		}
	})

	t.Run("missing file is an error", func(t *testing.T) {
		if _, err := LoadFile(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
			t.Error("expected error for missing file")
		}
	})
}

// userPodsGetYAML grants exactly pods/get in the default namespace to one user, under lockdown.
func userPodsGetYAML(user string) string {
	return `
defaultRoles: []
roles:
  pods-get:
    allow:
      - namespaces: [default]
        resources: [pods]
        actions: [get]
users:
  ` + user + `: [pods-get]
`
}

func TestReloadIfChanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.yaml")
	if err := os.WriteFile(path, []byte(userPodsGetYAML("alice")), 0o600); err != nil {
		t.Fatal(err)
	}

	e := mustEnforcer(t, "defaultRoles: []") // start locked down
	fr := &fileReloader{path: path, enforcer: e}

	// First reload picks up the initial file content.
	changed, err := fr.reloadIfChanged()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !changed {
		t.Fatal("expected first reload to report a change")
	}
	if !e.Enforce("alice", nil, "default", "pods", "get") {
		t.Error("expected alice allowed after first reload")
	}

	// No change → no reload.
	if changed, _ := fr.reloadIfChanged(); changed {
		t.Error("expected no change on unmodified file")
	}

	// Rewriting the file with new content triggers a reload.
	if err := os.WriteFile(path, []byte(userPodsGetYAML("bob")), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err = fr.reloadIfChanged()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !changed {
		t.Fatal("expected reload after content change")
	}
	if e.Enforce("alice", nil, "default", "pods", "get") {
		t.Error("expected alice no longer allowed after policy replaced")
	}
	if !e.Enforce("bob", nil, "default", "pods", "get") {
		t.Error("expected bob allowed after policy replaced")
	}
}

func TestReloadSkipsUnchangedMalformedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.yaml")
	if err := os.WriteFile(path, []byte(userPodsGetYAML("alice")), 0o600); err != nil {
		t.Fatal(err)
	}
	e := mustEnforcer(t, "defaultRoles: []")
	fr := &fileReloader{path: path, enforcer: e}

	if changed, err := fr.reloadIfChanged(); err != nil || !changed {
		t.Fatalf("first reload: changed=%v err=%v", changed, err)
	}

	// Corrupt the file. The first poll after the change parses it, fails, and reports the error
	// once; the last-good policy stays active (Replace is not called on error).
	if err := os.WriteFile(path, []byte("users:\n  alice: [no-such-role]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := fr.reloadIfChanged()
	if err == nil {
		t.Fatal("expected a parse error on the malformed file")
	}
	if changed {
		t.Error("a malformed file must not report a successful reload")
	}
	if !e.Enforce("alice", nil, "default", "pods", "get") {
		t.Error("the last-good policy should remain active after a parse error")
	}

	// The fixed bug: a later poll of the SAME malformed content must be treated as unchanged, not
	// re-parsed and re-errored every interval (which previously spammed the logs every poll).
	if changed, err := fr.reloadIfChanged(); changed || err != nil {
		t.Errorf("unchanged malformed file should be skipped, got changed=%v err=%v", changed, err)
	}

	// Fixing the file (new valid content) must re-trigger a successful reload.
	if err := os.WriteFile(path, []byte(userPodsGetYAML("bob")), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err = fr.reloadIfChanged()
	if err != nil || !changed {
		t.Fatalf("reload after fix: changed=%v err=%v", changed, err)
	}
	if !e.Enforce("bob", nil, "default", "pods", "get") {
		t.Error("expected bob allowed after the fixed policy loaded")
	}
}

// WatchFile is the ticker loop around reloadIfChanged: it must apply the file on its first tick,
// re-apply on a later edit (so an operator's policy change takes effect without a restart), and stop
// cleanly when the context is cancelled. Timing is generous (a 5ms ticker, 2s waits) to stay robust.
func TestWatchFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.yaml")
	if err := os.WriteFile(path, []byte(aliceAdminYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	e := mustEnforcer(t, "defaultRoles: []") // start locked down
	ctx, cancel := context.WithCancel(context.Background())

	reloads := make(chan error, 4)
	done := make(chan struct{})
	go func() {
		WatchFile(ctx, e, path, 5*time.Millisecond, func(err error) { reloads <- err })
		close(done)
	}()

	waitReload := func(what string) {
		t.Helper()
		select {
		case err := <-reloads:
			if err != nil {
				t.Fatalf("%s: reload error %v", what, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: WatchFile never fired onReload", what)
		}
	}

	// First tick applies the initial file → alice is admin.
	waitReload("initial load")
	if !e.Enforce("alice", nil, "any", "secrets", "delete") {
		t.Error("expected alice admin after the watcher loaded the file")
	}

	// An edit is picked up on a later tick → alice's grant is replaced by bob's.
	if err := os.WriteFile(path, []byte("users:\n  bob: [admin]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitReload("after edit")
	if e.Enforce("alice", nil, "any", "secrets", "delete") {
		t.Error("expected alice's admin revoked after the policy file changed")
	}

	// Cancelling the context returns the loop promptly.
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WatchFile did not return after context cancel")
	}
}
