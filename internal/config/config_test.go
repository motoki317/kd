package config

import (
	"net/netip"
	"testing"
	"time"
)

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
		name        string
		cfg         Config
		inCluster   bool
		wantUser    string
		wantAutoEnb bool
	}{
		{
			name:        "local, nothing configured: auto-enables dev",
			cfg:         Config{UserHeader: DefaultUserHeader},
			inCluster:   false,
			wantUser:    AutoDevUser,
			wantAutoEnb: true,
		},
		{
			name:        "in-cluster: never auto-enables",
			cfg:         Config{UserHeader: DefaultUserHeader},
			inCluster:   true,
			wantUser:    "",
			wantAutoEnb: false,
		},
		{
			name:        "explicit dev-user always wins over auto",
			cfg:         Config{UserHeader: DefaultUserHeader, DevUser: "alice"},
			inCluster:   false,
			wantUser:    "alice",
			wantAutoEnb: false,
		},
		{
			name:        "explicit dev-user respected in-cluster too",
			cfg:         Config{UserHeader: DefaultUserHeader, DevUser: "alice"},
			inCluster:   true,
			wantUser:    "alice",
			wantAutoEnb: false,
		},
		{
			name:        "trusted-proxies set: suppresses auto (real proxy assumed)",
			cfg:         Config{UserHeader: DefaultUserHeader, TrustedProxies: cidr},
			inCluster:   false,
			wantUser:    "",
			wantAutoEnb: false,
		},
		{
			name:        "non-default user-header: suppresses auto",
			cfg:         Config{UserHeader: "X-Auth-User"},
			inCluster:   false,
			wantUser:    "",
			wantAutoEnb: false,
		},
		{
			name:        "groups-header set: suppresses auto",
			cfg:         Config{UserHeader: DefaultUserHeader, GroupsHeader: "X-Forwarded-Groups"},
			inCluster:   false,
			wantUser:    "",
			wantAutoEnb: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			user, auto := tt.cfg.EffectiveDevUser(tt.inCluster)
			if user != tt.wantUser || auto != tt.wantAutoEnb {
				t.Errorf("EffectiveDevUser(%v) = (%q, %v), want (%q, %v)",
					tt.inCluster, user, auto, tt.wantUser, tt.wantAutoEnb)
			}
		})
	}
}
