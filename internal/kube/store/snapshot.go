package store

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/tools/cache"
)

// Snapshot building: turn the live informer caches into a flat []runtime.Object for the graph
// builder. Split from store.go (which owns the informer/cache lifecycle) so the read-side — what a
// viewer sees for a namespace, the cluster scope, or the cluster-wide capacity view — reads as one
// file. The ride-along policy that pulls referenced cluster-scoped objects into a namespace snapshot
// lives here too (see appendRideAlong).

// SnapshotNamespace returns every cached object in the given namespace, plus the
// cluster-scoped objects that a namespaced object in this namespace references (one hop
// via ownerReferences or any spec-field reference that resolves to a cluster-scoped
// object). See ride-along policy in docs/ADR/20260528-dynamic-informers-and-cluster-scope.md.
//
// For the cluster sentinel (ClusterScope) returns every cluster-scoped object.
func (c *Cache) SnapshotNamespace(namespace string) []runtime.Object {
	if namespace == ClusterScope {
		return c.SnapshotCluster()
	}
	c.mu.Lock()
	resources := make([]Resource, 0, len(c.resources))
	for _, r := range c.resources {
		resources = append(resources, r)
	}
	c.mu.Unlock()

	var out []runtime.Object
	for _, r := range resources {
		if !r.Namespaced {
			continue
		}
		objs, err := r.Informer.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
		if err != nil {
			continue
		}
		for _, obj := range objs {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	out = appendRideAlong(out, resources)
	return out
}

// SnapshotCluster returns every cluster-scoped cached object.
func (c *Cache) SnapshotCluster() []runtime.Object {
	c.mu.Lock()
	resources := make([]Resource, 0, len(c.resources))
	for _, r := range c.resources {
		resources = append(resources, r)
	}
	c.mu.Unlock()

	var out []runtime.Object
	for _, r := range resources {
		if r.Namespaced {
			continue
		}
		for _, obj := range r.Informer.GetIndexer().List() {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	return out
}

// SnapshotNodesAndPods returns every cached Node and every Pod across all namespaces. The Nodes
// group-by (capacity view) is inherently cluster-wide — a node hosts pods from every namespace —
// so it always draws the whole cluster's nodes+pods regardless of the selected namespace, dimming
// pods outside it on the client. This is the only snapshot that crosses the per-namespace
// ride-along boundary, deliberately: a node's true utilization can't be shown from one namespace's
// pods alone.
func (c *Cache) SnapshotNodesAndPods() []runtime.Object {
	c.mu.Lock()
	nodes, hasNodes := c.resources[nodesGVR]
	pods, hasPods := c.resources[podsGVR]
	c.mu.Unlock()

	var out []runtime.Object
	add := func(r Resource, ok bool) {
		if !ok {
			return
		}
		for _, obj := range r.Informer.GetIndexer().List() {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	add(nodes, hasNodes)
	add(pods, hasPods)
	return out
}

// appendRideAlong adds cluster-scoped objects that are referenced (one hop) by the
// namespaced objects already in `out`. Resolved references:
//   - metadata.ownerReferences UID → any cluster-scoped object with that UID
//   - PVC.spec.volumeName → PersistentVolume
//
// A Pod's Node is deliberately NOT pulled in: the pod↔node story lives in the Nodes group-by
// (capacity) view, and the `scheduledOn` edge isn't surfaced by any relationship category, so a
// rode-along Node only ever appeared as a permanently-orphaned card in the namespace graph.
//
// Lookups go through the per-informer indexer: UID via the uidIndex secondary index
// (installed by registerLocked), Node/PV by name via the default key index. Each lookup is
// O(|refs|) so the total work is bounded by the namespaced-object reference fan-out, not by
// the size of cluster-scoped state — important on clusters with thousands of CRs.
func appendRideAlong(out []runtime.Object, resources []Resource) []runtime.Object {
	if len(out) == 0 {
		return out
	}
	wantUIDs := map[string]bool{}
	wantPVNames := map[string]bool{}
	have := map[string]bool{}
	for _, obj := range out {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		if uid := string(u.GetUID()); uid != "" {
			have[uid] = true
		}
		for _, or := range u.GetOwnerReferences() {
			if or.UID != "" {
				wantUIDs[string(or.UID)] = true
			}
		}
		if u.GetKind() == "PersistentVolumeClaim" {
			if name, found, _ := unstructured.NestedString(u.Object, "spec", "volumeName"); found && name != "" {
				wantPVNames[name] = true
			}
		}
	}
	if len(wantUIDs) == 0 && len(wantPVNames) == 0 {
		return out
	}
	add := func(obj any) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			return
		}
		uid := string(u.GetUID())
		if have[uid] {
			return
		}
		have[uid] = true
		out = append(out, u)
	}
	for _, r := range resources {
		if r.Namespaced {
			continue
		}
		idx := r.Informer.GetIndexer()
		for uid := range wantUIDs {
			objs, err := idx.ByIndex(uidIndex, uid)
			if err != nil {
				continue
			}
			for _, obj := range objs {
				add(obj)
			}
		}
		if r.Kind == "PersistentVolume" {
			for name := range wantPVNames {
				if obj, exists, _ := idx.GetByKey(name); exists {
					add(obj)
				}
			}
		}
	}
	return out
}
