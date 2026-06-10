package graph

import (
	"slices"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func TestNodeCapacity(t *testing.T) {
	node := &corev1.Node{Status: corev1.NodeStatus{Allocatable: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("8"),
		corev1.ResourceMemory: resource.MustParse("16Gi"),
		corev1.ResourcePods:   resource.MustParse("110"),
	}}}
	if got, want := nodeCapacity(node), "8 vCPU · 16Gi · 110 pods"; got != want {
		t.Errorf("nodeCapacity = %q, want %q", got, want)
	}

	if got := nodeCapacity(&corev1.Pod{}); got != "" {
		t.Errorf("nodeCapacity(non-node) = %q, want empty", got)
	}
	if got := nodeCapacity(&corev1.Node{}); got != "" {
		t.Errorf("nodeCapacity(no allocatable) = %q, want empty", got)
	}
}

func TestNetworkPolicySummary(t *testing.T) {
	sel := func(kv map[string]string) metav1.LabelSelector { return metav1.LabelSelector{MatchLabels: kv} }
	selP := func(kv map[string]string) *metav1.LabelSelector { s := sel(kv); return &s }
	ns := func(name string) *metav1.LabelSelector { return selP(map[string]string{"kubernetes.io/metadata.name": name}) }
	port := func(p int) *networkingv1.NetworkPolicyPort {
		v := intstr.FromInt(p)
		return &networkingv1.NetworkPolicyPort{Port: &v}
	}
	// The real staging shape: target a labelled app; one ingress rule that allows a same-namespace pod,
	// a cross-namespace pod, and any workflow pod cluster-wide, on a single port. The peers — "who can
	// reach these pods" — are the whole point, so they render in full rather than as a bare "1 rule".
	ingressPeers := &networkingv1.NetworkPolicy{Spec: networkingv1.NetworkPolicySpec{
		PodSelector: sel(map[string]string{"app.kubernetes.io/name": "api-a"}),
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress: []networkingv1.NetworkPolicyIngressRule{{
			Ports: []networkingv1.NetworkPolicyPort{*port(50051)},
			From: []networkingv1.NetworkPolicyPeer{
				{PodSelector: selP(map[string]string{"app.kubernetes.io/name": "ui-a"})},
				{NamespaceSelector: ns("team-b"), PodSelector: selP(map[string]string{"app.kubernetes.io/name": "api-b"})},
				{PodSelector: &metav1.LabelSelector{MatchExpressions: []metav1.LabelSelectorRequirement{{Key: "workflows.argoproj.io/workflow", Operator: metav1.LabelSelectorOpExists}}}},
			},
		}},
	}}
	want := []string{
		"targets: app.kubernetes.io/name=api-a",
		"Ingress 50051/TCP ← app.kubernetes.io/name=ui-a, team-b/app.kubernetes.io/name=api-b, workflows.argoproj.io/workflow exists",
	}
	if got := networkPolicySummary(ingressPeers); !slices.Equal(got, want) {
		t.Errorf("networkPolicySummary =\n%v\nwant\n%v", got, want)
	}
	// An EMPTY ingress rule selects every source on every port — allow-from-anywhere, which the old
	// "1 rule" hid. It must read as the wide-open allow it is.
	openRule := &networkingv1.NetworkPolicy{Spec: networkingv1.NetworkPolicySpec{
		PodSelector: sel(map[string]string{"app.kubernetes.io/name": "api-a"}),
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Ingress:     []networkingv1.NetworkPolicyIngressRule{{}},
	}}
	if got, want := networkPolicySummary(openRule), []string{"targets: app.kubernetes.io/name=api-a", "Ingress ← anywhere"}; !slices.Equal(got, want) {
		t.Errorf("networkPolicySummary(open rule) = %v, want %v", got, want)
	}
	// Egress to an ipBlock + a namespace-only peer (all pods in those namespaces), shown with the → arrow.
	egress := &networkingv1.NetworkPolicy{Spec: networkingv1.NetworkPolicySpec{
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeEgress},
		Egress: []networkingv1.NetworkPolicyEgressRule{{
			To: []networkingv1.NetworkPolicyPeer{
				{IPBlock: &networkingv1.IPBlock{CIDR: "10.0.0.0/8", Except: []string{"10.1.0.0/16"}}},
				{NamespaceSelector: ns("kube-system")},
			},
		}},
	}}
	if got, want := networkPolicySummary(egress), []string{"targets: all pods", "Egress → 10.0.0.0/8 except 10.1.0.0/16, kube-system/all pods"}; !slices.Equal(got, want) {
		t.Errorf("networkPolicySummary(egress) = %v, want %v", got, want)
	}
	// A default-deny lockdown: empty selector (all pods), both directions governed with no rules.
	denyAll := &networkingv1.NetworkPolicy{Spec: networkingv1.NetworkPolicySpec{
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress, networkingv1.PolicyTypeEgress},
	}}
	if got, want := networkPolicySummary(denyAll), []string{"targets: all pods", "Ingress: deny all", "Egress: deny all"}; !slices.Equal(got, want) {
		t.Errorf("networkPolicySummary(deny-all) = %v, want %v", got, want)
	}
	// An ungoverned direction is omitted, not shown as "allow all".
	ingressOnly := &networkingv1.NetworkPolicy{Spec: networkingv1.NetworkPolicySpec{
		PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
		Egress:      []networkingv1.NetworkPolicyEgressRule{{}}, // present but not in policyTypes
	}}
	if got := networkPolicySummary(ingressOnly); slices.Contains(got, "Egress: 1 rule") {
		t.Errorf("networkPolicySummary should omit an ungoverned Egress direction, got %v", got)
	}
	if got := networkPolicySummary(&corev1.Pod{}); got != nil {
		t.Errorf("networkPolicySummary(non-netpol) = %v, want nil", got)
	}
}

func TestNodeTaints(t *testing.T) {
	// The real staging shapes: a valued fargate taint and a valueless unreachable taint, joined.
	node := &corev1.Node{Spec: corev1.NodeSpec{Taints: []corev1.Taint{
		{Key: "eks.amazonaws.com/compute-type", Value: "fargate", Effect: corev1.TaintEffectNoSchedule},
		{Key: "node.kubernetes.io/unreachable", Effect: corev1.TaintEffectNoExecute},
	}}}
	if got, want := nodeTaints(node), "eks.amazonaws.com/compute-type=fargate:NoSchedule, node.kubernetes.io/unreachable:NoExecute"; got != want {
		t.Errorf("nodeTaints = %q, want %q", got, want)
	}
	if got := nodeTaints(&corev1.Node{}); got != "" {
		t.Errorf("nodeTaints(untainted) = %q, want empty", got)
	}
	if got := nodeTaints(&corev1.Pod{}); got != "" {
		t.Errorf("nodeTaints(non-node) = %q, want empty", got)
	}
}

func TestNodeAllocatable(t *testing.T) {
	node := &corev1.Node{Status: corev1.NodeStatus{Allocatable: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("2"),
		corev1.ResourceMemory: resource.MustParse("8Gi"),
		corev1.ResourcePods:   resource.MustParse("110"),
	}}}
	got := nodeAllocatable(node)
	if got == nil {
		t.Fatal("nodeAllocatable = nil, want non-nil")
	}
	wantInt64(t, "cpuMilli", got.CPUMilli, 2000)
	wantInt64(t, "memBytes", got.MemBytes, 8*1024*1024*1024)
	wantInt64(t, "pods", got.Pods, 110)

	if got := nodeAllocatable(&corev1.Pod{}); got != nil {
		t.Errorf("nodeAllocatable(non-node) = %+v, want nil", got)
	}
	if got := nodeAllocatable(&corev1.Node{}); got != nil {
		t.Errorf("nodeAllocatable(no allocatable) = %+v, want nil", got)
	}
}

// nodeTotalCapacity reads status.capacity (the node's TOTAL physical capacity, ≥ allocatable) — it
// sets the Use-bar ceiling in the capacity view, distinct from nodeAllocatable's schedulable pool.
func TestNodeTotalCapacity(t *testing.T) {
	node := &corev1.Node{Status: corev1.NodeStatus{Capacity: corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse("16"),
		corev1.ResourceMemory: resource.MustParse("64Gi"),
		corev1.ResourcePods:   resource.MustParse("110"),
	}}}
	got := nodeTotalCapacity(node)
	if got == nil {
		t.Fatal("nodeTotalCapacity = nil, want non-nil")
	}
	wantInt64(t, "cpuMilli", got.CPUMilli, 16000)
	wantInt64(t, "memBytes", got.MemBytes, 64*1024*1024*1024)
	wantInt64(t, "pods", got.Pods, 110)

	if got := nodeTotalCapacity(&corev1.Pod{}); got != nil {
		t.Errorf("nodeTotalCapacity(non-node) = %+v, want nil", got)
	}
	// No cpu/mem reported (only pods) → nil, so the view falls back to allocatable for the ceiling.
	onlyPods := &corev1.Node{Status: corev1.NodeStatus{Capacity: corev1.ResourceList{
		corev1.ResourcePods: resource.MustParse("110"),
	}}}
	if got := nodeTotalCapacity(onlyPods); got != nil {
		t.Errorf("nodeTotalCapacity(no cpu/mem) = %+v, want nil", got)
	}
}

func TestPodRequestsAndLimits(t *testing.T) {
	reqs := func(cpu, mem string) corev1.ResourceList {
		l := corev1.ResourceList{}
		if cpu != "" {
			l[corev1.ResourceCPU] = resource.MustParse(cpu)
		}
		if mem != "" {
			l[corev1.ResourceMemory] = resource.MustParse(mem)
		}
		return l
	}
	ctr := func(req corev1.ResourceList) corev1.Container {
		return corev1.Container{Resources: corev1.ResourceRequirements{Requests: req}}
	}

	// Two containers each setting cpu+mem → summed.
	summed := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{
		ctr(reqs("100m", "128Mi")),
		ctr(reqs("250m", "256Mi")),
	}}}
	got := podRequests(summed)
	if got == nil {
		t.Fatal("podRequests(summed) = nil, want non-nil")
	}
	wantInt64(t, "cpuMilli", got.CPUMilli, 350)
	wantInt64(t, "memBytes", got.MemBytes, (128+256)*1024*1024)
	if got.Pods != nil {
		t.Errorf("podRequests Pods = %v, want nil (never set for pods)", *got.Pods)
	}

	// The critical case: only memory set, no container sets CPU → MemBytes set, CPUMilli nil.
	memOnly := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{ctr(reqs("", "512Mi"))}}}
	got = podRequests(memOnly)
	if got == nil {
		t.Fatal("podRequests(memOnly) = nil, want non-nil")
	}
	if got.CPUMilli != nil {
		t.Errorf("podRequests memOnly CPUMilli = %v, want nil", *got.CPUMilli)
	}
	wantInt64(t, "memBytes", got.MemBytes, 512*1024*1024)

	// No requests at all → nil.
	none := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{ctr(reqs("", ""))}}}
	if got := podRequests(none); got != nil {
		t.Errorf("podRequests(no requests) = %+v, want nil", got)
	}

	// Init containers are excluded from the sum (limits mirror requests).
	withInit := &corev1.Pod{Spec: corev1.PodSpec{
		InitContainers: []corev1.Container{{Resources: corev1.ResourceRequirements{Limits: reqs("4", "4Gi")}}},
		Containers:     []corev1.Container{{Resources: corev1.ResourceRequirements{Limits: reqs("500m", "512Mi")}}},
	}}
	got = podLimits(withInit)
	if got == nil {
		t.Fatal("podLimits(withInit) = nil, want non-nil")
	}
	wantInt64(t, "cpuMilli", got.CPUMilli, 500)
	wantInt64(t, "memBytes", got.MemBytes, 512*1024*1024)

	// Non-pod → nil for both extractors.
	if got := podRequests(&corev1.Node{}); got != nil {
		t.Errorf("podRequests(non-pod) = %+v, want nil", got)
	}
	if got := podLimits(&corev1.Node{}); got != nil {
		t.Errorf("podLimits(non-pod) = %+v, want nil", got)
	}
}

func wantInt64(t *testing.T, name string, got *int64, want int64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s = nil, want %d", name, want)
		return
	}
	if *got != want {
		t.Errorf("%s = %d, want %d", name, *got, want)
	}
}

func TestServiceSelector(t *testing.T) {
	// Sorted "k=v, k=v" so the readout is stable regardless of map order.
	svc := &corev1.Service{Spec: corev1.ServiceSpec{Selector: map[string]string{"tier": "web", "app": "shop"}}}
	if got, want := serviceSelector(svc), "app=shop, tier=web"; got != want {
		t.Errorf("serviceSelector = %q, want %q", got, want)
	}
	// A selectorless Service (ExternalName, or manually-managed endpoints) has nothing to debug → "".
	if got := serviceSelector(&corev1.Service{}); got != "" {
		t.Errorf("serviceSelector(selectorless) = %q, want empty", got)
	}
	if got := serviceSelector(&corev1.Pod{}); got != "" {
		t.Errorf("serviceSelector(non-service) = %q, want empty", got)
	}
}

func TestServicePorts(t *testing.T) {
	svc := &corev1.Service{Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{
		{Name: "https", Port: 443, TargetPort: intstr.FromInt32(8443), Protocol: corev1.ProtocolTCP},
		{Port: 80, NodePort: 30080}, // unset protocol defaults to TCP; nodePort surfaced
		{Port: 9090},                // target == port and no nodePort: just "9090/TCP"
		{Name: "metrics", Port: 53, TargetPort: intstr.FromString("dns"), Protocol: corev1.ProtocolUDP},
	}}}
	want := []string{"https 443→8443/TCP", "80:30080/TCP", "9090/TCP", "metrics 53→dns/UDP"}
	if got := servicePorts(svc); !slices.Equal(got, want) {
		t.Errorf("servicePorts = %v, want %v", got, want)
	}
	if got := servicePorts(&corev1.Pod{}); got != nil {
		t.Errorf("servicePorts(non-service) = %v, want nil", got)
	}
}

func TestIngressRoutes(t *testing.T) {
	num := func(p int32) networkingv1.ServiceBackendPort { return networkingv1.ServiceBackendPort{Number: p} }
	ing := &networkingv1.Ingress{Spec: networkingv1.IngressSpec{
		DefaultBackend: &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "fallback", Port: num(80)}},
		Rules: []networkingv1.IngressRule{
			{Host: "app.example.com", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
				{Path: "/api", Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "api-svc", Port: num(8080)}}},
				{Path: "", Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "web-svc", Port: networkingv1.ServiceBackendPort{Name: "http"}}}}, // empty path → "/", named port
			}}}},
			{Host: "", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
				{Path: "/", Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "catch-all", Port: num(80)}}}, // hostless → "*"
				{Path: "/health", Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "bare-svc"}}}, // no port set → name only (ingressBackend default)
			}}}},
		},
	}}
	want := []string{
		"default → fallback:80",
		"app.example.com/api → api-svc:8080",
		"app.example.com/ → web-svc:http",
		"*/ → catch-all:80",
		"*/health → bare-svc",
	}
	if got := ingressRoutes(ing); !slices.Equal(got, want) {
		t.Errorf("ingressRoutes =\n%v\nwant\n%v", got, want)
	}
	if got := ingressRoutes(&corev1.Pod{}); got != nil {
		t.Errorf("ingressRoutes(non-ingress) = %v, want nil", got)
	}
}

func TestHTTPRouteRoutes(t *testing.T) {
	hr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "gateway.networking.k8s.io/v1",
		"kind":       "HTTPRoute",
		"metadata":   map[string]any{"name": "app", "namespace": "shop"},
		"spec": map[string]any{
			"hostnames": []any{"app.example.com", "www.example.com"},
			"rules": []any{
				// two matches (one PathPrefix, one RegularExpression) + one backend with a port
				map[string]any{
					"matches": []any{
						map[string]any{"path": map[string]any{"type": "PathPrefix", "value": "/api"}},
						map[string]any{"path": map[string]any{"type": "RegularExpression", "value": "/v[0-9]+"}},
					},
					"backendRefs": []any{map[string]any{"name": "api-svc", "port": int64(8080)}},
				},
				// no matches → match-all "/"; weighted split across two backends; float64 port (JSON round-trip)
				map[string]any{
					"backendRefs": []any{
						map[string]any{"name": "web-a", "port": float64(80)},
						map[string]any{"name": "web-b"},
					},
				},
			},
		},
	}}
	want := []string{
		// host-major: a hostname's paths stay together (one rule, then the next), which reads better
		// than interleaving hosts.
		"app.example.com/api → api-svc:8080",
		"app.example.com~/v[0-9]+ → api-svc:8080",
		"www.example.com/api → api-svc:8080",
		"www.example.com~/v[0-9]+ → api-svc:8080",
		"app.example.com/ → web-a:80, web-b",
		"www.example.com/ → web-a:80, web-b",
	}
	if got := httpRouteRoutes(hr); !slices.Equal(got, want) {
		t.Errorf("httpRouteRoutes =\n%v\nwant\n%v", got, want)
	}

	// No hostnames → "*". Exercised through routes() to prove the Ingress/HTTPRoute dispatch.
	hostless := &unstructured.Unstructured{Object: map[string]any{
		"kind": "HTTPRoute",
		"spec": map[string]any{
			"rules": []any{map[string]any{"backendRefs": []any{map[string]any{"name": "only"}}}},
		},
	}}
	if got, want := routes(hostless), []string{"*/ → only"}; !slices.Equal(got, want) {
		t.Errorf("routes(hostless HTTPRoute) = %v, want %v", got, want)
	}
	if got := httpRouteRoutes(&corev1.Pod{}); got != nil {
		t.Errorf("httpRouteRoutes(non-httproute) = %v, want nil", got)
	}
}

func TestTraefikIngressRouteRoutes(t *testing.T) {
	ir := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "traefik.io/v1alpha1",
		"kind":       "IngressRoute",
		"metadata":   map[string]any{"name": "app", "namespace": "shop"},
		"spec": map[string]any{
			"routes": []any{
				// matcher shown verbatim; numeric port; two services weighted-split
				map[string]any{
					"match": "Host(`app.example.com`) && PathPrefix(`/api`)",
					"services": []any{
						map[string]any{"name": "api-svc", "port": int64(8080)},
						map[string]any{"name": "api-canary", "port": float64(8080)},
					},
				},
				// named (string) port
				map[string]any{"match": "Host(`app.example.com`)", "services": []any{
					map[string]any{"name": "web-svc", "port": "http"},
				}},
				// a TraefikService target: the table still names it (a declared target), though no
				// topology edge links it (it isn't a Service node) — see traefikIngressRouteEdges.
				map[string]any{"match": "PathPrefix(`/mirror`)", "services": []any{
					map[string]any{"name": "split", "kind": "TraefikService"},
				}},
				// a middleware-only route (no services) shows its match + the chain that processes it
				map[string]any{"match": "PathPrefix(`/redirect`)", "middlewares": []any{
					map[string]any{"name": "redirect-https"},
				}},
				// middlewares render as " · via …" in spec order; a cross-namespace one is ns-qualified
				// (it never appears as a same-namespace edge, so this is its only surfacing)
				map[string]any{
					"match":    "Host(`auth.example.com`)",
					"services": []any{map[string]any{"name": "api-svc", "port": int64(80)}},
					"middlewares": []any{
						map[string]any{"name": "ratelimit"},
						map[string]any{"name": "auth-forward", "namespace": "infra"},
					},
				},
			},
		},
	}}
	want := []string{
		"Host(`app.example.com`) && PathPrefix(`/api`) → api-svc:8080, api-canary:8080",
		"Host(`app.example.com`) → web-svc:http",
		"PathPrefix(`/mirror`) → split",
		"PathPrefix(`/redirect`) · via redirect-https",
		"Host(`auth.example.com`) → api-svc:80 · via ratelimit, infra/auth-forward",
	}
	if got := routes(ir); !slices.Equal(got, want) {
		t.Errorf("traefikIngressRouteRoutes =\n%v\nwant\n%v", got, want)
	}
	// A non-Traefik CRD named IngressRoute (different group) must not be mistaken for one.
	other := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1", "kind": "IngressRoute",
		"spec": map[string]any{"routes": []any{map[string]any{"match": "x", "services": []any{map[string]any{"name": "s"}}}}},
	}}
	if got := traefikIngressRouteRoutes(other); got != nil {
		t.Errorf("traefikIngressRouteRoutes(non-traefik) = %v, want nil", got)
	}
}

func TestWebhookConfigSummary(t *testing.T) {
	wh := func(kind string, policies ...string) *unstructured.Unstructured {
		webhooks := make([]any, len(policies))
		for i, p := range policies {
			w := map[string]any{"name": "w"}
			if p != "" { // "" models an unset failurePolicy (v1 defaults it to Fail)
				w["failurePolicy"] = p
			}
			webhooks[i] = w
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "admissionregistration.k8s.io/v1", "kind": kind,
			"metadata": map[string]any{"name": "cfg"},
			"webhooks": webhooks,
		}}
	}
	cases := []struct {
		name string
		u    *unstructured.Unstructured
		want string
	}{
		// the real staging shapes: all-Fail (aws-load-balancer) and all-Ignore (elastic-operator)
		{"all fail", wh("ValidatingWebhookConfiguration", "Fail", "Fail", "Fail"), "3 webhooks · Fail"},
		{"all ignore", wh("MutatingWebhookConfiguration", "Ignore", "Ignore"), "2 webhooks · Ignore"},
		// any fail-closed webhook makes the whole config read Fail — the cluster-risk fact
		{"mixed reads Fail", wh("ValidatingWebhookConfiguration", "Ignore", "Fail"), "2 webhooks · Fail"},
		// an unset policy defaults to Fail in v1, so it counts as fail-closed
		{"unset defaults Fail", wh("MutatingWebhookConfiguration", ""), "1 webhook · Fail"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := statusSummary(c.u); got != c.want {
				t.Errorf("statusSummary = %q, want %q", got, c.want)
			}
		})
	}
	if got := webhookConfigSummary(&corev1.Pod{}); got != "" {
		t.Errorf("webhookConfigSummary(non-webhook) = %q, want \"\"", got)
	}
}

func TestTraefikMiddlewareSummary(t *testing.T) {
	mw := func(spec map[string]any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "traefik.io/v1alpha1", "kind": "Middleware",
			"metadata": map[string]any{"name": "m", "namespace": "shop"},
			"spec":     spec,
		}}
	}
	cases := []struct {
		name string
		spec map[string]any
		want string
	}{
		// the real staging shape: a redis-backed rate limiter — average/period + burst
		{"rateLimit", map[string]any{"rateLimit": map[string]any{"average": int64(10), "burst": int64(20), "period": "1s"}}, "rateLimit 10/1s, burst 20"},
		{"rateLimit default period", map[string]any{"rateLimit": map[string]any{"average": int64(100)}}, "rateLimit 100/1s"},
		{"forwardAuth", map[string]any{"forwardAuth": map[string]any{"address": "http://auth/verify"}}, "forwardAuth → http://auth/verify"},
		{"redirectScheme", map[string]any{"redirectScheme": map[string]any{"scheme": "https"}}, "redirect → https"},
		{"stripPrefix", map[string]any{"stripPrefix": map[string]any{"prefixes": []any{"/api", "/v1"}}}, "stripPrefix /api, /v1"},
		{"ipAllowList", map[string]any{"ipAllowList": map[string]any{"sourceRange": []any{"10.0.0.0/8"}}}, "ipAllowList 10.0.0.0/8"},
		// an un-enriched type still surfaces its kind — the key fact
		{"headers falls back to type", map[string]any{"headers": map[string]any{"customRequestHeaders": map[string]any{"X-Foo": "bar"}}}, "headers"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := traefikMiddlewareSummary(mw(c.spec)); got != c.want {
				t.Errorf("traefikMiddlewareSummary = %q, want %q", got, c.want)
			}
		})
	}
	// A non-Traefik CRD named Middleware (different group) is not one.
	other := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1", "kind": "Middleware", "spec": map[string]any{"rateLimit": map[string]any{}},
	}}
	if got := traefikMiddlewareSummary(other); got != "" {
		t.Errorf("traefikMiddlewareSummary(non-traefik) = %q, want \"\"", got)
	}
}

func TestStorageClassSummary(t *testing.T) {
	sc := func(provisioner string, def bool) *unstructured.Unstructured {
		meta := map[string]any{"name": "sc"}
		if def {
			meta["annotations"] = map[string]any{"storageclass.kubernetes.io/is-default-class": "true"}
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
			"metadata": meta, "provisioner": provisioner,
		}}
	}
	if got, want := statusSummary(sc("docker.io/hostpath", true)), "docker.io/hostpath · default"; got != want {
		t.Errorf("default StorageClass status = %q, want %q", got, want)
	}
	if got, want := storageClassSummary(sc("ebs.csi.aws.com", false)), "ebs.csi.aws.com"; got != want {
		t.Errorf("non-default StorageClass summary = %q, want %q", got, want)
	}
	if got := storageClassSummary(&corev1.Service{}); got != "" {
		t.Errorf("storageClassSummary(non-SC) = %q, want empty", got)
	}
}

func TestIngressClassSummary(t *testing.T) {
	ic := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "IngressClass",
		"metadata": map[string]any{
			"name":        "traefik",
			"annotations": map[string]any{"ingressclass.kubernetes.io/is-default-class": "true"},
		},
		"spec": map[string]any{"controller": "traefik.io/ingress-controller"},
	}}
	if got, want := statusSummary(ic), "traefik.io/ingress-controller · default"; got != want {
		t.Errorf("IngressClass status = %q, want %q", got, want)
	}
	// A non-default class shows just its controller.
	plain := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "networking.k8s.io/v1", "kind": "IngressClass",
		"metadata": map[string]any{"name": "nginx"},
		"spec":     map[string]any{"controller": "k8s.io/ingress-nginx"},
	}}
	if got, want := ingressClassSummary(plain), "k8s.io/ingress-nginx"; got != want {
		t.Errorf("IngressClass (non-default) summary = %q, want %q", got, want)
	}
	if got := ingressClassSummary(&corev1.Service{}); got != "" {
		t.Errorf("ingressClassSummary(non-IC) = %q, want empty", got)
	}
}

func TestPriorityClassSummary(t *testing.T) {
	pc := func(spec map[string]any) *unstructured.Unstructured {
		spec["apiVersion"] = "scheduling.k8s.io/v1"
		spec["kind"] = "PriorityClass"
		spec["metadata"] = map[string]any{"name": "p"}
		return &unstructured.Unstructured{Object: spec}
	}
	// A huge system value comma-grouped; not the global default.
	if got, want := statusSummary(pc(map[string]any{"value": int64(2000000000)})), "2,000,000,000"; got != want {
		t.Errorf("PriorityClass status = %q, want %q", got, want)
	}
	// globalDefault + Never preemption both annotate the value.
	if got, want := priorityClassSummary(pc(map[string]any{
		"value": int64(0), "globalDefault": true, "preemptionPolicy": "Never",
	})), "0 · default · never preempts"; got != want {
		t.Errorf("PriorityClass (default, never) = %q, want %q", got, want)
	}
	// A negative user priority keeps its sign and grouping.
	if got, want := priorityClassSummary(pc(map[string]any{"value": int64(-12345)})), "-12,345"; got != want {
		t.Errorf("PriorityClass (negative) = %q, want %q", got, want)
	}
	if got := priorityClassSummary(&corev1.Service{}); got != "" {
		t.Errorf("priorityClassSummary(non-PC) = %q, want empty", got)
	}
}

func TestCRDSummary(t *testing.T) {
	crd := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
		"metadata": map[string]any{"name": "workflows.argoproj.io"},
		"spec": map[string]any{
			"group": "argoproj.io",
			"names": map[string]any{"kind": "Workflow", "plural": "workflows"},
			"scope": "Namespaced",
			"versions": []any{
				map[string]any{"name": "v1alpha1", "served": true, "storage": true},
				map[string]any{"name": "v1beta1", "served": false}, // not served → omitted
			},
		},
	}}
	if got, want := statusSummary(crd), "Workflow · Namespaced · v1alpha1"; got != want {
		t.Errorf("CRD status = %q, want %q", got, want)
	}
	// Two served versions join; scope carries through.
	multi := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
		"metadata": map[string]any{"name": "things.example.com"},
		"spec": map[string]any{
			"names": map[string]any{"kind": "Thing"}, "scope": "Cluster",
			"versions": []any{
				map[string]any{"name": "v1", "served": true},
				map[string]any{"name": "v2", "served": true},
			},
		},
	}}
	if got, want := crdSummary(multi), "Thing · Cluster · v1, v2"; got != want {
		t.Errorf("CRD (multi-version) summary = %q, want %q", got, want)
	}
	if got := crdSummary(&corev1.Service{}); got != "" {
		t.Errorf("crdSummary(non-CRD) = %q, want empty", got)
	}
}

func TestScrapeConfig(t *testing.T) {
	// A Prometheus-Operator ServiceMonitor: label selector, a same-namespace target, one endpoint.
	sm := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "monitoring.coreos.com/v1", "kind": "ServiceMonitor",
		"metadata": map[string]any{"name": "es", "namespace": "shop"},
		"spec": map[string]any{
			"selector":          map[string]any{"matchLabels": map[string]any{"app": "es", "tier": "metrics"}},
			"namespaceSelector": map[string]any{"matchNames": []any{"shop"}},
			"endpoints":         []any{map[string]any{"port": "http", "path": "/metrics", "interval": "1m"}},
		},
	}}
	want := []string{"selects app=es, tier=metrics in shop", ":http/metrics every 1m"}
	if got := scrapeConfig(sm); !slices.Equal(got, want) {
		t.Errorf("scrapeConfig(ServiceMonitor) =\n%v\nwant\n%v", got, want)
	}

	// A VictoriaMetrics VMServiceScrape shares the shape; a path-less endpoint defaults to /metrics, an
	// empty selector reads as "all services", and a numeric targetPort substitutes for a named port.
	vm := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMServiceScrape",
		"metadata": map[string]any{"name": "all", "namespace": "shop"},
		"spec": map[string]any{
			"endpoints": []any{map[string]any{"targetPort": int64(9100)}},
		},
	}}
	want = []string{"selects all services", ":9100/metrics"}
	if got := scrapeConfig(vm); !slices.Equal(got, want) {
		t.Errorf("scrapeConfig(VMServiceScrape) =\n%v\nwant\n%v", got, want)
	}

	// Not a scrape CR → no rows.
	if got := scrapeConfig(&corev1.Service{}); got != nil {
		t.Errorf("scrapeConfig(non-scrape) = %v, want nil", got)
	}
}

func TestDataKeys(t *testing.T) {
	cm := &corev1.ConfigMap{
		Data:       map[string]string{"Corefile": "abcde", "extra.conf": "x"},
		BinaryData: map[string][]byte{"cert.bin": make([]byte, 2048)},
	}
	want := []string{"Corefile · 5B", "cert.bin · 2Ki", "extra.conf · 1B"} // sorted by key
	if got := dataKeys(cm); !slices.Equal(got, want) {
		t.Errorf("dataKeys(ConfigMap) =\n%v\nwant\n%v", got, want)
	}

	sec := &corev1.Secret{
		Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{"tls.crt": make([]byte, 1200), "tls.key": make([]byte, 1600)},
	}
	wantSec := []string{"tls.crt · 1Ki", "tls.key · 2Ki"} // 1600B rounds to 2Ki (%.0f)
	if got := dataKeys(sec); !slices.Equal(got, wantSec) {
		t.Errorf("dataKeys(Secret) =\n%v\nwant\n%v", got, wantSec)
	}
	if got := secretType(sec); got != "kubernetes.io/tls" {
		t.Errorf("secretType = %q, want kubernetes.io/tls", got)
	}
	// An empty Secret type defaults to Opaque (matching kubectl).
	if got := secretType(&corev1.Secret{}); got != "Opaque" {
		t.Errorf("secretType(empty) = %q, want Opaque", got)
	}
	// Non-ConfigMap/Secret kinds (and empty data) yield nil — the drawer renders nothing.
	if got := dataKeys(&corev1.Pod{}); got != nil {
		t.Errorf("dataKeys(Pod) = %v, want nil", got)
	}
	if got := dataKeys(&corev1.ConfigMap{}); got != nil {
		t.Errorf("dataKeys(empty ConfigMap) = %v, want nil", got)
	}
	if got := secretType(&corev1.ConfigMap{}); got != "" {
		t.Errorf("secretType(non-secret) = %q, want empty", got)
	}
}

func TestDsNodeSelector(t *testing.T) {
	ds := &appsv1.DaemonSet{Spec: appsv1.DaemonSetSpec{Template: corev1.PodTemplateSpec{
		Spec: corev1.PodSpec{NodeSelector: map[string]string{"gpu": "true", "arch": "arm64"}},
	}}}
	if got := dsNodeSelector(ds); got != "arch=arm64, gpu=true" { // sorted, deterministic
		t.Errorf("dsNodeSelector = %q", got)
	}
	if got := dsNodeSelector(&appsv1.DaemonSet{}); got != "" {
		t.Errorf("dsNodeSelector(no selector) = %q, want \"\"", got)
	}
	if got := dsNodeSelector(&corev1.Pod{}); got != "" {
		t.Errorf("dsNodeSelector(non-DS) = %q, want \"\"", got)
	}
}

func TestQuotaUsage(t *testing.T) {
	q := &corev1.ResourceQuota{Status: corev1.ResourceQuotaStatus{
		Hard: corev1.ResourceList{
			"requests.cpu":    resource.MustParse("100m"),
			"requests.memory": resource.MustParse("128Mi"),
		},
		Used: corev1.ResourceList{"requests.cpu": resource.MustParse("50m")},
	}}
	// Sorted by resource name; a resource absent from used means zero tracked consumption.
	want := []string{"requests.cpu · 50m / 100m", "requests.memory · 0 / 128Mi"}
	if got := quotaUsage(q); !slices.Equal(got, want) {
		t.Errorf("quotaUsage =\n%v\nwant\n%v", got, want)
	}

	// Before the controller fills status, fall back to spec.hard so a just-created quota still shows
	// its limits.
	fresh := &corev1.ResourceQuota{Spec: corev1.ResourceQuotaSpec{
		Hard: corev1.ResourceList{"pods": resource.MustParse("10")},
	}}
	if got := quotaUsage(fresh); !slices.Equal(got, []string{"pods · 0 / 10"}) {
		t.Errorf("quotaUsage(fresh) = %v", got)
	}

	if got := quotaUsage(&corev1.Pod{}); got != nil {
		t.Errorf("quotaUsage(Pod) = %v, want nil", got)
	}
}

func TestAccessModesAndStorageClass(t *testing.T) {
	gp3 := "gp3"
	pvc := &corev1.PersistentVolumeClaim{Spec: corev1.PersistentVolumeClaimSpec{
		AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce, corev1.ReadWriteOnce, corev1.ReadOnlyMany},
		StorageClassName: &gp3,
	}}
	if got := accessModes(pvc); got != "RWO/ROX" { // de-duped, abbreviated
		t.Errorf("accessModes(PVC) = %q, want RWO/ROX", got)
	}
	if got := storageClass(pvc); got != "gp3" {
		t.Errorf("storageClass(PVC) = %q, want gp3", got)
	}
	pv := &corev1.PersistentVolume{Spec: corev1.PersistentVolumeSpec{
		AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
		StorageClassName: "standard",
	}}
	if got := accessModes(pv); got != "RWX" {
		t.Errorf("accessModes(PV) = %q, want RWX", got)
	}
	if got := storageClass(pv); got != "standard" {
		t.Errorf("storageClass(PV) = %q, want standard", got)
	}
	// A PVC with no explicit class (nil pointer) and a non-storage kind yield empty, not a panic.
	if got := storageClass(&corev1.PersistentVolumeClaim{}); got != "" {
		t.Errorf("storageClass(classless PVC) = %q, want empty", got)
	}
	if got := accessModes(&corev1.Pod{}); got != "" {
		t.Errorf("accessModes(Pod) = %q, want empty", got)
	}
}

func TestBatchInfo(t *testing.T) {
	now := metav1.Now()
	cron := &batchv1.CronJob{
		Spec:   batchv1.CronJobSpec{Schedule: "0 2 * * *"},
		Status: batchv1.CronJobStatus{LastScheduleTime: &now, Active: []corev1.ObjectReference{{Name: "j1"}, {Name: "j2"}}},
	}
	if got := batchActive(cron); got != 2 {
		t.Errorf("batchActive(CronJob) = %d, want 2", got)
	}
	if got := cronLastRun(cron); got != now.UTC().Format(time.RFC3339) {
		t.Errorf("cronLastRun = %q, want the RFC3339 lastScheduleTime", got)
	}
	job := &batchv1.Job{Status: batchv1.JobStatus{Active: 1, Failed: 3, Succeeded: 0}}
	if got := batchActive(job); got != 1 {
		t.Errorf("batchActive(Job) = %d, want 1", got)
	}
	if got := batchFailed(job); got != 3 {
		t.Errorf("batchFailed(Job) = %d, want 3", got)
	}
	// A never-run CronJob and non-batch kinds yield zero values, no panic.
	if got := cronLastRun(&batchv1.CronJob{}); got != "" {
		t.Errorf("cronLastRun(never-run) = %q, want empty", got)
	}
	if got := batchFailed(&corev1.Pod{}); got != 0 {
		t.Errorf("batchFailed(Pod) = %d, want 0", got)
	}
}

func TestHPAScaleAndRange(t *testing.T) {
	hpa := func(min, max, cur, des int64, hasMin, hasDes bool) *unstructured.Unstructured {
		spec := map[string]any{"maxReplicas": max}
		if hasMin {
			spec["minReplicas"] = min
		}
		status := map[string]any{"currentReplicas": cur}
		if hasDes {
			status["desiredReplicas"] = des
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler",
			"spec": spec, "status": status,
		}}
	}
	// mid-scale: current != desired shows the arrow
	if got := hpaScale(hpa(2, 10, 3, 5, true, true)); got != "3 → 5" {
		t.Errorf("hpaScale(mid-scale) = %q, want \"3 → 5\"", got)
	}
	// stable: current == desired shows just the number
	if got := hpaScale(hpa(2, 10, 5, 5, true, true)); got != "5" {
		t.Errorf("hpaScale(stable) = %q, want \"5\"", got)
	}
	// desired 0 means "couldn't compute" (HPAs never scale to zero) — no impossible "1 → 0" arrow
	if got := hpaScale(hpa(1, 5, 1, 0, true, true)); got != "1" {
		t.Errorf("hpaScale(broken) = %q, want \"1\" (no arrow to an uncomputed 0)", got)
	}
	if got := hpaRange(hpa(2, 10, 5, 5, true, true)); got != "2–10" {
		t.Errorf("hpaRange = %q, want \"2–10\"", got)
	}
	// minReplicas unset defaults to 1
	if got := hpaRange(hpa(0, 8, 1, 1, false, true)); got != "1–8" {
		t.Errorf("hpaRange(no min) = %q, want \"1–8\"", got)
	}
	// a fresh HPA with no status yet, and non-HPA kinds, yield empty
	bare := &unstructured.Unstructured{Object: map[string]any{"kind": "HorizontalPodAutoscaler", "spec": map[string]any{"maxReplicas": int64(4)}}}
	if got := hpaScale(bare); got != "" {
		t.Errorf("hpaScale(no status) = %q, want empty", got)
	}
	if got := hpaScale(&corev1.Pod{}); got != "" {
		t.Errorf("hpaScale(Pod) = %q, want empty", got)
	}
}

func TestHPAMetrics(t *testing.T) {
	v2 := func(spec, status map[string]any) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler",
			"spec": spec, "status": status,
		}}
	}
	resourceMetric := func(name string, side string, val any) map[string]any {
		return map[string]any{"type": "Resource", "resource": map[string]any{"name": name, side: val}}
	}
	// The common case: one Resource utilization metric with a sampled current.
	sampled := v2(
		map[string]any{"metrics": []any{resourceMetric("cpu", "target", map[string]any{"type": "Utilization", "averageUtilization": int64(80)})}},
		map[string]any{"currentMetrics": []any{resourceMetric("cpu", "current", map[string]any{"averageUtilization": int64(72)})}},
	)
	if got := hpaMetrics(sampled); got != "cpu 72% / 80%" {
		t.Errorf("hpaMetrics(sampled) = %q, want \"cpu 72%% / 80%%\"", got)
	}
	// No reading yet (fresh HPA / metrics-server down): the target still shows, current as a dash.
	unsampled := v2(
		map[string]any{"metrics": []any{resourceMetric("cpu", "target", map[string]any{"averageUtilization": int64(80)})}},
		map[string]any{},
	)
	if got := hpaMetrics(unsampled); got != "cpu — / 80%" {
		t.Errorf("hpaMetrics(unsampled) = %q, want \"cpu — / 80%%\"", got)
	}
	// Several Resource metrics join in spec order; averageValue targets pass the quantity through.
	multi := v2(
		map[string]any{"metrics": []any{
			resourceMetric("cpu", "target", map[string]any{"averageUtilization": int64(80)}),
			resourceMetric("memory", "target", map[string]any{"averageValue": "200Mi"}),
		}},
		map[string]any{"currentMetrics": []any{
			resourceMetric("memory", "current", map[string]any{"averageValue": "150Mi"}),
			// float64 decoding (a JSON round-trip) must read the same as int64.
			resourceMetric("cpu", "current", map[string]any{"averageUtilization": float64(40)}),
		}},
	)
	if got := hpaMetrics(multi); got != "cpu 40% / 80% · memory 150Mi / 200Mi" {
		t.Errorf("hpaMetrics(multi) = %q", got)
	}
	// autoscaling/v1 schema (no spec.metrics): the flat targetCPUUtilizationPercentage fields.
	v1 := v2(
		map[string]any{"targetCPUUtilizationPercentage": int64(70)},
		map[string]any{"currentCPUUtilizationPercentage": int64(55)},
	)
	if got := hpaMetrics(v1); got != "cpu 55% / 70%" {
		t.Errorf("hpaMetrics(v1) = %q, want \"cpu 55%% / 70%%\"", got)
	}
	// Pods/Object/External metrics are skipped, not half-rendered; non-HPAs read empty.
	external := v2(map[string]any{"metrics": []any{map[string]any{"type": "External"}}}, map[string]any{})
	if got := hpaMetrics(external); got != "" {
		t.Errorf("hpaMetrics(external-only) = %q, want empty", got)
	}
	if got := hpaMetrics(&corev1.Pod{}); got != "" {
		t.Errorf("hpaMetrics(Pod) = %q, want empty", got)
	}
}

func TestArgoAppDestAndRevision(t *testing.T) {
	app := func(dest map[string]any, rev string) *unstructured.Unstructured {
		obj := map[string]any{
			"apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
			"spec": map[string]any{"destination": dest},
		}
		if rev != "" {
			obj["status"] = map[string]any{"sync": map[string]any{"revision": rev}}
		}
		return &unstructured.Unstructured{Object: obj}
	}
	// The common in-cluster case: just the namespace (no noise for the default destination).
	inCluster := app(map[string]any{"server": "https://kubernetes.default.svc", "namespace": "shop"}, "")
	if got := argoAppDest(inCluster); got != "shop" {
		t.Errorf("argoAppDest(in-cluster) = %q, want \"shop\"", got)
	}
	// A named remote cluster prefixes the namespace.
	remote := app(map[string]any{"name": "prod-cluster", "namespace": "shop"}, "")
	if got := argoAppDest(remote); got != "prod-cluster/shop" {
		t.Errorf("argoAppDest(remote) = %q, want \"prod-cluster/shop\"", got)
	}
	// A 40-hex git SHA shortens to 8 chars; other revision forms pass through.
	sha := app(map[string]any{"namespace": "shop"}, "0123456789abcdef0123456789abcdef01234567")
	if got := argoAppRevision(sha); got != "01234567" {
		t.Errorf("argoAppRevision(sha) = %q, want \"01234567\"", got)
	}
	tag := app(map[string]any{"namespace": "shop"}, "v1.2.3")
	if got := argoAppRevision(tag); got != "v1.2.3" {
		t.Errorf("argoAppRevision(tag) = %q, want \"v1.2.3\"", got)
	}
	// A non-Argo kind named Application must not match (the group guard).
	other := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.oam.dev/v1beta1", "kind": "Application",
		"spec": map[string]any{"destination": map[string]any{"namespace": "shop"}},
	}}
	if got := argoAppDest(other); got != "" {
		t.Errorf("argoAppDest(non-argo Application) = %q, want empty", got)
	}
}

func TestPDBPolicyAndDisruptions(t *testing.T) {
	minAvail := intstr.FromInt32(2)
	pdb := &policyv1.PodDisruptionBudget{
		Spec:   policyv1.PodDisruptionBudgetSpec{MinAvailable: &minAvail},
		Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 1, CurrentHealthy: 3, DesiredHealthy: 2},
	}
	if got := pdbPolicy(pdb); got != "min 2" {
		t.Errorf("pdbPolicy(minAvailable) = %q, want \"min 2\"", got)
	}
	if got := pdbDisruptions(pdb); got != "1" {
		t.Errorf("pdbDisruptions = %q, want \"1\"", got)
	}
	// maxUnavailable as a percentage; disruptionsAllowed 0 (the "drain blocks here" state) is surfaced, not hidden
	maxPct := intstr.FromString("50%")
	pdb2 := &policyv1.PodDisruptionBudget{
		Spec:   policyv1.PodDisruptionBudgetSpec{MaxUnavailable: &maxPct},
		Status: policyv1.PodDisruptionBudgetStatus{DisruptionsAllowed: 0},
	}
	if got := pdbPolicy(pdb2); got != "max 50%" {
		t.Errorf("pdbPolicy(maxUnavailable%%) = %q, want \"max 50%%\"", got)
	}
	if got := pdbDisruptions(pdb2); got != "0" {
		t.Errorf("pdbDisruptions(none allowed) = %q, want \"0\" (not hidden)", got)
	}
	// non-PDB kinds yield empty
	if got := pdbPolicy(&corev1.Pod{}); got != "" {
		t.Errorf("pdbPolicy(Pod) = %q, want empty", got)
	}
	if got := pdbDisruptions(&corev1.Pod{}); got != "" {
		t.Errorf("pdbDisruptions(Pod) = %q, want empty", got)
	}
}

func TestStorageClassInfo(t *testing.T) {
	sc := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion":           "storage.k8s.io/v1",
		"kind":                 "StorageClass",
		"metadata":             map[string]any{"name": "gp3"},
		"provisioner":          "ebs.csi.aws.com",
		"reclaimPolicy":        "Retain",
		"volumeBindingMode":    "WaitForFirstConsumer",
		"allowVolumeExpansion": true,
	}}
	if got := storageClassProvisioner(sc); got != "ebs.csi.aws.com" {
		t.Errorf("provisioner = %q, want ebs.csi.aws.com", got)
	}
	if got := storageClassReclaim(sc); got != "Retain" {
		t.Errorf("reclaim = %q, want Retain", got)
	}
	if got := storageClassBinding(sc); got != "WaitForFirstConsumer" {
		t.Errorf("binding = %q, want WaitForFirstConsumer", got)
	}
	if !storageClassExpandable(sc) {
		t.Error("expandable = false, want true")
	}
	// Unset reclaim/binding default to the API defaults (Delete / Immediate); expansion defaults false.
	bare := &unstructured.Unstructured{Object: map[string]any{
		"kind": "StorageClass", "provisioner": "rancher.io/local-path",
	}}
	if got := storageClassReclaim(bare); got != "Delete" {
		t.Errorf("reclaim(unset) = %q, want Delete (API default)", got)
	}
	if got := storageClassBinding(bare); got != "Immediate" {
		t.Errorf("binding(unset) = %q, want Immediate (API default)", got)
	}
	if storageClassExpandable(bare) {
		t.Error("expandable(unset) = true, want false")
	}
	// Non-StorageClass kinds yield zero values (no defaults leaking onto a Pod).
	if got := storageClassReclaim(&corev1.Pod{}); got != "" {
		t.Errorf("reclaim(Pod) = %q, want empty", got)
	}
}

func TestRoleRules(t *testing.T) {
	role := &rbacv1.Role{Rules: []rbacv1.PolicyRule{
		{APIGroups: []string{""}, Resources: []string{"pods", "services"}, Verbs: []string{"get", "list", "watch"}},
		{APIGroups: []string{"apps"}, Resources: []string{"deployments"}, Verbs: []string{"*"}},
		{APIGroups: []string{""}, Resources: []string{"secrets"}, ResourceNames: []string{"db-creds"}, Verbs: []string{"get"}},
	}}
	want := []string{
		"pods, services: get, list, watch",
		"deployments.apps: *",
		"secrets [db-creds]: get",
	}
	if got := roleRules(role); !slices.Equal(got, want) {
		t.Errorf("roleRules(Role) =\n%v\nwant\n%v", got, want)
	}

	// ClusterRoles also carry non-resource URL rules (e.g. /healthz).
	cr := &rbacv1.ClusterRole{Rules: []rbacv1.PolicyRule{
		{NonResourceURLs: []string{"/healthz", "/readyz"}, Verbs: []string{"get"}},
	}}
	if got := roleRules(cr); !slices.Equal(got, []string{"/healthz, /readyz: get"}) {
		t.Errorf("roleRules(ClusterRole nonResource) = %v", got)
	}

	if got := roleRules(&corev1.Pod{}); got != nil {
		t.Errorf("roleRules(non-role) = %v, want nil", got)
	}
}

func TestBindingSubjectsAndRoleRef(t *testing.T) {
	rb := &rbacv1.RoleBinding{
		RoleRef: rbacv1.RoleRef{Kind: "ClusterRole", Name: "edit"},
		Subjects: []rbacv1.Subject{
			{Kind: "User", Name: "alice@example.com"},
			{Kind: "Group", Name: "platform"},
			{Kind: "ServiceAccount", Namespace: "shop", Name: "deployer"},
		},
	}
	if got := bindingRoleRef(rb); got != "ClusterRole/edit" {
		t.Errorf("bindingRoleRef = %q, want ClusterRole/edit", got)
	}
	want := []string{"User: alice@example.com", "Group: platform", "ServiceAccount: shop/deployer"}
	if got := bindingSubjects(rb); !slices.Equal(got, want) {
		t.Errorf("bindingSubjects =\n%v\nwant\n%v", got, want)
	}

	crb := &rbacv1.ClusterRoleBinding{
		RoleRef:  rbacv1.RoleRef{Kind: "ClusterRole", Name: "cluster-admin"},
		Subjects: []rbacv1.Subject{{Kind: "Group", Name: "system:masters"}},
	}
	if got := bindingRoleRef(crb); got != "ClusterRole/cluster-admin" {
		t.Errorf("bindingRoleRef(CRB) = %q", got)
	}
	if got := bindingSubjects(crb); !slices.Equal(got, []string{"Group: system:masters"}) {
		t.Errorf("bindingSubjects(CRB) = %v", got)
	}

	if got := bindingRoleRef(&corev1.Pod{}); got != "" {
		t.Errorf("bindingRoleRef(non-binding) = %q, want empty", got)
	}
	if got := bindingSubjects(&corev1.Pod{}); got != nil {
		t.Errorf("bindingSubjects(non-binding) = %v, want nil", got)
	}
}

func TestServiceClusterIP(t *testing.T) {
	tests := []struct {
		name string
		svc  *corev1.Service
		want string
	}{
		{"clusterIP", &corev1.Service{Spec: corev1.ServiceSpec{ClusterIP: "10.96.0.1"}}, "10.96.0.1"},
		{"headless", &corev1.Service{Spec: corev1.ServiceSpec{ClusterIP: corev1.ClusterIPNone}}, "headless"},
		{"unassigned", &corev1.Service{Spec: corev1.ServiceSpec{}}, ""},
		{"externalName", &corev1.Service{Spec: corev1.ServiceSpec{
			Type: corev1.ServiceTypeExternalName, ExternalName: "db.example.com",
		}}, "db.example.com"},
	}
	for _, tt := range tests {
		if got := serviceClusterIP(tt.svc); got != tt.want {
			t.Errorf("serviceClusterIP(%s) = %q, want %q", tt.name, got, tt.want)
		}
	}
	if got := serviceClusterIP(&corev1.Pod{}); got != "" {
		t.Errorf("serviceClusterIP(non-service) = %q, want empty", got)
	}
}

func TestServiceExternalAddress(t *testing.T) {
	lb := func(ing ...corev1.LoadBalancerIngress) *corev1.Service {
		return &corev1.Service{
			Spec:   corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer},
			Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: ing}},
		}
	}
	tests := []struct {
		name string
		svc  *corev1.Service
		want string
	}{
		{"lb hostname", lb(corev1.LoadBalancerIngress{Hostname: "lb.example.com"}), "lb.example.com"},
		{"lb ip", lb(corev1.LoadBalancerIngress{IP: "203.0.113.7"}), "203.0.113.7"},
		// An IP is the more specific address, so prefer it when both are present.
		{"lb ip preferred over hostname", lb(corev1.LoadBalancerIngress{IP: "203.0.113.7", Hostname: "lb.example.com"}), "203.0.113.7"},
		// A LoadBalancer with no ingress yet is still provisioning — say so, don't hide it.
		{"lb pending", lb(), "pending"},
		{"externalIPs", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, ExternalIPs: []string{"198.51.100.4"}}}, "198.51.100.4"},
		{"plain clusterIP", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, ClusterIP: "10.96.0.1"}}, ""},
	}
	for _, tt := range tests {
		if got := serviceExternalAddress(tt.svc); got != tt.want {
			t.Errorf("serviceExternalAddress(%s) = %q, want %q", tt.name, got, tt.want)
		}
	}
	if got := serviceExternalAddress(&corev1.Pod{}); got != "" {
		t.Errorf("serviceExternalAddress(non-service) = %q, want empty", got)
	}
}

func TestHumanizeBytes(t *testing.T) {
	tests := map[int64]string{
		512:                     "512B",
		2048:                    "2Ki",
		16 * 1024 * 1024 * 1024: "16Gi",
	}
	for in, want := range tests {
		if got := humanizeBytes(in); got != want {
			t.Errorf("humanizeBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestLastTerminatedString(t *testing.T) {
	term := func(reason string, exit int32) corev1.ContainerState {
		return corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: reason, ExitCode: exit}}
	}
	cases := []struct {
		name  string
		state corev1.ContainerState
		want  string
	}{
		{"reason and non-zero exit", term("OOMKilled", 137), "OOMKilled (exit 137)"},
		{"reason only (clean exit)", term("Completed", 0), "Completed"},
		{"exit code only, no reason", term("", 137), "exit 137"},
		{"nothing actionable (clean, no reason)", term("", 0), ""},
		{"never terminated before", corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := lastTerminatedString(c.state); got != c.want {
				t.Errorf("lastTerminatedString = %q, want %q", got, c.want)
			}
		})
	}

	// containerStat wires LastTerminationState through: a now-Running container that was OOMKilled
	// carries the previous reason so the drawer can explain the restart.
	cs := corev1.ContainerStatus{
		Name:                 "app",
		Ready:                true,
		RestartCount:         1,
		State:                corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
		LastTerminationState: term("OOMKilled", 137),
	}
	got := containerStat(cs, false)
	if got.State != "Running" || got.LastTerminated != "OOMKilled (exit 137)" {
		t.Errorf("containerStat = %+v, want State=Running LastTerminated=%q", got, "OOMKilled (exit 137)")
	}

	// A container caught currently Terminated (e.g. mid-crashloop) must NOT also carry LastTerminated:
	// the current State already shows the exit, so repeating an identical "last exit" is redundant.
	crashing := corev1.ContainerStatus{
		Name:                 "app",
		RestartCount:         3,
		State:                corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}},
		LastTerminationState: term("Error", 1),
	}
	if g := containerStat(crashing, false); g.State != "Terminated: Error (exit 1)" || g.LastTerminated != "" {
		t.Errorf("containerStat(crashing) = %+v, want State=%q LastTerminated empty", g, "Terminated: Error (exit 1)")
	}
}
