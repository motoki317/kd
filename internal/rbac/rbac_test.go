package rbac

import (
	"slices"
	"testing"
)

// mustParse builds an Enforcer from policy text with the given default role.
func mustEnforcer(t *testing.T, policyCSV, defaultRole string) *Enforcer {
	t.Helper()
	p, err := Parse(policyCSV, defaultRole)
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	return NewEnforcer(p)
}

func TestEnforce(t *testing.T) {
	tests := []struct {
		name        string
		policy      string
		defaultRole string
		user        string
		groups      []string
		ns          string
		resource    string
		action      string
		want        bool
	}{
		{
			name:        "default readonly lets any user read pods",
			defaultRole: "role:readonly",
			user:        "anyone",
			ns:          "default", resource: "pods", action: "list",
			want: true,
		},
		{
			name:        "readonly does not grant write actions",
			defaultRole: "role:readonly",
			user:        "anyone",
			ns:          "default", resource: "pods", action: "delete",
			want: false,
		},
		{
			name:        "admin granted to a user permits any action",
			policy:      "g, alice, role:admin",
			defaultRole: "role:readonly",
			user:        "alice",
			ns:          "kube-system", resource: "secrets", action: "delete",
			want: true,
		},
		{
			name:        "admin granted via group membership",
			policy:      "g, team-ops, role:admin",
			defaultRole: "role:readonly",
			user:        "bob", groups: []string{"team-ops"},
			ns: "prod", resource: "nodes", action: "delete",
			want: true,
		},
		{
			name: "explicit deny overrides the readonly default in one namespace",
			policy: `
p, charlie, secret-ns, *, *, deny
`,
			defaultRole: "role:readonly",
			user:        "charlie",
			ns:          "secret-ns", resource: "pods", action: "get",
			want: false,
		},
		{
			name:        "deny in one namespace does not affect others",
			policy:      "p, charlie, secret-ns, *, *, deny",
			defaultRole: "role:readonly",
			user:        "charlie",
			ns:          "default", resource: "pods", action: "get",
			want: true,
		},
		{
			name:        "deny overrides an allow from a group grant (global deny-override)",
			policy:      "g, team-ops, role:admin\np, dana, prod, *, *, deny",
			defaultRole: "role:readonly",
			user:        "dana", groups: []string{"team-ops"},
			ns: "prod", resource: "pods", action: "delete",
			want: false,
		},
		{
			name:        "lockdown: no default role denies unknown users",
			defaultRole: "",
			user:        "stranger",
			ns:          "default", resource: "pods", action: "list",
			want: false,
		},
		{
			name:        "namespace glob scopes an explicit grant",
			policy:      "p, dev, team-a-*, pods, get, allow",
			defaultRole: "",
			user:        "dev",
			ns:          "team-a-web", resource: "pods", action: "get",
			want: true,
		},
		{
			name:        "namespace glob does not match a different prefix",
			policy:      "p, dev, team-a-*, pods, get, allow",
			defaultRole: "",
			user:        "dev",
			ns:          "team-b-web", resource: "pods", action: "get",
			want: false,
		},
		{
			name:        "custom role via g inheritance under lockdown",
			policy:      "g, eve, role:viewer\np, role:viewer, *, pods, get, allow",
			defaultRole: "",
			user:        "eve",
			ns:          "default", resource: "pods", action: "get",
			want: true,
		},
		{
			name:        "empty effect defaults to allow",
			policy:      "p, frank, default, pods, get",
			defaultRole: "",
			user:        "frank",
			ns:          "default", resource: "pods", action: "get",
			want: true,
		},
		{
			name:        "cluster-scoped resources match under the cluster namespace token",
			policy:      "p, ops, cluster, nodes, get, allow",
			defaultRole: "",
			user:        "ops",
			ns:          "cluster", resource: "nodes", action: "get",
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := mustEnforcer(t, tt.policy, tt.defaultRole)
			got := e.Enforce(tt.user, tt.groups, tt.ns, tt.resource, tt.action)
			if got != tt.want {
				t.Errorf("Enforce(%q, %v, %q, %q, %q) = %v, want %v",
					tt.user, tt.groups, tt.ns, tt.resource, tt.action, got, tt.want)
			}
		})
	}
}

// TestEnforceAny locks the dual-class contract: a request authorized against multiple
// resource strings (legacy class + GVR group) allows when ANY class is allowed and no
// class is denied. Used by api.authorizeAny to dispatch CR + cluster-scoped kind URLs.
func TestEnforceAny(t *testing.T) {
	tests := []struct {
		name      string
		policy    string
		user      string
		resources []string
		want      bool
	}{
		{
			name:      "allow via legacy class while group has no rule",
			policy:    "p, alice, *, workloads, *, allow",
			user:      "alice",
			resources: []string{"workloads", "argoproj.io"},
			want:      true,
		},
		{
			name:      "allow via group class while legacy has no rule",
			policy:    "p, alice, *, argoproj.io, *, allow",
			user:      "alice",
			resources: []string{"workloads", "argoproj.io"},
			want:      true,
		},
		{
			name:      "deny on EITHER class wins (global deny-override across classes)",
			policy:    "p, alice, *, workloads, *, allow\np, alice, *, argoproj.io, *, deny",
			user:      "alice",
			resources: []string{"workloads", "argoproj.io"},
			want:      false,
		},
		{
			name:      "no matching rule on either class → forbid",
			policy:    "p, alice, *, pods, *, allow",
			user:      "alice",
			resources: []string{"workloads", "argoproj.io"},
			want:      false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := mustEnforcer(t, tc.policy, "")
			got := e.EnforceAny(tc.user, nil, "shop", tc.resources, "get")
			if got != tc.want {
				t.Errorf("EnforceAny = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVisibleNamespaces(t *testing.T) {
	all := []string{"default", "prod", "secret-ns", "team-a-web"}

	t.Run("readonly default makes all namespaces visible", func(t *testing.T) {
		e := mustEnforcer(t, "", "role:readonly")
		got := e.VisibleNamespaces("alice", nil, all)
		if !slices.Equal(got, all) {
			t.Errorf("got %v, want %v", got, all)
		}
	})

	t.Run("denied namespace is hidden from the picker", func(t *testing.T) {
		e := mustEnforcer(t, "p, alice, secret-ns, *, *, deny", "role:readonly")
		got := e.VisibleNamespaces("alice", nil, all)
		want := []string{"default", "prod", "team-a-web"}
		if !slices.Equal(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("lockdown shows only explicitly granted namespaces", func(t *testing.T) {
		e := mustEnforcer(t, "p, dev, team-a-*, pods, list, allow", "")
		got := e.VisibleNamespaces("dev", nil, all)
		want := []string{"team-a-web"}
		if !slices.Equal(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		name   string
		policy string
	}{
		{"unknown line type", "x, a, b, c"},
		{"permission with too few fields", "p, alice, default"},
		{"grouping with wrong field count", "g, alice"},
		{"invalid effect", "p, alice, default, pods, get, maybe"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Parse(tt.policy, "role:readonly"); err == nil {
				t.Errorf("Parse(%q) = nil error, want error", tt.policy)
			}
		})
	}
}

func TestParseIgnoresCommentsAndBlankLines(t *testing.T) {
	policy := `
# this is a comment
p, alice, default, pods, get, allow

  # indented comment
`
	e := mustEnforcer(t, policy, "")
	if !e.Enforce("alice", nil, "default", "pods", "get") {
		t.Error("expected alice to be allowed after parsing comments/blanks")
	}
}
