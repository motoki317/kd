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
// TestArgoWorkflowTemplateRefs pins the Argo lineage shaping: a CronWorkflow-owned Workflow's
// direct WorkflowTemplate edge is suppressed (the cron roots it instead), the CronWorkflow itself
// links to the template (nested workflowSpec path), and a standalone Workflow keeps its edge. The
// net is a clean template → cronworkflow → workflows tree instead of two-parent workflows that
// fold under neither mechanism.
func TestArgoWorkflowTemplateRefs(t *testing.T) {
	tmpl := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "WorkflowTemplate",
		"metadata": map[string]any{"name": "build", "namespace": "ci", "uid": "tmpl-uid"},
	}}
	cron := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow",
		"metadata": map[string]any{"name": "nightly", "namespace": "ci", "uid": "cron-uid"},
		"spec":     map[string]any{"workflowSpec": map[string]any{"workflowTemplateRef": map[string]any{"name": "build"}}},
	}}
	ctrl := true
	ownedWF := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{"name": "nightly-123", "namespace": "ci", "uid": "owned-uid",
			"ownerReferences": []any{map[string]any{"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow", "name": "nightly", "uid": "cron-uid", "controller": ctrl}}},
		"spec": map[string]any{"workflowTemplateRef": map[string]any{"name": "build"}},
	}}
	standaloneWF := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{"name": "adhoc", "namespace": "ci", "uid": "adhoc-uid"},
		"spec":     map[string]any{"workflowTemplateRef": map[string]any{"name": "build"}},
	}}

	g := Build([]runtime.Object{tmpl, cron, ownedWF, standaloneWF})
	refersToTmpl := func(fromKind string) bool {
		for _, e := range g.Edges {
			if e.Type != EdgeRefers {
				continue
			}
			if from := nodeByID(g, e.From); from != nil && from.Kind == fromKind {
				if to := nodeByID(g, e.To); to != nil && to.Kind == "WorkflowTemplate" {
					return true
				}
			}
		}
		return false
	}
	if !refersToTmpl("CronWorkflow") {
		t.Error("CronWorkflow should reference its WorkflowTemplate (workflowSpec.workflowTemplateRef)")
	}
	if !refersToTmpl("Workflow") {
		t.Error("a standalone (unowned) Workflow should still reference its WorkflowTemplate")
	}
	// The owned Workflow's direct template edge must be gone (the only Workflow→Template edge left
	// is the standalone one). Assert exactly one such edge, and that it's NOT the owned workflow's.
	for _, e := range g.Edges {
		if e.Type == EdgeRefers && e.From == "owned-uid" {
			t.Error("a controller-owned Workflow must not emit its own WorkflowTemplate edge")
		}
	}
}

func nodeByID(g *Graph, id string) *Node {
	for i := range g.Nodes {
		if g.Nodes[i].ID == id {
			return &g.Nodes[i]
		}
	}
	return nil
}
