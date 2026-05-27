package auth

import (
	"errors"
	"net/http"
	"net/netip"
	"slices"
	"testing"
)

func newRequest(t *testing.T, remoteAddr string, headers map[string]string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodGet, "/", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	r.RemoteAddr = remoteAddr
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	return r
}

func TestIdentify(t *testing.T) {
	prefix := func(s string) netip.Prefix {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			t.Fatalf("parse prefix %q: %v", s, err)
		}
		return p
	}

	tests := []struct {
		name       string
		cfg        Config
		remoteAddr string
		headers    map[string]string
		wantUser   string
		wantGroups []string
		wantErr    error
	}{
		{
			name:       "default header carries the user",
			cfg:        Config{UserHeader: "X-Forwarded-User"},
			headers:    map[string]string{"X-Forwarded-User": "alice"},
			wantUser:   "alice",
			wantGroups: nil,
		},
		{
			name:       "custom header name",
			cfg:        Config{UserHeader: "X-Auth-Request-User"},
			headers:    map[string]string{"X-Auth-Request-User": "bob"},
			wantUser:   "bob",
			wantGroups: nil,
		},
		{
			name:    "missing user header is rejected",
			cfg:     Config{UserHeader: "X-Forwarded-User"},
			headers: map[string]string{},
			wantErr: ErrNoIdentity,
		},
		{
			name:    "blank user header is rejected",
			cfg:     Config{UserHeader: "X-Forwarded-User"},
			headers: map[string]string{"X-Forwarded-User": "   "},
			wantErr: ErrNoIdentity,
		},
		{
			name: "groups parsed, trimmed, and de-blanked",
			cfg:  Config{UserHeader: "X-Forwarded-User", GroupsHeader: "X-Forwarded-Groups"},
			headers: map[string]string{
				"X-Forwarded-User":   "alice",
				"X-Forwarded-Groups": " ops , , dev ",
			},
			wantUser:   "alice",
			wantGroups: []string{"ops", "dev"},
		},
		{
			name:       "no groups header configured yields no groups",
			cfg:        Config{UserHeader: "X-Forwarded-User"},
			headers:    map[string]string{"X-Forwarded-User": "alice", "X-Forwarded-Groups": "ops"},
			wantUser:   "alice",
			wantGroups: nil,
		},
		{
			name:       "dev user overrides everything",
			cfg:        Config{UserHeader: "X-Forwarded-User", DevUser: "dev"},
			headers:    map[string]string{},
			wantUser:   "dev",
			wantGroups: nil,
		},
		{
			name:       "trusted proxy: honored when remote is in range",
			cfg:        Config{UserHeader: "X-Forwarded-User", TrustedProxies: []netip.Prefix{prefix("10.0.0.0/8")}},
			remoteAddr: "10.1.2.3:54321",
			headers:    map[string]string{"X-Forwarded-User": "alice"},
			wantUser:   "alice",
		},
		{
			name:       "trusted proxy: rejected when remote is outside range",
			cfg:        Config{UserHeader: "X-Forwarded-User", TrustedProxies: []netip.Prefix{prefix("10.0.0.0/8")}},
			remoteAddr: "192.168.1.5:1234",
			headers:    map[string]string{"X-Forwarded-User": "alice"},
			wantErr:    ErrUntrustedProxy,
		},
		{
			name:       "dev user bypasses trusted-proxy check",
			cfg:        Config{UserHeader: "X-Forwarded-User", DevUser: "dev", TrustedProxies: []netip.Prefix{prefix("10.0.0.0/8")}},
			remoteAddr: "192.168.1.5:1234",
			wantUser:   "dev",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			remote := tt.remoteAddr
			if remote == "" {
				remote = "10.0.0.1:1111"
			}
			id, err := tt.cfg.Identify(newRequest(t, remote, tt.headers))
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if id.User != tt.wantUser {
				t.Errorf("user = %q, want %q", id.User, tt.wantUser)
			}
			if !slices.Equal(id.Groups, tt.wantGroups) {
				t.Errorf("groups = %v, want %v", id.Groups, tt.wantGroups)
			}
		})
	}
}
