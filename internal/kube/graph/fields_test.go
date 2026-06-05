package graph

import (
	"slices"
	"testing"
	"time"

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
				// a middleware-only route with no services at all still shows its match
				map[string]any{"match": "PathPrefix(`/redirect`)"},
			},
		},
	}}
	want := []string{
		"Host(`app.example.com`) && PathPrefix(`/api`) → api-svc:8080, api-canary:8080",
		"Host(`app.example.com`) → web-svc:http",
		"PathPrefix(`/mirror`) → split",
		"PathPrefix(`/redirect`)",
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
