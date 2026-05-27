package rbac

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"time"
)

// LoadFile reads and parses a policy.csv from path. An empty path yields a policy with only
// the built-in roles and the given default role (no file required for the common readonly case).
func LoadFile(path, defaultRole string) (*Policy, error) {
	if path == "" {
		return Parse("", defaultRole)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("rbac: read policy file: %w", err)
	}
	return Parse(string(data), defaultRole)
}

// fileReloader reparses a policy file and swaps it into an Enforcer when its content changes.
type fileReloader struct {
	path        string
	defaultRole string
	enforcer    *Enforcer
	lastSum     [sha256.Size]byte
	loaded      bool
}

// reloadIfChanged reloads the policy iff the file content differs from the last load. It
// reports whether a reload happened. A parse error leaves the current policy in place.
func (fr *fileReloader) reloadIfChanged() (bool, error) {
	data, err := os.ReadFile(fr.path)
	if err != nil {
		return false, fmt.Errorf("rbac: read policy file: %w", err)
	}
	sum := sha256.Sum256(data)
	if fr.loaded && sum == fr.lastSum {
		return false, nil
	}
	policy, err := Parse(string(data), fr.defaultRole)
	if err != nil {
		return false, fmt.Errorf("rbac: parse policy file: %w", err)
	}
	fr.enforcer.Replace(policy)
	fr.lastSum = sum
	fr.loaded = true
	return true, nil
}

// WatchFile polls path every interval and hot-reloads the enforcer's policy when the file
// content changes. onReload, if non-nil, is called after each reload attempt that changed the
// file or failed, so the caller can log it. It runs until ctx is cancelled.
func WatchFile(ctx context.Context, e *Enforcer, path, defaultRole string, interval time.Duration, onReload func(error)) {
	fr := &fileReloader{path: path, defaultRole: defaultRole, enforcer: e}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if changed, err := fr.reloadIfChanged(); (changed || err != nil) && onReload != nil {
				onReload(err)
			}
		}
	}
}
