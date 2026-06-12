package rbac

import (
	"fmt"
	"strings"

	"sigs.k8s.io/yaml"
)

// policyFile mirrors the policy.yaml document. The json tags are the user-facing contract
// (sigs.k8s.io/yaml routes YAML through them); parsing is strict so a typo'd key fails
// loudly instead of silently granting nothing.
type policyFile struct {
	// DefaultRoles is a pointer to distinguish "absent" (default: every authenticated
	// user is a viewer) from an explicit empty list (lockdown: only assignments grant).
	DefaultRoles *[]string           `json:"defaultRoles,omitempty"`
	Roles        map[string]roleSpec `json:"roles,omitempty"`
	Users        map[string][]string `json:"users,omitempty"`
	Groups       map[string][]string `json:"groups,omitempty"`
	Deny         []ruleSpec          `json:"deny,omitempty"`
}

type roleSpec struct {
	// Description is for the policy author; kd never interprets it.
	Description string     `json:"description,omitempty"`
	Allow       []ruleSpec `json:"allow,omitempty"`
	Deny        []ruleSpec `json:"deny,omitempty"`
}

type ruleSpec struct {
	Namespaces []string `json:"namespaces,omitempty"`
	// ClusterScoped: true targets cluster-scoped resources (Nodes, PVs, CRDs, …); false
	// restricts the rule to namespaced resources. A pointer so "omitted" stays
	// distinguishable: a rule with no scope field at all matches both worlds.
	ClusterScoped *bool    `json:"clusterScoped,omitempty"`
	Resources     []string `json:"resources,omitempty"`
	Actions       []string `json:"actions,omitempty"`
}

// Parse reads a policy.yaml document. Empty input yields the built-in default policy
// (every authenticated user is a viewer). Beyond YAML syntax, it validates what the
// matcher would otherwise silently mis-evaluate: unknown keys, references to undefined
// roles, redefinition of built-in roles, and explicitly-empty rule fields.
func Parse(data []byte) (*Policy, error) {
	var f policyFile
	if err := yaml.UnmarshalStrict(data, &f); err != nil {
		return nil, fmt.Errorf("policy.yaml: %w", err)
	}

	p := &Policy{
		defaultRoles: []string{RoleViewer},
		roles:        builtinRoles(),
		users:        f.Users,
		groups:       f.Groups,
	}
	if f.DefaultRoles != nil {
		p.defaultRoles = *f.DefaultRoles
	}

	for name, spec := range f.Roles {
		if name == RoleViewer || name == RoleAdmin {
			return nil, fmt.Errorf("policy.yaml: role %q is built in and cannot be redefined; pick another name (a rule everyone should be denied goes in the top-level deny block)", name)
		}
		allow, err := compileRules(spec.Allow, fmt.Sprintf("roles.%s.allow", name))
		if err != nil {
			return nil, err
		}
		deny, err := compileRules(spec.Deny, fmt.Sprintf("roles.%s.deny", name))
		if err != nil {
			return nil, err
		}
		p.roles[name] = role{allow: allow, deny: deny}
	}

	var err error
	if p.deny, err = compileRules(f.Deny, "deny"); err != nil {
		return nil, err
	}

	if err := p.checkRoleRefs("defaultRoles", p.defaultRoles); err != nil {
		return nil, err
	}
	for user, roles := range p.users {
		if err := p.checkRoleRefs(fmt.Sprintf("users.%s", user), roles); err != nil {
			return nil, err
		}
	}
	for group, roles := range p.groups {
		if err := p.checkRoleRefs(fmt.Sprintf("groups.%s", group), roles); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// compileRules converts rule specs, rejecting explicitly-empty pattern lists: "namespaces: []"
// reads as "no namespaces" but would have to mean "all namespaces" (empty == omitted in the
// matcher), so it fails with guidance instead of silently inverting the author's intent.
func compileRules(specs []ruleSpec, where string) ([]rule, error) {
	rules := make([]rule, 0, len(specs))
	for i, s := range specs {
		for _, f := range []struct {
			name string
			list []string
		}{
			{"namespaces", s.Namespaces},
			{"resources", s.Resources},
			{"actions", s.Actions},
		} {
			if f.list != nil && len(f.list) == 0 {
				return nil, fmt.Errorf("policy.yaml: %s[%d].%s is an empty list, which would match nothing; omit the field to match every %s", where, i, f.name, strings.TrimSuffix(f.name, "s"))
			}
		}
		if s.ClusterScoped != nil && *s.ClusterScoped && len(s.Namespaces) > 0 {
			return nil, fmt.Errorf("policy.yaml: %s[%d] sets clusterScoped: true and lists namespaces; a rule targets either cluster-scoped resources or namespaces — split it into two rules", where, i)
		}
		rules = append(rules, rule{namespaces: s.Namespaces, clusterScoped: s.ClusterScoped, resources: s.Resources, actions: s.Actions})
	}
	return rules, nil
}

func (p *Policy) checkRoleRefs(where string, names []string) error {
	for _, n := range names {
		if _, ok := p.roles[n]; !ok {
			return fmt.Errorf("policy.yaml: %s references undefined role %q (built-in roles: %s, %s; custom roles are defined under roles:)", where, n, RoleViewer, RoleAdmin)
		}
	}
	return nil
}
