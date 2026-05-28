// Package kubeconfig exposes the merged kubeconfig: the list of declared contexts, the
// kubeconfig's current-context, and a builder for a per-context rest.Config. Used by the
// context registry to enumerate kubectl contexts when kd runs against a local kubeconfig
// (i.e., not in-cluster).
package kubeconfig

import (
	"fmt"
	"sort"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Loader resolves contexts from a merged kubeconfig snapshot taken at construction time.
// Reloading the file at runtime is intentionally out of scope; restart kd to pick up changes.
type Loader struct {
	rules    *clientcmd.ClientConfigLoadingRules
	contexts []string
	current  string
}

// Load reads the merged kubeconfig. If explicitPath is empty, kubectl's default loading rules
// (KUBECONFIG env + ~/.kube/config) apply.
func Load(explicitPath string) (*Loader, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if explicitPath != "" {
		rules.ExplicitPath = explicitPath
	}
	cfg, err := rules.Load()
	if err != nil {
		return nil, fmt.Errorf("kubeconfig: load: %w", err)
	}
	names := make([]string, 0, len(cfg.Contexts))
	for name := range cfg.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return &Loader{rules: rules, contexts: names, current: cfg.CurrentContext}, nil
}

// Contexts returns the declared context names, sorted.
func (l *Loader) Contexts() []string { return l.contexts }

// Current returns the kubeconfig's current-context name (may be empty if unset).
func (l *Loader) Current() string { return l.current }

// RESTConfig builds a rest.Config that targets the given context. Empty name uses the
// kubeconfig's current-context.
func (l *Loader) RESTConfig(contextName string) (*rest.Config, error) {
	overrides := &clientcmd.ConfigOverrides{}
	if contextName != "" {
		overrides.CurrentContext = contextName
	}
	cfg, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(l.rules, overrides).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("kubeconfig: build rest config for context %q: %w", contextName, err)
	}
	return cfg, nil
}
