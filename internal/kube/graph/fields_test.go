package graph

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/resource"
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
