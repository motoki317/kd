package graph

import (
	"cmp"
	"slices"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// Build assembles the relationship graph from a snapshot of Kubernetes objects. It is pure:
// the same input always yields the same graph, with nodes and edges in a deterministic order.
func Build(objs []runtime.Object) *Graph {
	g := &Graph{}
	objs = slices.DeleteFunc(slices.Clone(objs), isHistorical)
	for _, obj := range objs {
		kind, apiVersion, m, ok := describe(obj)
		if !ok {
			continue
		}
		node := Node{
			ID:                nodeID(kind, m),
			Kind:              kind,
			APIVersion:        apiVersion,
			Namespace:         m.GetNamespace(),
			Name:              m.GetName(),
			Labels:            m.GetLabels(),
			Health:            health(obj),
			Status:            statusSummary(obj),
			CreatedAt:         creationTime(m),
			Restarts:          podRestarts(obj),
			Containers:        containerNames(obj),
			Images:            containerImages(obj),
			Host:              podHost(obj),
			Capacity:          nodeCapacity(obj),
			ClusterIP:         serviceClusterIP(obj),
			Ports:             servicePorts(obj),
			ContainerStatuses: containerStatuses(obj),
		}
		for _, or := range m.GetOwnerReferences() {
			node.OwnerUIDs = append(node.OwnerUIDs, string(or.UID))
		}
		g.Nodes = append(g.Nodes, node)
	}

	g.Edges = buildEdges(g.Nodes, objs, newIndex(g.Nodes))
	sortGraph(g)
	return g
}

// isHistorical reports whether an object is finished/superseded clutter that the topology drops
// unconditionally (rather than behind a toggle), because it dominates real namespaces and never
// reflects current state:
//   - ReplicaSets scaled to zero with no pods (Deployment revision history, ~10 kept by default).
//   - Pods that ran to completion under a controller (Job/CronJob/Workflow leftovers). Failed pods
//     are kept (they are actionable) and ownerless succeeded pods are kept (someone ran them).
func isHistorical(obj runtime.Object) bool {
	switch o := obj.(type) {
	case *appsv1.ReplicaSet:
		desiredZero := o.Spec.Replicas != nil && *o.Spec.Replicas == 0
		return desiredZero && o.Status.Replicas == 0 && metav1.GetControllerOf(&o.ObjectMeta) != nil
	case *corev1.Pod:
		return o.Status.Phase == corev1.PodSucceeded && metav1.GetControllerOf(&o.ObjectMeta) != nil
	default:
		return false
	}
}

// KindOf returns an object's Kubernetes kind, recovered from TypeMeta or the Go type. It lets
// other packages classify cache objects (whose TypeMeta is empty) without duplicating the map.
func KindOf(obj runtime.Object) string {
	kind, _, _, _ := describe(obj)
	return kind
}

// creationTime renders an object's creation timestamp as RFC3339, or "" when unset (e.g. fixtures),
// so the client can show a relative age.
func creationTime(m metav1.Object) string {
	t := m.GetCreationTimestamp()
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// nodeID is the object UID, falling back to a stable synthetic id when UID is absent.
func nodeID(kind string, m metav1.Object) string {
	if uid := string(m.GetUID()); uid != "" {
		return uid
	}
	return kind + "/" + m.GetNamespace() + "/" + m.GetName()
}

// describe extracts the kind, apiVersion, and metadata accessor for an object. Kind/apiVersion
// come from TypeMeta when set (e.g. decoded fixtures) and fall back to the Go type otherwise
// (e.g. objects from informer listers, whose TypeMeta is empty).
func describe(obj runtime.Object) (kind, apiVersion string, m metav1.Object, ok bool) {
	m, err := meta.Accessor(obj)
	if err != nil {
		return "", "", nil, false
	}
	gvk := obj.GetObjectKind().GroupVersionKind()
	kind, apiVersion = gvk.Kind, gvk.GroupVersion().String()
	if kind == "" {
		kind, apiVersion = kindFromType(obj)
	}
	return kind, apiVersion, m, kind != ""
}

// kindFromType recovers kind/apiVersion from the concrete Go type when TypeMeta is empty.
func kindFromType(obj runtime.Object) (kind, apiVersion string) {
	switch obj.(type) {
	case *corev1.Pod:
		return "Pod", "v1"
	case *corev1.Service:
		return "Service", "v1"
	case *corev1.Node:
		return "Node", "v1"
	case *corev1.Namespace:
		return "Namespace", "v1"
	case *corev1.ConfigMap:
		return "ConfigMap", "v1"
	case *corev1.Secret:
		return "Secret", "v1"
	case *corev1.PersistentVolumeClaim:
		return "PersistentVolumeClaim", "v1"
	case *corev1.ServiceAccount:
		return "ServiceAccount", "v1"
	case *corev1.Endpoints:
		return "Endpoints", "v1"
	case *corev1.Event:
		return "Event", "v1"
	case *appsv1.Deployment:
		return "Deployment", "apps/v1"
	case *appsv1.ReplicaSet:
		return "ReplicaSet", "apps/v1"
	case *appsv1.StatefulSet:
		return "StatefulSet", "apps/v1"
	case *appsv1.DaemonSet:
		return "DaemonSet", "apps/v1"
	case *batchv1.Job:
		return "Job", "batch/v1"
	case *batchv1.CronJob:
		return "CronJob", "batch/v1"
	case *networkingv1.Ingress:
		return "Ingress", "networking.k8s.io/v1"
	case *rbacv1.Role:
		return "Role", "rbac.authorization.k8s.io/v1"
	case *rbacv1.RoleBinding:
		return "RoleBinding", "rbac.authorization.k8s.io/v1"
	case *rbacv1.ClusterRole:
		return "ClusterRole", "rbac.authorization.k8s.io/v1"
	case *rbacv1.ClusterRoleBinding:
		return "ClusterRoleBinding", "rbac.authorization.k8s.io/v1"
	default:
		return "", ""
	}
}

// sortGraph orders nodes by (kind, namespace, name, id) and edges by (type, from, to) so the
// builder's output is stable and assertions/diffs are deterministic.
func sortGraph(g *Graph) {
	slices.SortFunc(g.Nodes, func(a, b Node) int {
		return cmp.Or(
			cmp.Compare(a.Kind, b.Kind),
			cmp.Compare(a.Namespace, b.Namespace),
			cmp.Compare(a.Name, b.Name),
			cmp.Compare(a.ID, b.ID),
		)
	})
	slices.SortFunc(g.Edges, func(a, b Edge) int {
		return cmp.Or(
			cmp.Compare(string(a.Type), string(b.Type)),
			cmp.Compare(a.From, b.From),
			cmp.Compare(a.To, b.To),
		)
	})
}
