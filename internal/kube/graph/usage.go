package graph

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsversioned "k8s.io/metrics/pkg/client/clientset/versioned"
)

// ResourceUsage is one resource's live CPU + memory draw, as reported by metrics-server.
// Both fields are omitempty so a partial reading (e.g. CPU only) marshals compactly.
type ResourceUsage struct {
	CPUMilli int64 `json:"cpuMilli,omitempty"`
	MemBytes int64 `json:"memBytes,omitempty"`
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

	items := map[string]ResourceUsage{}

	podNS := ns
	if clusterScope {
		podNS = metav1.NamespaceAll
	}
	podList, err := mc.MetricsV1beta1().PodMetricses(podNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range podList.Items {
		pm := &podList.Items[i]
		uid, ok := resolvePod(pm.Namespace, pm.Name)
		if !ok {
			continue
		}
		var cpu, mem int64
		for j := range pm.Containers {
			c := &pm.Containers[j]
			cpu += c.Usage.Cpu().MilliValue()
			mem += c.Usage.Memory().Value()
		}
		items[uid] = ResourceUsage{CPUMilli: cpu, MemBytes: mem}
	}

	nodeList, err := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	for i := range nodeList.Items {
		nm := &nodeList.Items[i]
		uid, ok := resolveNode("", nm.Name)
		if !ok {
			continue
		}
		items[uid] = ResourceUsage{
			CPUMilli: nm.Usage.Cpu().MilliValue(),
			MemBytes: nm.Usage.Memory().Value(),
		}
	}

	return &Usage{Items: items}, nil
}
