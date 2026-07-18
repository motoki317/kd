package graph

// The spec_<domain>.go siblings surface each resource's declarative essence — a Service's
// address/ports, an Ingress's routes, a Role's rules, a binding's grantees — as display-ready strings
// on the graph Node: "what does this resource declare", the counterpart to fields.go's "what is this
// pod/node doing at runtime". This file keeps only the formatting/access helpers those domains share.
//
// To add a fact: extract it in spec_<domain>.go (dispatch in spec_routing.go); add its Node field,
// build.go assignment, and diff.go nodeEqual check; then add the matching KNode field in
// web/src/types.ts and labelled chip/row in web/src/components/KindFacts.tsx. A typed extractor also
// needs its kind in unstructured.go typedFactories. Never expose Secret values; emit key names and
// sizes only. Represent a meaningful zero as a string so omitempty cannot erase it.
//
// For a CR, confirm each Nested* path against `kubectl get ... -o json`, not the drawer's YAML view:
// its flattened indentation can make a copied fixture pass while the live field stays empty.
// Unstructured numbers may decode as int64 or float64, so accept both.

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

// nestedNum reads a numeric field at path from an unstructured map, tolerating both JSON decodings —
// int64 from the API server, float64 after a round-trip (the wgpolicy summary lesson). Returns
// (0, false) when the path is absent or not a number.
func nestedNum(obj map[string]any, path ...string) (int64, bool) {
	if v, ok, _ := unstructured.NestedInt64(obj, path...); ok {
		return v, true
	}
	if v, ok, _ := unstructured.NestedFloat64(obj, path...); ok {
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
