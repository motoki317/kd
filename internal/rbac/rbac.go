// Package rbac implements declarative, ArgoCD-style authorization for kd.
//
// Policy is expressed in the ArgoCD/Casbin policy.csv grammar (`p,` permission lines and
// `g,` grouping lines) and enforced by a purpose-built matcher: a caller is the set of its
// principals (user + groups + roles reached through `g,` + the default role), and a request
// is allowed iff some matching rule allows it and none denies it (global deny-override).
// See docs/ADR/20260527-declarative-rbac-policy-csv.md.
package rbac

import (
	"fmt"
	"strings"
	"sync"
)

type effect int

const (
	effectAllow effect = iota
	effectDeny
)

// rule is one `p,` permission line. The namespace/resource/action fields are glob patterns.
type rule struct {
	subject   string
	namespace string
	resource  string
	action    string
	effect    effect
}

// Policy is a parsed, immutable set of permission rules and role grants.
type Policy struct {
	rules       []rule
	grants      map[string][]string // subject -> roles granted via `g,`
	defaultRole string
}

// builtinRules are always present regardless of the loaded policy: the readonly and admin
// role definitions that operators reference via `policy.default` and `g,` grants.
var builtinRules = []rule{
	{subject: "role:readonly", namespace: "*", resource: "*", action: "get", effect: effectAllow},
	{subject: "role:readonly", namespace: "*", resource: "*", action: "list", effect: effectAllow},
	{subject: "role:readonly", namespace: "*", resource: "*", action: "watch", effect: effectAllow},
	{subject: "role:admin", namespace: "*", resource: "*", action: "*", effect: effectAllow},
}

// Parse reads a policy.csv document. defaultRole is the role implicitly granted to every
// caller (e.g. "role:readonly"); an empty defaultRole locks access down to explicit grants.
func Parse(policyCSV, defaultRole string) (*Policy, error) {
	p := &Policy{
		rules:       append([]rule(nil), builtinRules...),
		grants:      map[string][]string{},
		defaultRole: defaultRole,
	}

	for n, line := range strings.Split(policyCSV, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := splitTrim(line)
		switch fields[0] {
		case "p":
			r, err := parseRule(fields)
			if err != nil {
				return nil, fmt.Errorf("policy line %d: %w", n+1, err)
			}
			p.rules = append(p.rules, r)
		case "g":
			if len(fields) != 3 {
				return nil, fmt.Errorf("policy line %d: grouping needs 'g, subject, role', got %q", n+1, line)
			}
			p.grants[fields[1]] = append(p.grants[fields[1]], fields[2])
		default:
			return nil, fmt.Errorf("policy line %d: unknown line type %q", n+1, fields[0])
		}
	}
	return p, nil
}

func parseRule(fields []string) (rule, error) {
	// p, subject, namespace, resource, action[, effect]
	if len(fields) < 5 || len(fields) > 6 {
		return rule{}, fmt.Errorf("permission needs 'p, sub, ns, res, act[, eft]', got %d fields", len(fields))
	}
	eft := effectAllow
	if len(fields) == 6 {
		switch fields[5] {
		case "allow", "":
			eft = effectAllow
		case "deny":
			eft = effectDeny
		default:
			return rule{}, fmt.Errorf("invalid effect %q (want allow or deny)", fields[5])
		}
	}
	return rule{
		subject:   fields[1],
		namespace: fields[2],
		resource:  fields[3],
		action:    fields[4],
		effect:    eft,
	}, nil
}

func splitTrim(line string) []string {
	parts := strings.Split(line, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// Enforcer evaluates requests against a Policy. It is safe for concurrent use and supports
// atomic policy replacement for hot reload.
type Enforcer struct {
	mu     sync.RWMutex
	policy *Policy
}

// NewEnforcer wraps a parsed Policy.
func NewEnforcer(p *Policy) *Enforcer { return &Enforcer{policy: p} }

// Replace swaps in a new policy atomically (used by the hot-reload watcher).
func (e *Enforcer) Replace(p *Policy) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.policy = p
}

// Enforce reports whether the caller {user, groups} may perform action on resource in namespace.
func (e *Enforcer) Enforce(user string, groups []string, namespace, resource, action string) bool {
	return e.EnforceAny(user, groups, namespace, []string{resource}, action)
}

// EnforceAny reports whether the caller may perform action in namespace against ANY of the
// given resource classes. The semantics match Enforce when len(resources) == 1, and extend
// it to multi-class dispatch:
//   - Allow if some rule matching some-of-resources allows AND no rule matching
//     any-of-resources denies.
//   - Deny if any rule matching any-of-resources denies, regardless of allows (the
//     existing global deny-override extended across classes).
//
// kd uses this so a kind can be authorized by EITHER its legacy class (pods/nodes/workloads/…)
// OR its GVR group (argoproj.io/cert-manager.io/…) — operators can write rules in whichever
// dimension is more natural without breaking back-compat.
func (e *Enforcer) EnforceAny(user string, groups []string, namespace string, resources []string, action string) bool {
	e.mu.RLock()
	p := e.policy
	e.mu.RUnlock()

	principals := p.principals(user, groups)
	allowed := false
	for _, r := range p.rules {
		if !principals[r.subject] {
			continue
		}
		if !globMatch(r.namespace, namespace) || !globMatch(r.action, action) {
			continue
		}
		matchesResource := false
		for _, res := range resources {
			if globMatch(r.resource, res) {
				matchesResource = true
				break
			}
		}
		if !matchesResource {
			continue
		}
		if r.effect == effectDeny {
			return false
		}
		allowed = true
	}
	return allowed
}

// VisibleNamespaces filters namespaces to those the caller may list pods in, preserving order.
func (e *Enforcer) VisibleNamespaces(user string, groups []string, namespaces []string) []string {
	var visible []string
	for _, ns := range namespaces {
		if e.Enforce(user, groups, ns, "pods", "list") {
			visible = append(visible, ns)
		}
	}
	return visible
}

// principals returns the set of subjects that act on the caller's behalf: the user, its
// groups, every role reachable through `g,` grants (transitive), and the default role.
func (p *Policy) principals(user string, groups []string) map[string]bool {
	set := map[string]bool{}
	queue := append([]string{user}, groups...)
	if p.defaultRole != "" {
		queue = append(queue, p.defaultRole)
	}
	for len(queue) > 0 {
		s := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if set[s] {
			continue
		}
		set[s] = true
		queue = append(queue, p.grants[s]...)
	}
	return set
}

// globMatch reports whether value matches a glob pattern containing zero or more '*'
// wildcards. Values here (namespaces, resources, actions) contain no '/', so '*' is greedy.
func globMatch(pattern, value string) bool {
	if pattern == "*" || pattern == value {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return false
	}
	segments := strings.Split(pattern, "*")
	rest := value
	for i, seg := range segments {
		if seg == "" {
			continue
		}
		switch i {
		case 0:
			if !strings.HasPrefix(rest, seg) {
				return false
			}
			rest = rest[len(seg):]
		case len(segments) - 1:
			if !strings.HasSuffix(rest, seg) {
				return false
			}
		default:
			idx := strings.Index(rest, seg)
			if idx < 0 {
				return false
			}
			rest = rest[idx+len(seg):]
		}
	}
	return true
}
