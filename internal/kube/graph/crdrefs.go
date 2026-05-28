package graph

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// CR-defined references are the relationships kd can't get from ownerReferences alone:
// a Workflow → WorkflowTemplate, a Certificate → Issuer, an ExternalSecret → SecretStore.
// kd infers them two ways, in priority order:
//
//  1. A curated registry of well-known schemas (crdRefRules) hard-codes the field path +
//     target kind for the vendor CRDs operators most commonly run. These are tested
//     individually, so the rendering is deterministic.
//
//  2. A convention scanner walks the CR's spec for fields that match the
//     {name, kind?, apiGroup?, namespace?} reference shape Kubernetes vendors converged on
//     (ObjectReference / LocalObjectReference / TypedLocalObjectReference / *Ref). It
//     catches the long tail of CRDs no one's curated for, with a deliberate heuristic.
//
// Both produce EdgeRefers edges; the renderer styles them subtler than ownership edges so
// the topology backbone (Deployment→ReplicaSet→Pod) stays the primary read.

// crdRefRule describes a curated reference field on a specific CR kind.
type crdRefRule struct {
	// fromGroup / fromKind identify the CR this rule applies to. Group "" means any group.
	fromGroup string
	fromKind  string
	// jsonPath is the dotted path into u.Object below "spec". Wildcards aren't supported
	// for v1 — operators with array-of-refs (Workflow templateRef inside steps) need a
	// dedicated rule per shape, or fall back to the convention scanner.
	jsonPath []string
	// toKind is the kind name of the referenced resource. toGroup is the API group; when
	// empty, the rule resolves against any node whose name matches (and we accept whichever
	// kind comes first), so well-known kinds without a group still resolve.
	toKind  string
	toGroup string
	// namespaced reports whether the referenced kind is namespaced; cross-namespace refs
	// in v1 only resolve when the target lives in the same namespace as the referrer.
	namespaced bool
}

// crdRefRules is the v1 curated registry. Kept small and focused so each rule has a clear
// purpose; new entries should pair with a fixture test in crdrefs_test.go.
var crdRefRules = []crdRefRule{
	// Argo Workflows: a Workflow can reference a WorkflowTemplate (cluster-scoped or
	// namespaced) for templates it doesn't define inline.
	{fromGroup: "argoproj.io", fromKind: "Workflow",
		jsonPath: []string{"workflowTemplateRef", "name"},
		toKind:   "WorkflowTemplate", toGroup: "argoproj.io", namespaced: true},
	// cert-manager: a Certificate references its issuer through spec.issuerRef (kind is
	// either Issuer or ClusterIssuer; we encode both as separate rules).
	{fromGroup: "cert-manager.io", fromKind: "Certificate",
		jsonPath: []string{"issuerRef", "name"},
		toKind:   "Issuer", toGroup: "cert-manager.io", namespaced: true},
	{fromGroup: "cert-manager.io", fromKind: "Certificate",
		jsonPath: []string{"issuerRef", "name"},
		toKind:   "ClusterIssuer", toGroup: "cert-manager.io", namespaced: false},
	// cert-manager: a Certificate writes its rendered TLS material into a Secret it names.
	{fromGroup: "cert-manager.io", fromKind: "Certificate",
		jsonPath: []string{"secretName"},
		toKind:   "Secret", toGroup: "", namespaced: true},
	// external-secrets.io: an ExternalSecret references a SecretStore (or ClusterSecretStore)
	// for the backend, and writes into a target Secret.
	{fromGroup: "external-secrets.io", fromKind: "ExternalSecret",
		jsonPath: []string{"secretStoreRef", "name"},
		toKind:   "SecretStore", toGroup: "external-secrets.io", namespaced: true},
	{fromGroup: "external-secrets.io", fromKind: "ExternalSecret",
		jsonPath: []string{"secretStoreRef", "name"},
		toKind:   "ClusterSecretStore", toGroup: "external-secrets.io", namespaced: false},
	{fromGroup: "external-secrets.io", fromKind: "ExternalSecret",
		jsonPath: []string{"target", "name"},
		toKind:   "Secret", toGroup: "", namespaced: true},
	// ArgoCD: an Application points at a destination namespace + project, and references a
	// project (an AppProject CR in the same namespace, usually "argocd").
	{fromGroup: "argoproj.io", fromKind: "Application",
		jsonPath: []string{"project"},
		toKind:   "AppProject", toGroup: "argoproj.io", namespaced: true},
}

// curatedRefEdges runs the curated registry against one CR and returns the edges it
// produces. Unknown kinds (no rule matches) get no curated edges; the convention scanner
// picks up the slack.
func (b *edgeBuilder) curatedRefEdges(fromID string, u *unstructured.Unstructured) {
	gvk := u.GroupVersionKind()
	for _, rule := range crdRefRules {
		if rule.fromGroup != gvk.Group || rule.fromKind != gvk.Kind {
			continue
		}
		path := append([]string{"spec"}, rule.jsonPath...)
		name, found, _ := unstructured.NestedString(u.Object, path...)
		if !found || name == "" {
			continue
		}
		toNS := ""
		if rule.namespaced {
			toNS = u.GetNamespace()
		}
		b.link(fromID, EdgeRefers, rule.toKind, toNS, name)
	}
}

// conventionRefEdges scans spec recursively for objects matching the conventional reference
// shape — a map with a "name" string field plus optional "kind"/"apiGroup"/"namespace"
// peers — and emits one EdgeRefers edge per resolved target. Walks bounded by maxDepth so
// a pathological CR can't run away with the build.
//
// The shape covers ObjectReference, LocalObjectReference, TypedLocalObjectReference, and
// the long-tail of vendor *Ref / *SecretRef / *ConfigMapRef fields without per-kind config.
func (b *edgeBuilder) conventionRefEdges(fromID string, u *unstructured.Unstructured) {
	spec, found, err := unstructured.NestedFieldNoCopy(u.Object, "spec")
	if err != nil || !found {
		return
	}
	walked := map[string]bool{} // dedupe (kind|ns|name) so a nested struct doesn't double-emit
	const maxDepth = 8
	var walk func(node any, depth int)
	walk = func(node any, depth int) {
		if depth > maxDepth {
			return
		}
		switch v := node.(type) {
		case map[string]any:
			if ref, ok := asConventionRef(v); ok {
				toKind, toNS, toName := ref.kind, ref.namespace, ref.name
				if toNS == "" {
					toNS = u.GetNamespace()
				}
				if toKind == "" {
					return // an untyped "name" alone is too ambiguous to link
				}
				key := toKind + "|" + toNS + "|" + toName
				if !walked[key] {
					walked[key] = true
					b.link(fromID, EdgeRefers, toKind, toNS, toName)
				}
				return // matched as a leaf reference; don't keep descending into it
			}
			for _, child := range v {
				walk(child, depth+1)
			}
		case []any:
			for _, child := range v {
				walk(child, depth+1)
			}
		}
	}
	walk(spec, 0)
}

// asConventionRef detects a {name [, kind, apiGroup, namespace]} map. Requires "name" to be
// a non-empty string; kind/apiGroup/namespace are optional. Returns false for maps that
// happen to have a "name" field but also carry non-ref fields (presence of "spec"/"status"/
// "metadata"/"data" rules out a leaf ref — it's a top-level object inside the CR), so we
// don't mistake an embedded workload spec for a reference.
type conventionRef struct{ kind, name, namespace, apiGroup string }

func asConventionRef(m map[string]any) (conventionRef, bool) {
	name, _ := m["name"].(string)
	if name == "" {
		return conventionRef{}, false
	}
	for _, blocker := range []string{"spec", "status", "metadata", "data"} {
		if _, has := m[blocker]; has {
			return conventionRef{}, false
		}
	}
	ref := conventionRef{name: name}
	if k, ok := m["kind"].(string); ok {
		ref.kind = k
	}
	if g, ok := m["apiGroup"].(string); ok {
		ref.apiGroup = g
	} else if g, ok := m["group"].(string); ok {
		ref.apiGroup = g
	}
	if ns, ok := m["namespace"].(string); ok {
		ref.namespace = ns
	}
	// Drop refs that look like generic name-value pairs (e.g. a Workflow.spec.arguments
	// parameter has "name" + "value"). Heuristic: a real ref doesn't carry a "value" key.
	if _, hasValue := m["value"]; hasValue && ref.kind == "" {
		return conventionRef{}, false
	}
	return ref, true
}

