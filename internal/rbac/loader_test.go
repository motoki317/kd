package rbac

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadFile(t *testing.T) {
	t.Run("empty path yields a defaults-only policy", func(t *testing.T) {
		p, err := LoadFile("", "role:readonly")
		if err != nil {
			t.Fatalf("LoadFile: %v", err)
		}
		if !NewEnforcer(p).Enforce("anyone", nil, "default", "pods", "get") {
			t.Error("expected readonly default to allow get")
		}
	})

	t.Run("reads and parses a policy file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "policy.csv")
		if err := os.WriteFile(path, []byte("g, alice, role:admin\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		p, err := LoadFile(path, "")
		if err != nil {
			t.Fatalf("LoadFile: %v", err)
		}
		if !NewEnforcer(p).Enforce("alice", nil, "any", "secrets", "delete") {
			t.Error("expected alice to be admin from the loaded file")
		}
	})

	t.Run("missing file is an error", func(t *testing.T) {
		if _, err := LoadFile(filepath.Join(t.TempDir(), "nope.csv"), ""); err == nil {
			t.Error("expected error for missing file")
		}
	})
}

func TestReloadIfChanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.csv")
	if err := os.WriteFile(path, []byte("p, alice, default, pods, get, allow\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	e := mustEnforcer(t, "", "") // start locked down
	fr := &fileReloader{path: path, defaultRole: "", enforcer: e}

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
	if err := os.WriteFile(path, []byte("p, bob, default, pods, get, allow\n"), 0o600); err != nil {
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
