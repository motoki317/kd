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
// cluster-scoped objects associated with it: those a namespaced object references (one hop via
// ownerReferences or a spec-field reference) and the ClusterRoleBindings that grant a ClusterRole
// to a ServiceAccount in this namespace. See ride-along policy in
// docs/ADR/20260528-dynamic-informers-and-cluster-scope.md.
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

// appendRideAlong adds cluster-scoped objects associated with the namespaced objects already in
// `out`. Resolved references:
//   - metadata.ownerReferences UID → any cluster-scoped object with that UID
//   - PVC.spec.volumeName → PersistentVolume
//   - RoleBinding.roleRef → ClusterRole (when roleRef.kind == ClusterRole)
//   - a ClusterRoleBinding that binds a ServiceAccount in this namespace → that binding, plus a
//     second hop to the ClusterRole it grants
//
// The RBAC chain is what lets a namespace's RBAC relationship view show the cluster-scoped grants
// its ServiceAccounts actually hold: a namespaced RoleBinding can grant a ClusterRole, and a
// cluster-scoped ClusterRoleBinding can grant one to a namespaced SA — both otherwise invisible
// from inside the namespace, so their `binds` edges were dropped for want of a target node. The
// ClusterRoleBinding is the one reference resolved in REVERSE (the cluster-scoped object names the
// namespaced SA, not vice-versa), so it costs a scan of every ClusterRoleBinding — bounded by
// ClusterRoleBinding cardinality (low in practice), unlike the others which stay bounded by the
// namespace's own reference fan-out.
//
// A Pod's Node is deliberately NOT pulled in: the pod↔node story lives in the Nodes group-by
// (capacity) view, and the `scheduledOn` edge isn't surfaced by any relationship category, so a
// rode-along Node only ever appeared as a permanently-orphaned card in the namespace graph.
//
// Lookups go through the per-informer indexer: UID via the uidIndex secondary index
// (installed by registerLocked), Node/PV/ClusterRole by name via the default key index. Each
// keyed lookup is O(|refs|); the ClusterRoleBinding scan is O(|ClusterRoleBindings|).
func appendRideAlong(out []runtime.Object, resources []Resource) []runtime.Object {
	if len(out) == 0 {
		return out
	}
	wantUIDs := map[string]bool{}
	wantPVNames := map[string]bool{}
	wantClusterRoles := map[string]bool{} // ClusterRole names (cluster-scoped) referenced by a roleRef
	saKeys := map[string]bool{}           // "namespace/name" of every ServiceAccount in this namespace
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
		switch u.GetKind() {
		case "PersistentVolumeClaim":
			if name, found, _ := unstructured.NestedString(u.Object, "spec", "volumeName"); found && name != "" {
				wantPVNames[name] = true
			}
		case "ServiceAccount":
			saKeys[u.GetNamespace()+"/"+u.GetName()] = true
		case "RoleBinding":
			if name := clusterRoleRefName(u); name != "" {
				wantClusterRoles[name] = true
			}
		}
	}
	if len(wantUIDs) == 0 && len(wantPVNames) == 0 && len(wantClusterRoles) == 0 && len(saKeys) == 0 {
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
	// First: owner UIDs, PVs, and the reverse ClusterRoleBinding scan. The scan feeds second-hop
	// ClusterRole names, so it must complete before ClusterRoles are resolved below — and resource
	// order here is arbitrary (the map-derived slice), so the two phases can't be merged.
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
		if r.Kind == "ClusterRoleBinding" && len(saKeys) > 0 {
			for _, obj := range idx.List() {
				u, ok := obj.(*unstructured.Unstructured)
				if !ok || !bindsServiceAccount(u, saKeys) {
					continue
				}
				add(u)
				if name := clusterRoleRefName(u); name != "" {
					wantClusterRoles[name] = true
				}
			}
		}
	}
	// Then resolve ClusterRoles named by a RoleBinding's roleRef or a rode-along ClusterRoleBinding's.
	if len(wantClusterRoles) > 0 {
		for _, r := range resources {
			if r.Namespaced || r.Kind != "ClusterRole" {
				continue
			}
			idx := r.Informer.GetIndexer()
			for name := range wantClusterRoles {
				if obj, exists, _ := idx.GetByKey(name); exists {
					add(obj)
				}
			}
		}
	}
	return out
}

// clusterRoleRefName returns the name of the ClusterRole a binding's roleRef targets, or "" if the
// roleRef is a namespaced Role. roleRef is a top-level field on both RoleBinding and
// ClusterRoleBinding; a ClusterRoleBinding's roleRef.kind is always ClusterRole, a RoleBinding's
// may be either.
func clusterRoleRefName(u *unstructured.Unstructured) string {
	if kind, _, _ := unstructured.NestedString(u.Object, "roleRef", "kind"); kind != "ClusterRole" {
		return ""
	}
	name, _, _ := unstructured.NestedString(u.Object, "roleRef", "name")
	return name
}

// bindsServiceAccount reports whether any of a binding's subjects is a ServiceAccount whose
// "namespace/name" is in saKeys. subjects is a top-level field on both binding kinds.
func bindsServiceAccount(u *unstructured.Unstructured, saKeys map[string]bool) bool {
	subjects, _, _ := unstructured.NestedSlice(u.Object, "subjects")
	for _, s := range subjects {
		m, ok := s.(map[string]any)
		if !ok {
			continue
		}
		if kind, _, _ := unstructured.NestedString(m, "kind"); kind != "ServiceAccount" {
			continue
		}
		sns, _, _ := unstructured.NestedString(m, "namespace")
		sname, _, _ := unstructured.NestedString(m, "name")
		if saKeys[sns+"/"+sname] {
			return true
		}
	}
	return false
}
