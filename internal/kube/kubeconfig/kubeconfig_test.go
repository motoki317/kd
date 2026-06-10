package kubeconfig

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const sampleKubeconfig = `apiVersion: v1
kind: Config
current-context: ctx-b
clusters:
  - name: cluster-a
    cluster:
      server: https://a.example.com
  - name: cluster-b
    cluster:
      server: https://b.example.com
contexts:
  - name: ctx-a
    context: {cluster: cluster-a, user: user-a}
  - name: ctx-b
    context: {cluster: cluster-b, user: user-b}
users:
  - name: user-a
    user: {token: tok-a}
  - name: user-b
    user: {token: tok-b}
`

func writeKubeconfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write kubeconfig: %v", err)
	}
	return path
}

func TestLoadEnumeratesContextsAndCurrent(t *testing.T) {
	l, err := Load(writeKubeconfig(t, sampleKubeconfig))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := l.Contexts(); !slices.Equal(got, []string{"ctx-a", "ctx-b"}) {
		t.Errorf("Contexts() = %v, want sorted [ctx-a ctx-b]", got)
	}
	if l.Current() != "ctx-b" {
		t.Errorf("Current() = %q, want ctx-b", l.Current())
	}
}

func TestRESTConfigTargetsContextServer(t *testing.T) {
	l, err := Load(writeKubeconfig(t, sampleKubeconfig))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// A named context resolves to its cluster's server.
	if cfg, err := l.RESTConfig("ctx-a"); err != nil {
		t.Errorf("RESTConfig(ctx-a): %v", err)
	} else if cfg.Host != "https://a.example.com" {
		t.Errorf("RESTConfig(ctx-a).Host = %q, want a.example.com", cfg.Host)
	}
	// Empty name uses the kubeconfig's current-context (ctx-b → cluster-b).
	if cfg, err := l.RESTConfig(""); err != nil {
		t.Errorf("RESTConfig(current): %v", err)
	} else if cfg.Host != "https://b.example.com" {
		t.Errorf("RESTConfig(current).Host = %q, want b.example.com (current-context)", cfg.Host)
	}
	// An unknown context is an error, not a silent fallback to current.
	if _, err := l.RESTConfig("nonexistent"); err == nil {
		t.Error("RESTConfig(nonexistent) should error")
	}
}

func TestLoadMissingFileErrors(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Error("Load of a missing explicit path should error")
	}
}

func TestLoadContextlessConfigErrors(t *testing.T) {
	// A fresh machine's missing default kubeconfig loads as an EMPTY config (client-go tolerates
	// absent files), which used to surface much later as `registry: unknown context: ""` — Load
	// must fail up front with the actionable setup message instead.
	path := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(path, []byte("apiVersion: v1\nkind: Config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil || !strings.Contains(err.Error(), "no contexts found") {
		t.Errorf("Load of a contextless config = %v, want a 'no contexts found' setup error", err)
	}
}
