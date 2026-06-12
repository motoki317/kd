package rbac

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"time"
)

// LoadFile reads and parses a policy.yaml from path. An empty path yields the built-in
// default policy — every authenticated user is a viewer — so no file is required for the
// common read-everything case.
func LoadFile(path string) (*Policy, error) {
	if path == "" {
		return Parse(nil)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("rbac: read policy file: %w", err)
	}
	return Parse(data)
}

// fileReloader reparses a policy file and swaps it into an Enforcer when its content changes.
type fileReloader struct {
	path     string
	enforcer *Enforcer
	lastSum  [sha256.Size]byte
	seen     bool // whether lastSum holds the content of a prior attempt (valid or malformed)
}

// reloadIfChanged reloads the policy iff the file content differs from the last content seen. It
// reports whether a successful reload happened. lastSum advances on every attempt — including a
// failed parse — so an unchanged malformed file is parsed (and its error surfaced) exactly once
// rather than on every poll; only a genuine content change re-triggers a parse. A parse error
// leaves the current policy in place.
func (fr *fileReloader) reloadIfChanged() (bool, error) {
	data, err := os.ReadFile(fr.path)
	if err != nil {
		return false, fmt.Errorf("rbac: read policy file: %w", err)
	}
	sum := sha256.Sum256(data)
	if fr.seen && sum == fr.lastSum {
		return false, nil
	}
	fr.seen = true
	fr.lastSum = sum
	policy, err := Parse(data)
	if err != nil {
		return false, fmt.Errorf("rbac: parse policy file: %w", err)
	}
	fr.enforcer.Replace(policy)
	return true, nil
}

// WatchFile polls path every interval and hot-reloads the enforcer's policy when the file
// content changes. onReload, if non-nil, is called after each reload attempt that changed the
// file or failed, so the caller can log it. It runs until ctx is cancelled.
func WatchFile(ctx context.Context, e *Enforcer, path string, interval time.Duration, onReload func(error)) {
	fr := &fileReloader{path: path, enforcer: e}
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
