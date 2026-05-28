package graph

import (
	"slices"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// TestCuratedRefEdges_CertManager exercises one curated registry entry end-to-end: a
// Certificate with issuerRef + secretName produces an EdgeRefers to the Issuer and to the
// rendered Secret. Anchors the registry's contract — adding a new vendor schema means
// adding a similar focused fixture here.
func TestCuratedRefEdges_CertManager(t *testing.T) {
	cert := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Certificate",
		"metadata":   map[string]any{"name": "tls", "namespace": "shop", "uid": "cert-uid"},
		"spec": map[string]any{
			"secretName": "tls-cert",
			"issuerRef":  map[string]any{"name": "letsencrypt", "kind": "Issuer"},
		},
	}}
	issuer := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "cert-manager.io/v1",
		"kind":       "Issuer",
		"metadata":   map[string]any{"name": "letsencrypt", "namespace": "shop", "uid": "issuer-uid"},
	}}
	secret := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata":   map[string]any{"name": "tls-cert", "namespace": "shop", "uid": "sec-uid"},
	}}

	g := Build([]runtime.Object{cert, issuer, secret})
	want := []struct{ to string }{
		{"letsencrypt"},
		{"tls-cert"},
	}
	var got []string
	for _, e := range g.Edges {
		if e.Type != EdgeRefers {
			continue
		}
		if from := nodeByID(g, e.From); from == nil || from.Kind != "Certificate" {
			continue
		}
		if to := nodeByID(g, e.To); to != nil {
			got = append(got, to.Name)
		}
	}
	slices.Sort(got)
	if want := []string{"letsencrypt", "tls-cert"}; !slices.Equal(got, want) {
		t.Errorf("Certificate refers edges resolved to %v, want %v", got, want)
	}
	_ = want // keep both want-shapes for readability; the slice compare is the assertion
}

// TestConventionRefEdges_GenericRef proves the convention scanner finds a {name, kind}
// reference in an arbitrary CR's spec, without per-CRD config. Uses a made-up CR so the
// curated registry can't accidentally claim the edge.
func TestConventionRefEdges_GenericRef(t *testing.T) {
	cr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata":   map[string]any{"name": "w1", "namespace": "shop", "uid": "widget-uid"},
		"spec": map[string]any{
			"backend": map[string]any{"name": "api", "kind": "Service"},
		},
	}}
	svc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata":   map[string]any{"name": "api", "namespace": "shop", "uid": "svc-uid"},
	}}
	g := Build([]runtime.Object{cr, svc})

	var seen bool
	for _, e := range g.Edges {
		if e.Type == EdgeRefers {
			to := nodeByID(g, e.To)
			if to != nil && to.Kind == "Service" && to.Name == "api" {
				seen = true
				break
			}
		}
	}
	if !seen {
		t.Errorf("convention scanner missed Widget.spec.backend → Service/api; edges = %+v", g.Edges)
	}
}

// TestConventionRefEdges_IgnoresNameValuePair proves the scanner doesn't mistake a
// generic name/value parameter for a reference (Workflow.spec.arguments[].parameters
// have name+value; they aren't refs).
func TestConventionRefEdges_IgnoresNameValuePair(t *testing.T) {
	cr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Workflow",
		"metadata":   map[string]any{"name": "wf", "namespace": "shop", "uid": "wf-uid"},
		"spec": map[string]any{
			"arguments": map[string]any{
				"parameters": []any{
					map[string]any{"name": "message", "value": "hello"},
				},
			},
		},
	}}
	g := Build([]runtime.Object{cr})
	for _, e := range g.Edges {
		if e.Type == EdgeRefers {
			t.Errorf("convention scanner emitted an edge for a name/value parameter: %+v", e)
		}
	}
}

// nodeByID is the inverse of the existing nodeByName helper; we look up the target end of
// an edge to assert on it.
func nodeByID(g *Graph, id string) *Node {
	for i := range g.Nodes {
		if g.Nodes[i].ID == id {
			return &g.Nodes[i]
		}
	}
	return nil
}
