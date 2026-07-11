package config

import (
	"errors"
	"flag"
	"net/netip"
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	// No args, no env: the built-in defaults the deployment relies on.
	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load(nil) error: %v", err)
	}
	if c.Addr != ":9123" || c.UserHeader != DefaultUserHeader || c.PolicyPath != "" {
		t.Errorf("defaults = addr %q, user-header %q, policy %q", c.Addr, c.UserHeader, c.PolicyPath)
	}
	if c.PolicyReloadInterval != 10*time.Second || c.Resync != 10*time.Minute {
		t.Errorf("default durations = reload %v, resync %v", c.PolicyReloadInterval, c.Resync)
	}
}

func TestLoadHelpReturnsErrHelp(t *testing.T) {
	// main distinguishes "-h was requested" (clean exit, no ERROR log) from a real config
	// failure by this sentinel — ContinueOnError must keep surfacing it unwrapped-or-wrapped.
	if _, err := Load([]string{"-h"}); !errors.Is(err, flag.ErrHelp) {
		t.Errorf("Load(-h) error = %v, want flag.ErrHelp", err)
	}
}

func TestLoadFlagsOverrideEnv(t *testing.T) {
	// Env sets a default; an explicit flag must win over it.
	t.Setenv("KD_ADDR", ":7000")
	t.Setenv("KD_POLICY", "/etc/kd/policy.yaml")
	c, err := Load([]string{"-addr", ":8080", "-dev-user", "alice", "-skip-kinds", "leases, jobs", "-eager-kinds", "pods"})
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if c.Addr != ":8080" {
		t.Errorf("addr = %q, want :8080 (flag overrides KD_ADDR)", c.Addr)
	}
	if c.PolicyPath != "/etc/kd/policy.yaml" {
		t.Errorf("policy = %q, want /etc/kd/policy.yaml (from env, no flag given)", c.PolicyPath)
	}
	if c.DevUser != "alice" {
		t.Errorf("dev-user = %q, want alice", c.DevUser)
	}
	if len(c.SkipKinds) != 2 || c.SkipKinds[0] != "leases" || c.SkipKinds[1] != "jobs" {
		t.Errorf("skip-kinds = %v, want [leases jobs] (CSV trimmed)", c.SkipKinds)
	}
	if len(c.EagerKinds) != 1 || c.EagerKinds[0] != "pods" {
		t.Errorf("eager-kinds = %v, want [pods]", c.EagerKinds)
	}
}

func TestLoadParsesTrustedProxies(t *testing.T) {
	c, err := Load([]string{"-trusted-proxies", "10.0.0.0/8,192.168.0.0/16"})
	if err != nil {
		t.Fatalf("Load error: %v", err)
	}
	if len(c.TrustedProxies) != 2 {
		t.Errorf("trusted proxies = %v, want 2 prefixes", c.TrustedProxies)
	}
	// An invalid CIDR is a hard error — kd must not silently start trusting nothing/everything.
	if _, err := Load([]string{"-trusted-proxies", "not-a-cidr"}); err == nil {
		t.Error("Load with an invalid trusted-proxies CIDR should error")
	}
}

func TestSplitCSV(t *testing.T) {
	cases := map[string][]string{
		"a,b,c":        {"a", "b", "c"},
		" a , b ,c ":   {"a", "b", "c"}, // trims surrounding space
		"a,,b":         {"a", "b"},      // drops empty entries
		",":            nil,             // only separators → nothing
		"   ":          nil,             // blank → nothing
		"":             nil,
		"single":       {"single"},
		"alice, bob ,": {"alice", "bob"},
	}
	for in, want := range cases {
		got := splitCSV(in)
		if len(got) != len(want) {
			t.Errorf("splitCSV(%q) = %v, want %v", in, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("splitCSV(%q) = %v, want %v", in, got, want)
				break
			}
		}
	}
}

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes(" 10.0.0.0/8 , 192.168.0.0/16 ,")
	if err != nil {
		t.Fatalf("parsePrefixes(valid) error: %v", err)
	}
	if len(got) != 2 || got[0].String() != "10.0.0.0/8" || got[1].String() != "192.168.0.0/16" {
		t.Errorf("parsePrefixes = %v, want [10.0.0.0/8 192.168.0.0/16] (trimmed, empty tail dropped)", got)
	}

	if got, err := parsePrefixes("  "); err != nil || got != nil {
		t.Errorf("parsePrefixes(blank) = (%v, %v), want (nil, nil)", got, err)
	}

	// A non-CIDR value is a configuration error the operator must see, not a silent drop.
	if _, err := parsePrefixes("10.0.0.0/8,not-a-cidr"); err == nil {
		t.Error("parsePrefixes(invalid CIDR) should error, not skip")
	}
}

func TestEnvOr(t *testing.T) {
	const key = "KD_TEST_ENVOR"
	if got := envOr(key, "fallback"); got != "fallback" {
		t.Errorf("envOr(unset) = %q, want fallback", got)
	}
	t.Setenv(key, "explicit")
	if got := envOr(key, "fallback"); got != "explicit" {
		t.Errorf("envOr(set) = %q, want explicit", got)
	}
	// An explicitly-empty env var wins over the fallback (LookupEnv distinguishes set-empty from unset).
	t.Setenv(key, "")
	if got := envOr(key, "fallback"); got != "" {
		t.Errorf("envOr(set-empty) = %q, want \"\" (set-empty overrides fallback)", got)
	}
}

func TestEnvDurationOr(t *testing.T) {
	const key = "KD_TEST_ENVDUR"
	if got := envDurationOr(key, 5*time.Second); got != 5*time.Second {
		t.Errorf("envDurationOr(unset) = %v, want 5s", got)
	}
	t.Setenv(key, "90s")
	if got := envDurationOr(key, 5*time.Second); got != 90*time.Second {
		t.Errorf("envDurationOr(90s) = %v, want 90s", got)
	}
	// A malformed duration falls back rather than erroring — a typo must not zero the timeout.
	t.Setenv(key, "not-a-duration")
	if got := envDurationOr(key, 5*time.Second); got != 5*time.Second {
		t.Errorf("envDurationOr(malformed) = %v, want the 5s fallback", got)
	}
}

func TestEffectiveDevUser(t *testing.T) {
	cidr := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}

	tests := []struct {
		name      string
		cfg       Config
		inCluster bool
		wantUser  string
	}{
		{
			name:      "local, nothing configured: auto-enables dev",
			cfg:       Config{UserHeader: DefaultUserHeader},
			inCluster: false,
			wantUser:  AutoDevUser,
		},
		{
			name:      "in-cluster: never auto-enables",
			cfg:       Config{UserHeader: DefaultUserHeader},
			inCluster: true,
			wantUser:  "",
		},
		{
			name:      "explicit dev-user always wins over auto",
			cfg:       Config{UserHeader: DefaultUserHeader, DevUser: "alice"},
			inCluster: false,
			wantUser:  "alice",
		},
		{
			name:      "explicit dev-user respected in-cluster too",
			cfg:       Config{UserHeader: DefaultUserHeader, DevUser: "alice"},
			inCluster: true,
			wantUser:  "alice",
		},
		{
			name:      "trusted-proxies set: suppresses auto (real proxy assumed)",
			cfg:       Config{UserHeader: DefaultUserHeader, TrustedProxies: cidr},
			inCluster: false,
			wantUser:  "",
		},
		{
			name:      "non-default user-header: suppresses auto",
			cfg:       Config{UserHeader: "X-Auth-User"},
			inCluster: false,
			wantUser:  "",
		},
		{
			name:      "groups-header set: suppresses auto",
			cfg:       Config{UserHeader: DefaultUserHeader, GroupsHeader: "X-Forwarded-Groups"},
			inCluster: false,
			wantUser:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if user := tt.cfg.EffectiveDevUser(tt.inCluster); user != tt.wantUser {
				t.Errorf("EffectiveDevUser(%v) = %q, want %q", tt.inCluster, user, tt.wantUser)
			}
		})
	}
}
