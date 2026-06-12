package rbac

import (
	"slices"
	"strings"
	"testing"
)

// mustEnforcer builds an Enforcer from a policy.yaml document.
func mustEnforcer(t *testing.T, policyYAML string) *Enforcer {
	t.Helper()
	p, err := Parse([]byte(policyYAML))
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	return NewEnforcer(p)
}

func TestEnforce(t *testing.T) {
	tests := []struct {
		name   string
		policy string
		user   string
		groups []string
		ns     string
		// resource/action default to pods/get for brevity.
		resource string
		action   string
		want     bool
	}{
		{
			name: "default viewer lets any user read pods",
			user: "anyone", ns: "default", action: "list",
			want: true,
		},
		{
			name: "viewer does not grant write actions",
			user: "anyone", ns: "default", action: "delete",
			want: false,
		},
		{
			name:   "admin assigned to a user permits any action",
			policy: "users:\n  alice: [admin]",
			user:   "alice", ns: "kube-system", resource: "secrets", action: "delete",
			want: true,
		},
		{
			name:   "admin assigned via group membership",
			policy: "groups:\n  team-ops: [admin]",
			user:   "bob", groups: []string{"team-ops"},
			ns: "prod", resource: "nodes", action: "delete",
			want: true,
		},
		{
			name: "a deny role overrides the viewer default in one namespace",
			policy: `
roles:
  no-secret-ns:
    deny:
      - namespaces: [secret-ns]
users:
  charlie: [no-secret-ns]
`,
			user: "charlie", ns: "secret-ns",
			want: false,
		},
		{
			name: "deny in one namespace does not affect others",
			policy: `
roles:
  no-secret-ns:
    deny:
      - namespaces: [secret-ns]
users:
  charlie: [no-secret-ns]
`,
			user: "charlie", ns: "default",
			want: true,
		},
		{
			name: "deny from one role overrides an allow from another (deny always wins)",
			policy: `
roles:
  no-prod:
    deny:
      - namespaces: [prod]
users:
  dana: [no-prod]
groups:
  team-ops: [admin]
`,
			user: "dana", groups: []string{"team-ops"},
			ns: "prod", action: "delete",
			want: false,
		},
		{
			name: "global deny block binds even an admin",
			policy: `
deny:
  - namespaces: [secure]
    resources: [logs]
users:
  alice: [admin]
`,
			user: "alice", ns: "secure", resource: "logs",
			want: false,
		},
		{
			name:   "lockdown: empty defaultRoles denies unassigned users",
			policy: "defaultRoles: []",
			user:   "stranger", ns: "default", action: "list",
			want: false,
		},
		{
			name: "namespace glob scopes an explicit grant",
			policy: `
defaultRoles: []
roles:
  team-a:
    allow:
      - namespaces: [team-a-*]
        resources: [pods]
        actions: [get]
users:
  dev: [team-a]
`,
			user: "dev", ns: "team-a-web",
			want: true,
		},
		{
			name: "namespace glob does not match a different prefix",
			policy: `
defaultRoles: []
roles:
  team-a:
    allow:
      - namespaces: [team-a-*]
users:
  dev: [team-a]
`,
			user: "dev", ns: "team-b-web",
			want: false,
		},
		{
			name: "omitted rule fields match everything",
			policy: `
defaultRoles: []
roles:
  everything:
    allow:
      - {}
users:
  eve: [everything]
`,
			user: "eve", ns: "default", resource: "secrets", action: "delete",
			want: true,
		},
		{
			name: "multiple values in one rule field",
			policy: `
defaultRoles: []
roles:
  two-teams:
    allow:
      - namespaces: [team-a-*, team-b-*]
users:
  dev: [two-teams]
`,
			user: "dev", ns: "team-b-api",
			want: true,
		},
		{
			name: "clusterScoped rule matches cluster-scoped requests",
			policy: `
defaultRoles: []
roles:
  node-viewer:
    allow:
      - clusterScoped: true
        resources: [nodes]
users:
  ops: [node-viewer]
`,
			user: "ops", ns: ClusterScope, resource: "nodes",
			want: true,
		},
		{
			name: "clusterScoped rule does not match namespaced requests",
			policy: `
defaultRoles: []
roles:
  node-viewer:
    allow:
      - clusterScoped: true
users:
  ops: [node-viewer]
`,
			user: "ops", ns: "default",
			want: false,
		},
		{
			name: "namespace globs never match the cluster scope, not even *",
			policy: `
defaultRoles: []
roles:
  all-namespaces:
    allow:
      - namespaces: ["*"]
users:
  dev: [all-namespaces]
`,
			user: "dev", ns: ClusterScope, resource: "nodes",
			want: false,
		},
		{
			name: "a rule with no scope field covers the cluster scope (viewer default)",
			user: "anyone", ns: ClusterScope, resource: "nodes", action: "list",
			want: true,
		},
		{
			name: "clusterScoped: false keeps an otherwise-unconstrained rule namespaced",
			policy: `
defaultRoles: []
roles:
  namespaced-only:
    allow:
      - clusterScoped: false
users:
  dev: [namespaced-only]
`,
			user: "dev", ns: ClusterScope, resource: "nodes",
			want: false,
		},
		{
			name: "clusterScoped: false still matches every namespace",
			policy: `
defaultRoles: []
roles:
  namespaced-only:
    allow:
      - clusterScoped: false
users:
  dev: [namespaced-only]
`,
			user: "dev", ns: "anything",
			want: true,
		},
		{
			name: "a user's roles do not leak to a group of the same name",
			policy: `
defaultRoles: []
users:
  team-ops: [admin]
`,
			user: "someone", groups: []string{"team-ops"},
			ns:   "default",
			want: false,
		},
		{
			name: "non-default roles grant nothing unless assigned",
			policy: `
defaultRoles: []
roles:
  team-a:
    allow:
      - namespaces: [team-a-*]
`,
			user: "dev", ns: "team-a-web",
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.resource == "" {
				tt.resource = "pods"
			}
			if tt.action == "" {
				tt.action = "get"
			}
			e := mustEnforcer(t, tt.policy)
			got := e.Enforce(tt.user, tt.groups, tt.ns, tt.resource, tt.action)
			if got != tt.want {
				t.Errorf("Enforce(%q, %v, %q, %q, %q) = %v, want %v",
					tt.user, tt.groups, tt.ns, tt.resource, tt.action, got, tt.want)
			}
		})
	}
}

// TestEnforceAny locks the dual-class contract: a request authorized against multiple
// resource strings (coarse class + API group) allows when ANY class is allowed and no
// class is denied. Used by api.authorizeAny to dispatch CR + cluster-scoped kind URLs.
func TestEnforceAny(t *testing.T) {
	policy := func(allowRes, denyRes string) string {
		var b strings.Builder
		b.WriteString("defaultRoles: []\nroles:\n  test:\n")
		if allowRes != "" {
			b.WriteString("    allow:\n      - resources: [" + allowRes + "]\n")
		}
		if denyRes != "" {
			b.WriteString("    deny:\n      - resources: [" + denyRes + "]\n")
		}
		b.WriteString("users:\n  alice: [test]\n")
		return b.String()
	}
	tests := []struct {
		name      string
		policy    string
		resources []string
		want      bool
	}{
		{
			name:      "allow via coarse class while group has no rule",
			policy:    policy("workloads", ""),
			resources: []string{"workloads", "argoproj.io"},
			want:      true,
		},
		{
			name:      "allow via API group while coarse class has no rule",
			policy:    policy("argoproj.io", ""),
			resources: []string{"workloads", "argoproj.io"},
			want:      true,
		},
		{
			name:      "deny on EITHER class wins (deny-override across classes)",
			policy:    policy("workloads", "argoproj.io"),
			resources: []string{"workloads", "argoproj.io"},
			want:      false,
		},
		{
			name:      "no matching rule on either class forbids",
			policy:    policy("pods", ""),
			resources: []string{"workloads", "argoproj.io"},
			want:      false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			e := mustEnforcer(t, tc.policy)
			got := e.EnforceAny("alice", nil, "shop", tc.resources, "get")
			if got != tc.want {
				t.Errorf("EnforceAny = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVisibleNamespaces(t *testing.T) {
	all := []string{"default", "prod", "secret-ns", "team-a-web"}

	t.Run("viewer default makes all namespaces visible", func(t *testing.T) {
		e := mustEnforcer(t, "")
		got := e.VisibleNamespaces("alice", nil, all)
		if !slices.Equal(got, all) {
			t.Errorf("got %v, want %v", got, all)
		}
	})

	t.Run("denied namespace is hidden from the picker", func(t *testing.T) {
		e := mustEnforcer(t, `
roles:
  no-secret-ns:
    deny:
      - namespaces: [secret-ns]
users:
  alice: [no-secret-ns]
`)
		got := e.VisibleNamespaces("alice", nil, all)
		want := []string{"default", "prod", "team-a-web"}
		if !slices.Equal(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})

	t.Run("lockdown shows only explicitly granted namespaces", func(t *testing.T) {
		e := mustEnforcer(t, `
defaultRoles: []
roles:
  team-a:
    allow:
      - namespaces: [team-a-*]
        resources: [pods]
        actions: [list]
users:
  dev: [team-a]
`)
		got := e.VisibleNamespaces("dev", nil, all)
		want := []string{"team-a-web"}
		if !slices.Equal(got, want) {
			t.Errorf("got %v, want %v", got, want)
		}
	})
}

// TestParseErrors pins the validation contract: every mistake a policy author plausibly
// makes must fail the parse with guidance, never silently change what is granted.
func TestParseErrors(t *testing.T) {
	tests := []struct {
		name    string
		policy  string
		wantErr string // substring the error must carry so the message stays actionable
	}{
		{
			name:    "not yaml",
			policy:  "p, alice, default, pods, get",
			wantErr: "policy.yaml",
		},
		{
			name:    "unknown top-level key (typo)",
			policy:  "rules:\n  - {}",
			wantErr: "rules",
		},
		{
			name: "unknown rule field (singular typo)",
			policy: `
roles:
  team-a:
    allow:
      - namespace: [team-a]
`,
			wantErr: "namespace",
		},
		{
			name:    "users referencing an undefined role",
			policy:  "users:\n  alice: [adminn]",
			wantErr: `undefined role "adminn"`,
		},
		{
			name:    "groups referencing an undefined role",
			policy:  "groups:\n  ops: [viewers]",
			wantErr: `undefined role "viewers"`,
		},
		{
			name:    "defaultRoles referencing an undefined role",
			policy:  "defaultRoles: [readonly]",
			wantErr: `undefined role "readonly"`,
		},
		{
			name:    "redefining a built-in role",
			policy:  "roles:\n  viewer:\n    allow:\n      - {}",
			wantErr: "built in",
		},
		{
			name: "explicitly empty rule field",
			policy: `
roles:
  team-a:
    allow:
      - namespaces: []
`,
			wantErr: "empty list",
		},
		{
			name: "clusterScoped: true combined with namespaces",
			policy: `
roles:
  confused:
    allow:
      - clusterScoped: true
        namespaces: [team-a]
`,
			wantErr: "either cluster-scoped resources or namespaces",
		},
		{
			name: "clusterScoped with a non-boolean value",
			policy: `
roles:
  team-a:
    allow:
      - clusterScoped: yes please
`,
			wantErr: "clusterScoped",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse([]byte(tt.policy))
			if err == nil {
				t.Fatalf("Parse(%q) = nil error, want error containing %q", tt.policy, tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("Parse error %q does not contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestParseDefaults(t *testing.T) {
	t.Run("empty document yields the viewer default", func(t *testing.T) {
		e := mustEnforcer(t, "")
		if !e.Enforce("anyone", nil, "default", "pods", "get") {
			t.Error("expected the empty policy to default everyone to viewer")
		}
		if e.Enforce("anyone", nil, "default", "pods", "delete") {
			t.Error("expected the viewer default to stay read-only")
		}
	})

	t.Run("comments and empty sections parse", func(t *testing.T) {
		e := mustEnforcer(t, `
# kd policy
defaultRoles: [viewer]
roles: {}
users: {}
groups: {}
deny: []
`)
		if !e.Enforce("anyone", nil, "default", "pods", "get") {
			t.Error("expected explicit defaults to behave like the empty policy")
		}
	})

	t.Run("description is accepted and ignored", func(t *testing.T) {
		e := mustEnforcer(t, `
roles:
  team-a:
    description: Read access to team-a's namespaces.
    allow:
      - namespaces: [team-a-*]
users:
  dev: [team-a]
`)
		if !e.Enforce("dev", nil, "team-a-web", "pods", "get") {
			t.Error("expected the described role to grant access")
		}
	})
}

// globMatch backs every policy wildcard (namespace/resource/action). A wrong match here silently
// grants or denies access, so pin all the wildcard positions directly — the enforcer tests only
// exercise a couple of them.
func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, value string
		want           bool
	}{
		{"*", "anything", true},
		{"*", "", true},
		{"prod", "prod", true},       // exact, no wildcard
		{"prod", "prod-web", false},  // no wildcard, not equal
		{"prod-*", "prod-web", true}, // prefix
		{"prod-*", "dev-web", false},
		{"*-prod", "web-prod", true}, // suffix
		{"*-prod", "web-dev", false},
		{"a*c", "abc", true},    // single middle segment
		{"a*c", "axxxxc", true}, // greedy middle
		{"a*c", "abd", false},
		{"a*b*c", "axbyc", true}, // two wildcards, ordered middle segments
		{"a*b*c", "axbyd", false},
		{"a*b*c", "acb", false}, // segments out of order
	}
	for _, c := range cases {
		if got := globMatch(c.pattern, c.value); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", c.pattern, c.value, got, c.want)
		}
	}
}
