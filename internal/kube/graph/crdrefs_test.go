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

// TestGatewayRouteEdges proves a Gateway API HTTPRoute links to its backend Services as EdgeRoutes
// (the Ingress's networking category, not the generic EdgeRefers), including a kind-less backendRef
// (Service is the default — the shape the convention scanner can't link) and a cross-namespace ref.
func TestGatewayRouteEdges(t *testing.T) {
	hr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]any{"name": "store", "namespace": "shop", "uid": "hr-uid"},
		"spec": map[string]any{
			"rules": []any{
				map[string]any{"backendRefs": []any{
					map[string]any{"name": "api-svc", "port": int64(8080)},                    // kind-less → defaults to Service
					map[string]any{"name": "shared", "kind": "Service", "namespace": "infra"}, // cross-namespace
					map[string]any{"name": "bucket", "kind": "Bucket"},                        // non-Service backend → no node, skipped
				}},
			},
		},
	}}
	apiSvc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "api-svc", "namespace": "shop", "uid": "api-uid"},
	}}
	shared := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "shared", "namespace": "infra", "uid": "shared-uid"},
	}}
	g := Build([]runtime.Object{hr, apiSvc, shared})

	if !hasEdge(g, EdgeRoutes, "HTTPRoute", "store", "Service", "api-svc") {
		t.Errorf("missing EdgeRoutes HTTPRoute/store -> Service/api-svc (kind-less backendRef); edges = %+v", g.Edges)
	}
	if !hasEdge(g, EdgeRoutes, "HTTPRoute", "store", "Service", "shared") {
		t.Errorf("missing cross-namespace EdgeRoutes to Service/shared; edges = %+v", g.Edges)
	}
	// The route's backends are its whole ref surface, so the generic scanner must not also fire
	// (it would double-emit the explicit kind:Service ref as EdgeRefers).
	for _, e := range g.Edges {
		if e.Type == EdgeRefers {
			t.Errorf("unexpected EdgeRefers from a Gateway route (generic scanner should be skipped): %+v", e)
		}
	}
}

// TestTraefikIngressRouteEdges proves a Traefik IngressRoute links to the Kubernetes Services in its
// spec.routes[].services as EdgeRoutes (the Network category), skipping a TraefikService backend.
func TestTraefikIngressRouteEdges(t *testing.T) {
	ir := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "traefik.io/v1alpha1",
		"kind":       "IngressRoute",
		"metadata":   map[string]any{"name": "app", "namespace": "shop", "uid": "ir-uid"},
		"spec": map[string]any{
			"routes": []any{
				map[string]any{"match": "Host(`a`)", "services": []any{
					map[string]any{"name": "api-svc", "port": int64(80)},
					map[string]any{"name": "split", "kind": "TraefikService"}, // not a Service node → skipped
				}},
			},
		},
	}}
	svc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "api-svc", "namespace": "shop", "uid": "api-uid"},
	}}
	g := Build([]runtime.Object{ir, svc})
	if !hasEdge(g, EdgeRoutes, "IngressRoute", "app", "Service", "api-svc") {
		t.Errorf("missing EdgeRoutes IngressRoute/app -> Service/api-svc; edges = %+v", g.Edges)
	}
	for _, e := range g.Edges {
		if e.Type == EdgeRefers {
			t.Errorf("unexpected EdgeRefers from a Traefik IngressRoute (generic scanner should be skipped): %+v", e)
		}
	}
}

// TestServiceMonitorScrapesEdges proves a ServiceMonitor/VMServiceScrape links to the Services its
// selector matches (EdgeScrapes), honoring the namespaceSelector so a scrape aimed only at other
// namespaces doesn't draw a spurious edge to a same-labelled local Service.
func TestServiceMonitorScrapesEdges(t *testing.T) {
	sm := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "monitoring.coreos.com/v1", "kind": "ServiceMonitor",
		"metadata": map[string]any{"name": "es-mon", "namespace": "shop", "uid": "sm-uid"},
		"spec": map[string]any{
			"selector":          map[string]any{"matchLabels": map[string]any{"app": "es"}},
			"namespaceSelector": map[string]any{"matchNames": []any{"shop"}},
			"endpoints":         []any{map[string]any{"port": "http"}},
		},
	}}
	// Same label match, but its namespaceSelector targets only another namespace → no local edge.
	elsewhere := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMServiceScrape",
		"metadata": map[string]any{"name": "elsewhere", "namespace": "shop", "uid": "vm-uid"},
		"spec": map[string]any{
			"selector":          map[string]any{"matchLabels": map[string]any{"app": "es"}},
			"namespaceSelector": map[string]any{"matchNames": []any{"other-ns"}},
		},
	}}
	esSvc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "es", "namespace": "shop", "uid": "es-uid", "labels": map[string]any{"app": "es"}},
	}}
	webSvc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Service",
		"metadata": map[string]any{"name": "web", "namespace": "shop", "uid": "web-uid", "labels": map[string]any{"app": "web"}},
	}}
	g := Build([]runtime.Object{sm, elsewhere, esSvc, webSvc})

	if !hasEdge(g, EdgeScrapes, "ServiceMonitor", "es-mon", "Service", "es") {
		t.Errorf("a ServiceMonitor should scrape the Service its selector matches; edges = %+v", g.Edges)
	}
	if hasEdge(g, EdgeScrapes, "ServiceMonitor", "es-mon", "Service", "web") {
		t.Error("a ServiceMonitor must NOT scrape a Service its selector doesn't match")
	}
	if hasEdge(g, EdgeScrapes, "VMServiceScrape", "elsewhere", "Service", "es") {
		t.Error("a scrape targeting only other namespaces must not link a local Service")
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

// TestAsConventionRef pins the heuristic that decides whether an arbitrary nested map is a
// cross-resource reference (name + optional kind/group/namespace) vs a structural block or a plain
// name/value parameter. The edge tests exercise it end-to-end; this covers the guard branches
// directly so each rejection reason is independently anchored.
func TestAsConventionRef(t *testing.T) {
	if _, ok := asConventionRef(map[string]any{}); ok {
		t.Error("a map without a name is not a ref")
	}
	// Any structural key disqualifies it — those maps are the resource's own body, not a reference.
	for _, blocker := range []string{"spec", "status", "metadata", "data"} {
		if _, ok := asConventionRef(map[string]any{"name": "x", blocker: map[string]any{}}); ok {
			t.Errorf("a map carrying %q is a body, not a ref", blocker)
		}
	}
	// Bare name is a valid ref (kind resolved later from context).
	if ref, ok := asConventionRef(map[string]any{"name": "db"}); !ok || ref.name != "db" {
		t.Errorf("bare name = (%+v, %v), want a ref named db", ref, ok)
	}
	// A full ref populates kind and namespace (apiGroup in the map is ignored — kd resolves by name/kind).
	if ref, _ := asConventionRef(map[string]any{"name": "db", "kind": "Secret", "apiGroup": "v1", "namespace": "ns"}); ref.kind != "Secret" || ref.namespace != "ns" {
		t.Errorf("full ref = %+v, want kind/namespace populated", ref)
	}
	// A name+value pair with no kind is a parameter (e.g. a Workflow argument), not a ref.
	if _, ok := asConventionRef(map[string]any{"name": "p", "value": "literal"}); ok {
		t.Error("name+value without kind is a parameter, not a ref")
	}
	// But a name+value that ALSO names a kind is still a ref (the kind disambiguates).
	if ref, ok := asConventionRef(map[string]any{"name": "p", "value": "x", "kind": "Thing"}); !ok || ref.kind != "Thing" {
		t.Errorf("name+value+kind = (%+v, %v), want a ref of kind Thing", ref, ok)
	}
}
