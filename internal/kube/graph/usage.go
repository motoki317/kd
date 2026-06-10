package graph

import (
	"context"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsv1beta1 "k8s.io/metrics/pkg/apis/metrics/v1beta1"
	metricsversioned "k8s.io/metrics/pkg/client/clientset/versioned"
)

// ResourceUsage is one resource's live CPU + memory draw, as reported by metrics-server.
// Both fields are omitempty so a partial reading (e.g. CPU only) marshals compactly.
type ResourceUsage struct {
	CPUMilli int64 `json:"cpuMilli,omitempty"`
	MemBytes int64 `json:"memBytes,omitempty"`
	// Containers breaks a pod's total down per container, so the drawer can answer "which container
	// is eating the memory?" without `kubectl top pod --containers`. Only multi-container pods carry
	// it — a single container's breakdown just repeats the total, and most pods are single-container,
	// so omitting them keeps the cluster-wide usage payload (every pod, every ~15s) lean.
	Containers []ContainerUsage `json:"containers,omitempty"`
}

// ContainerUsage is one container's share of its pod's live draw, named so the client can pin the
// reading onto that container's card. A zero value marshals compactly (omitempty) — the client
// treats a missing number as zero, which is what metrics-server's rounding produced anyway.
type ContainerUsage struct {
	Name     string `json:"name"`
	CPUMilli int64  `json:"cpuMilli,omitempty"`
	MemBytes int64  `json:"memBytes,omitempty"`
}

// Usage is the SSE `usage` payload: live resource draw keyed by object UID for both Nodes and
// Pods. UID keys let the client join usage onto graph nodes without re-resolving names.
type Usage struct {
	Items map[string]ResourceUsage `json:"items"`
}

// UIDResolver maps a (namespace, name) pair to an object's UID. Pods pass their namespace;
// cluster-scoped Nodes pass "". metrics-server reports metrics keyed by namespace/name and does
// not carry the object's UID, so the caller supplies a resolver built from the cache snapshot
// (which is keyed by UID) to bridge the two.
type UIDResolver func(namespace, name string) (uid string, ok bool)

// BuildUsage collects live Pod and Node usage from metrics-server and keys it by object UID via
// the supplied resolvers. It returns (nil, nil) when mc is nil (metrics-server absent) so the
// SSE handler can treat "no metrics" as a graceful no-op rather than an error.
//
// Pod metrics are listed for the given namespace (or every namespace for a cluster scope); Node
// metrics are always listed (nodes are cluster-scoped and the capacity view wants node draw
// regardless of the selected namespace). A metric whose object cannot be resolved to a UID is
// skipped — it has no graph node to attach to.
func BuildUsage(ctx context.Context, mc metricsversioned.Interface, ns string, clusterScope bool, resolvePod, resolveNode UIDResolver) (*Usage, error) {
	if mc == nil {
		return nil, nil
	}

	podNS := ns
	if clusterScope {
		podNS = metav1.NamespaceAll
	}
	podList, err := mc.MetricsV1beta1().PodMetricses(podNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	nodeList, err := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	return &Usage{Items: joinUsage(podList.Items, nodeList.Items, resolvePod, resolveNode)}, nil
}

// joinUsage is the pure transform half of BuildUsage (separated so it is testable without a live
// metrics client, whose fake List reaction does not populate the metrics group): it sums each pod's
// per-container draw, keys both pods and nodes by their resolved UID, and drops any metric the
// resolver cannot place (no graph node to attach to).
func joinUsage(pods []metricsv1beta1.PodMetrics, nodes []metricsv1beta1.NodeMetrics, resolvePod, resolveNode UIDResolver) map[string]ResourceUsage {
	items := map[string]ResourceUsage{}
	for i := range pods {
		pm := &pods[i]
		uid, ok := resolvePod(pm.Namespace, pm.Name)
		if !ok {
			continue
		}
		var cpu, mem int64
		var breakdown []ContainerUsage
		for j := range pm.Containers {
			c := &pm.Containers[j]
			cc, cm := c.Usage.Cpu().MilliValue(), c.Usage.Memory().Value()
			cpu += cc
			mem += cm
			breakdown = append(breakdown, ContainerUsage{Name: c.Name, CPUMilli: cc, MemBytes: cm})
		}
		u := ResourceUsage{CPUMilli: cpu, MemBytes: mem}
		if len(breakdown) > 1 {
			// Name-sorted so successive ticks marshal identically regardless of metrics-server's
			// reporting order; the client joins by name, so wire order carries no meaning.
			sort.Slice(breakdown, func(a, b int) bool { return breakdown[a].Name < breakdown[b].Name })
			u.Containers = breakdown
		}
		items[uid] = u
	}
	for i := range nodes {
		nm := &nodes[i]
		uid, ok := resolveNode("", nm.Name)
		if !ok {
			continue
		}
		items[uid] = ResourceUsage{
			CPUMilli: nm.Usage.Cpu().MilliValue(),
			MemBytes: nm.Usage.Memory().Value(),
		}
	}
	return items
}
