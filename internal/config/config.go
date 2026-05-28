// Package config defines kd's runtime configuration and loads it from flags and environment
// variables (flags take precedence; each flag has a KD_-prefixed env fallback).
package config

import (
	"flag"
	"fmt"
	"net/netip"
	"os"
	"strings"
	"time"
)

// Config is the fully-resolved server configuration.
type Config struct {
	Addr string // listen address, e.g. ":8080"

	// Proxy authentication.
	UserHeader      string
	GroupsHeader    string
	GroupsDelimiter string
	TrustedProxies  []netip.Prefix
	DevUser         string // non-empty enables dev mode (no forward-auth proxy required)

	// Authorization.
	PolicyPath           string
	DefaultRole          string
	PolicyReloadInterval time.Duration

	// Kubernetes.
	Kubeconfig string        // empty = in-cluster, then default kubeconfig
	Resync     time.Duration // informer resync period
	// SkipKinds removes resource names from the eager-load set, on top of the built-in
	// high-cardinality defaults (events, leases, endpointslices, controllerrevisions).
	SkipKinds []string
	// EagerKinds adds resource names back into the eager-load set, overriding both the
	// built-in defaults and SkipKinds. Lets an operator opt back into watching e.g.
	// "events" if they want the full picture.
	EagerKinds []string
}

// Load parses configuration from the given args (typically os.Args[1:]).
func Load(args []string) (Config, error) {
	fs := flag.NewFlagSet("kd", flag.ContinueOnError)
	var (
		c              Config
		trustedProxies string
		skipKinds      string
		eagerKinds     string
	)
	fs.StringVar(&c.Addr, "addr", envOr("KD_ADDR", ":8080"), "HTTP listen address")
	fs.StringVar(&c.UserHeader, "user-header", envOr("KD_USER_HEADER", "X-Forwarded-User"), "request header carrying the authenticated username")
	fs.StringVar(&c.GroupsHeader, "groups-header", envOr("KD_GROUPS_HEADER", ""), "optional request header carrying the user's groups")
	fs.StringVar(&c.GroupsDelimiter, "groups-delimiter", envOr("KD_GROUPS_DELIMITER", ","), "delimiter splitting the groups header value")
	fs.StringVar(&trustedProxies, "trusted-proxies", envOr("KD_TRUSTED_PROXIES", ""), "comma-separated CIDRs allowed to assert the identity header (empty = trust all)")
	fs.StringVar(&c.DevUser, "dev-user", envOr("KD_DEV_USER", ""), "inject a fixed identity and skip header/proxy checks (local dev)")
	fs.StringVar(&c.PolicyPath, "policy", envOr("KD_POLICY", ""), "path to the RBAC policy.csv (empty = built-in defaults only)")
	fs.StringVar(&c.DefaultRole, "default-role", envOr("KD_DEFAULT_ROLE", "role:readonly"), "role implicitly granted to every user (empty locks down)")
	fs.DurationVar(&c.PolicyReloadInterval, "policy-reload-interval", envDurationOr("KD_POLICY_RELOAD_INTERVAL", 10*time.Second), "how often to poll the policy file for changes")
	fs.StringVar(&c.Kubeconfig, "kubeconfig", envOr("KUBECONFIG", ""), "path to kubeconfig (empty = in-cluster, then default)")
	fs.DurationVar(&c.Resync, "resync", envDurationOr("KD_RESYNC", 10*time.Minute), "informer resync period")
	fs.StringVar(&skipKinds, "skip-kinds", envOr("KD_SKIP_KINDS", ""), "comma-separated extra resource names to skip from eager informer startup, on top of the built-in defaults (events, leases, endpointslices, controllerrevisions)")
	fs.StringVar(&eagerKinds, "eager-kinds", envOr("KD_EAGER_KINDS", ""), "comma-separated resource names to force-include in eager startup, overriding both --skip-kinds and the built-in defaults")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	prefixes, err := parsePrefixes(trustedProxies)
	if err != nil {
		return Config{}, err
	}
	c.TrustedProxies = prefixes
	c.SkipKinds = splitCSV(skipKinds)
	c.EagerKinds = splitCSV(eagerKinds)
	return c, nil
}

// splitCSV trims and drops empty entries from a comma-separated list.
func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parsePrefixes(csv string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, part := range strings.Split(csv, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("config: invalid trusted-proxy CIDR %q: %w", part, err)
		}
		out = append(out, p)
	}
	return out, nil
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

func envDurationOr(key string, fallback time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
