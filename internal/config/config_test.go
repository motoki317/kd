package config

import (
	"net/netip"
	"testing"
)

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
