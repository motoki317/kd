// Package rbac implements declarative authorization for kd.
//
// Policy is a single policy.yaml: named roles bundle allow/deny rules, each scoped by
// namespace globs or `clusterScoped: true` and by (resources, actions) glob patterns;
// users and groups are assigned roles; a top-level deny block expresses guardrails that
// bind every caller. A request is allowed iff some allow rule of the caller's roles
// matches it and NO deny rule — from any of the caller's roles or the global block —
// matches it (deny always wins). See docs/ADR/20260612-policy-yaml-authorization.md.
package rbac

import (
	"strings"
	"sync"
)

// ClusterScope is the scope value callers pass as Enforce's namespace argument to authorize
// cluster-scoped resources (Nodes, PersistentVolumes, CRDs, …). The underscores make it
// impossible as a real namespace name (not a DNS label), so it can never collide. Policy
// authors never write it — a rule opts into cluster scope with `clusterScoped: true`.
const ClusterScope = "__cluster__"

// Built-in role names, always defined regardless of the loaded policy file.
const (
	RoleViewer = "viewer" // get/list/watch on everything
	RoleAdmin  = "admin"  // every action on everything
)

// rule is one compiled allow/deny entry. The list fields hold glob patterns; an empty list
// matches everything (the parser rejects explicitly-empty lists, so empty means omitted).
// clusterScoped is tri-state: nil (unset) leaves scoping to the namespaces list, true makes
// the rule cluster-scope-only, false makes it namespaced-only.
type rule struct {
	namespaces    []string
	clusterScoped *bool
	resources     []string
	actions       []string
}

// matches reports whether the rule covers a request for action on ANY of the given
// resource classes in scope. Matching any-of-resources on both allow and deny sides
// is what extends deny-override across kd's dual resource classes (coarse class + API
// group): an allow on either class grants, a deny on either class blocks.
func (r rule) matches(scope string, resources []string, action string) bool {
	return r.matchesScope(scope) &&
		matchAny(r.actions, action) &&
		matchAnyValue(r.resources, resources)
}

// matchesScope decides namespace/cluster coverage. Namespace globs deliberately never see
// the cluster scope — listing namespaces means namespaces, full stop — while a rule with no
// scope field at all matches everything, so a bare deny guardrail (and the built-in roles)
// cannot be sidestepped through cluster-scoped resources.
func (r rule) matchesScope(scope string) bool {
	if scope == ClusterScope {
		if r.clusterScoped != nil {
			return *r.clusterScoped
		}
		return len(r.namespaces) == 0
	}
	if r.clusterScoped != nil && *r.clusterScoped {
		return false
	}
	return matchAny(r.namespaces, scope)
}

func matchAny(patterns []string, value string) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, p := range patterns {
		if globMatch(p, value) {
			return true
		}
	}
	return false
}

func matchAnyValue(patterns []string, values []string) bool {
	if len(patterns) == 0 {
		return true
	}
	for _, v := range values {
		for _, p := range patterns {
			if globMatch(p, v) {
				return true
			}
		}
	}
	return false
}

type role struct {
	allow []rule
	deny  []rule
}

func builtinRoles() map[string]role {
	return map[string]role{
		RoleViewer: {allow: []rule{{actions: []string{"get", "list", "watch"}}}},
		RoleAdmin:  {allow: []rule{{}}},
	}
}

// Policy is a parsed, immutable authorization policy: role definitions (built-in +
// file-defined), user/group role assignments, the default roles, and global deny rules.
type Policy struct {
	defaultRoles []string
	roles        map[string]role
	users        map[string][]string
	groups       map[string][]string
	deny         []rule
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

// Enforce reports whether the caller {user, groups} may perform action on resource in
// namespace — a real namespace name, or ClusterScope for cluster-scoped resources.
func (e *Enforcer) Enforce(user string, groups []string, namespace, resource, action string) bool {
	return e.EnforceAny(user, groups, namespace, []string{resource}, action)
}

// EnforceAny reports whether the caller may perform action in namespace against ANY of the
// given resource classes. The semantics match Enforce when len(resources) == 1, and extend
// it to multi-class dispatch:
//   - Allow if some rule matching some-of-resources allows AND no rule matching
//     any-of-resources denies.
//   - Deny if any rule matching any-of-resources denies, regardless of allows (the
//     global deny-override extended across classes).
//
// kd uses this so a kind can be authorized by EITHER its coarse class (pods/nodes/workloads/…)
// OR its API group (argoproj.io/cert-manager.io/…) — operators write rules in whichever
// dimension is more natural.
func (e *Enforcer) EnforceAny(user string, groups []string, namespace string, resources []string, action string) bool {
	e.mu.RLock()
	p := e.policy
	e.mu.RUnlock()
	return p.decide(user, groups, namespace, resources, action)
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

func (p *Policy) decide(user string, groups []string, scope string, resources []string, action string) bool {
	for _, r := range p.deny {
		if r.matches(scope, resources, action) {
			return false
		}
	}
	names := p.roleSet(user, groups)
	// Every role's denies are checked before any allow wins: holding an extra role can only
	// ever narrow access, never widen past another role's deny.
	for name := range names {
		for _, r := range p.roles[name].deny {
			if r.matches(scope, resources, action) {
				return false
			}
		}
	}
	for name := range names {
		for _, r := range p.roles[name].allow {
			if r.matches(scope, resources, action) {
				return true
			}
		}
	}
	return false
}

// roleSet is the set of roles acting on the caller's behalf: the default roles, the
// user's assignments, and each group's assignments. Parse validated every name, so each
// entry resolves in p.roles.
func (p *Policy) roleSet(user string, groups []string) map[string]bool {
	set := map[string]bool{}
	add := func(names []string) {
		for _, n := range names {
			set[n] = true
		}
	}
	add(p.defaultRoles)
	add(p.users[user])
	for _, g := range groups {
		add(p.groups[g])
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
