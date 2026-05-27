// Package auth resolves the caller's identity from an upstream proxy-injected header.
//
// kd does not authenticate users itself; it trusts a forward-auth proxy (e.g.
// traefik-forward-auth) to validate the session and inject the identity downstream,
// mirroring the existing Grafana setup. See docs/ADR/20260527-proxy-authentication.md.
package auth

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Identity is the authenticated caller, as asserted by the upstream proxy.
type Identity struct {
	User   string
	Groups []string
}

// Config controls how an Identity is extracted from a request.
type Config struct {
	// UserHeader carries the username (default-set by the caller, e.g. "X-Forwarded-User").
	UserHeader string
	// GroupsHeader optionally carries group membership; empty disables group extraction.
	GroupsHeader string
	// GroupsDelimiter splits the groups header value; empty means ",".
	GroupsDelimiter string
	// TrustedProxies, when non-empty, restricts which peer IPs may assert identity headers.
	TrustedProxies []netip.Prefix
	// DevUser, when set, injects a fixed identity and bypasses header/proxy checks (local dev).
	DevUser string
}

var (
	// ErrNoIdentity indicates the request carried no usable identity header.
	ErrNoIdentity = errors.New("auth: no identity header")
	// ErrUntrustedProxy indicates the peer is not in the trusted-proxy allowlist.
	ErrUntrustedProxy = errors.New("auth: request from untrusted proxy")
)

// Identify extracts the caller's Identity from r, applying the trusted-proxy gate.
func (c Config) Identify(r *http.Request) (Identity, error) {
	if c.DevUser != "" {
		return Identity{User: c.DevUser}, nil
	}

	if len(c.TrustedProxies) > 0 && !c.peerTrusted(r) {
		return Identity{}, ErrUntrustedProxy
	}

	user := strings.TrimSpace(r.Header.Get(c.UserHeader))
	if user == "" {
		return Identity{}, ErrNoIdentity
	}

	return Identity{User: user, Groups: c.groups(r)}, nil
}

func (c Config) groups(r *http.Request) []string {
	if c.GroupsHeader == "" {
		return nil
	}
	delim := c.GroupsDelimiter
	if delim == "" {
		delim = ","
	}
	var groups []string
	for _, g := range strings.Split(r.Header.Get(c.GroupsHeader), delim) {
		if g = strings.TrimSpace(g); g != "" {
			groups = append(groups, g)
		}
	}
	return groups
}

func (c Config) peerTrusted(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	for _, p := range c.TrustedProxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
