package graph

// The spec_<domain>.go siblings surface each resource's declarative essence — a Service's
// address/ports, an Ingress's routes, a Role's rules, a binding's grantees — as display-ready strings
// on the graph Node: "what does this resource declare", the counterpart to fields.go's "what is this
// pod/node doing at runtime". This file keeps only the formatting/access helpers those domains share.

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// labelMapString renders a label map deterministically as "k=v, k=v" (sorted; "" when empty).
func labelMapString(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, ", ")
}

// intStrString renders an unstructured port-like value that may be a number (int64 from the dynamic
// client, float64 from a JSON round-trip) or a named-port string. Empty for anything else (e.g. absent).
func intStrString(v any) string {
	switch p := v.(type) {
	case string:
		return p
	case int64:
		return fmt.Sprintf("%d", p)
	case float64:
		return fmt.Sprintf("%d", int64(p))
	}
	return ""
}

// asUnstructuredKind returns obj as an unstructured object when it is one AND its kind matches one of
// `kinds` — the access gate every CR-essence extractor shares (kd keeps CRs and the few schemaless
// built-ins like HPA and StorageClass as *unstructured.Unstructured; see typedFactories). Pass several
// kinds to gate a small family (Issuer/ClusterIssuer, the two webhook configs). nil when the type or
// kind differs, so a caller reads `if u := asUnstructuredKind(obj, "X"); u != nil { … }`.
func asUnstructuredKind(obj runtime.Object, kinds ...string) *unstructured.Unstructured {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return nil
	}
	if slices.Contains(kinds, u.GetKind()) {
		return u
	}
	return nil
}

// nestedNumber reads a numeric field from an unstructured map, tolerating both JSON decodings —
// int64 from the API server, float64 after a JSON round-trip (the wgpolicy summary lesson).
func nestedNumber(m map[string]any, key string) (int64, bool) {
	switch v := m[key].(type) {
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}

// selectorSummary renders a LabelSelector as "k=v, k2=v2" (matchExpressions appended as "key op
// (values)"), or "all pods" when empty — which for a NetworkPolicy podSelector means every pod in the
// namespace. matchLabels are sorted so the string is stable across SSE patches.
func selectorSummary(sel *metav1.LabelSelector) string {
	if sel == nil || (len(sel.MatchLabels) == 0 && len(sel.MatchExpressions) == 0) {
		return "all pods"
	}
	keys := make([]string, 0, len(sel.MatchLabels))
	for k := range sel.MatchLabels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys)+len(sel.MatchExpressions))
	for _, k := range keys {
		parts = append(parts, k+"="+sel.MatchLabels[k])
	}
	for _, e := range sel.MatchExpressions {
		// Exists / DoesNotExist carry no values, so the "(…)" would be an empty pair of parens — drop it.
		if len(e.Values) == 0 {
			parts = append(parts, e.Key+" "+strings.ToLower(string(e.Operator)))
		} else {
			parts = append(parts, fmt.Sprintf("%s %s (%s)", e.Key, strings.ToLower(string(e.Operator)), strings.Join(e.Values, ",")))
		}
	}
	return strings.Join(parts, ", ")
}
