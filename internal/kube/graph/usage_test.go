package graph

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
)

func podMetric(ns, name string, containers ...corev1.ResourceList) metricsv1beta1.PodMetrics {
	pm := metricsv1beta1.PodMetrics{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
	for _, u := range containers {
		pm.Containers = append(pm.Containers, metricsv1beta1.ContainerMetrics{Usage: u})
	}
	return pm
}

func nodeMetric(name string, usage corev1.ResourceList) metricsv1beta1.NodeMetrics {
	return metricsv1beta1.NodeMetrics{ObjectMeta: metav1.ObjectMeta{Name: name}, Usage: usage}
}

func rl(cpu, mem string) corev1.ResourceList {
	return corev1.ResourceList{
		corev1.ResourceCPU:    resource.MustParse(cpu),
		corev1.ResourceMemory: resource.MustParse(mem),
	}
}

// A nil metrics client means metrics-server is absent: BuildUsage must return (nil, nil) so the SSE
// handler treats it as a graceful no-op, not an error (the documented contract).
func TestBuildUsageNilClient(t *testing.T) {
	u, err := BuildUsage(context.Background(), nil, "shop", false, nil, nil)
	if u != nil || err != nil {
		t.Errorf("BuildUsage(nil mc) = (%v, %v), want (nil, nil)", u, err)
	}
}

// joinUsage is the core transform: pod container usages SUM, both pods and nodes key by their
// resolved UID, and any metric whose object the resolver can't place is dropped (no graph node to
// attach to).
func TestJoinUsageSumsAndResolves(t *testing.T) {
	pods := []metricsv1beta1.PodMetrics{
		podMetric("shop", "web", rl("250m", "128Mi"), rl("20m", "64Mi")), // two containers → 270m / 192Mi
		podMetric("shop", "ghost", rl("999m", "1Gi")),                     // resolver returns ok=false → skipped
	}
	nodes := []metricsv1beta1.NodeMetrics{
		nodeMetric("worker-1", rl("1500m", "2Gi")),
		nodeMetric("worker-unknown", rl("500m", "1Gi")), // unresolved node → skipped
	}
	resolvePod := func(ns, name string) (string, bool) {
		if ns == "shop" && name == "web" {
			return "web-uid", true
		}
		return "", false
	}
	resolveNode := func(_, name string) (string, bool) {
		if name == "worker-1" {
			return "node-uid", true
		}
		return "", false
	}

	items := joinUsage(pods, nodes, resolvePod, resolveNode)
	if len(items) != 2 {
		t.Fatalf("items = %d entries (%v), want 2 (unresolved pod + node dropped)", len(items), items)
	}
	if got := items["web-uid"]; got.CPUMilli != 270 || got.MemBytes != 192*1024*1024 {
		t.Errorf("web-uid = %+v, want {270, 192Mi} (containers summed)", got)
	}
	if got := items["node-uid"]; got.CPUMilli != 1500 || got.MemBytes != 2*1024*1024*1024 {
		t.Errorf("node-uid = %+v, want {1500, 2Gi}", got)
	}
}

// Multi-container pods carry a per-container breakdown (name-sorted, so ticks marshal identically
// regardless of metrics-server's reporting order); single-container pods omit it — the breakdown
// would repeat the total, and most pods are single-container, so omitting keeps the payload lean.
func TestJoinUsagePerContainerBreakdown(t *testing.T) {
	resolve := func(_, name string) (string, bool) { return name + "-uid", true }

	multi := metricsv1beta1.PodMetrics{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web"}}
	multi.Containers = []metricsv1beta1.ContainerMetrics{
		{Name: "sidecar", Usage: rl("20m", "64Mi")}, // deliberately out of name order
		{Name: "app", Usage: rl("250m", "128Mi")},
	}
	single := podMetric("shop", "solo", rl("5m", "16Mi"))

	items := joinUsage([]metricsv1beta1.PodMetrics{multi, single}, nil, resolve, resolve)

	got := items["web-uid"].Containers
	want := []ContainerUsage{
		{Name: "app", CPUMilli: 250, MemBytes: 128 * 1024 * 1024},
		{Name: "sidecar", CPUMilli: 20, MemBytes: 64 * 1024 * 1024},
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("multi-container breakdown = %+v, want %+v (name-sorted)", got, want)
	}
	if items["web-uid"].CPUMilli != 270 {
		t.Errorf("total CPUMilli = %d, want 270 (breakdown does not replace the sum)", items["web-uid"].CPUMilli)
	}
	if items["solo-uid"].Containers != nil {
		t.Errorf("single-container pod carries a breakdown %+v, want none", items["solo-uid"].Containers)
	}
}

// A pod with no containers resolves to a zero usage (not skipped) — it still has a graph node and an
// honest zero is a real reading; and an empty input yields an empty (non-nil) map.
func TestJoinUsageEdgeCases(t *testing.T) {
	resolve := func(_, name string) (string, bool) { return name + "-uid", true }

	items := joinUsage([]metricsv1beta1.PodMetrics{podMetric("shop", "idle")}, nil, resolve, resolve)
	if got, ok := items["idle-uid"]; !ok || got.CPUMilli != 0 || got.MemBytes != 0 {
		t.Errorf("containerless pod = %+v (ok=%v), want a zero reading present", got, ok)
	}

	if empty := joinUsage(nil, nil, resolve, resolve); empty == nil || len(empty) != 0 {
		t.Errorf("joinUsage(nil, nil) = %v, want an empty non-nil map", empty)
	}
}
