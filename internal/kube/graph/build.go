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
//
// Input objects may be typed (corev1.Pod, …) or *unstructured.Unstructured (the shape the
// dynamic-informer store yields). Known kinds are converted to their typed struct at the
// entry boundary so per-kind logic (health rules, edge inferrers) keeps working as-is;
// unknown kinds (custom resources) stay unstructured and flow through the CR-specific paths.
func Build(objs []runtime.Object) *Graph {
	// Non-nil Nodes so an empty graph marshals `"nodes":[]`, not `null` (Edges is guarded after
	// buildEdges below, which reassigns it).
	g := &Graph{Nodes: []Node{}}
	objs = slices.Clone(objs)
	for i, o := range objs {
		objs[i] = toTyped(o)
	}
	objs = slices.DeleteFunc(objs, isHistorical)
	for _, obj := range objs {
		kind, apiVersion, m, ok := describe(obj)
		if !ok {
			continue
		}
		h := health(obj)
		node := Node{
			ID:                nodeID(kind, m),
			Kind:              kind,
			APIVersion:        apiVersion,
			Namespace:         m.GetNamespace(),
			Name:              m.GetName(),
			Labels:            m.GetLabels(),
			Health:            h,
			Status:            statusSummary(obj),
			Message:           statusMessage(obj, h),
			CreatedAt:         creationTime(m),
			Restarts:          podRestarts(obj),
			Containers:        containerNames(obj),
			Images:            containerImages(obj),
			Host:              podHost(obj),
			Capacity:          nodeCapacity(obj),
			Allocatable:       nodeAllocatable(obj),
			CapacityRes:       nodeTotalCapacity(obj),
			Requests:          podRequests(obj),
			Limits:            podLimits(obj),
			ClusterIP:         serviceClusterIP(obj),
			ExternalIP:        serviceExternalAddress(obj),
			Ports:             servicePorts(obj),
			Routes:            routes(obj),
			Rules:             roleRules(obj),
			RoleRef:           bindingRoleRef(obj),
			Subjects:          bindingSubjects(obj),
			DataKeys:          dataKeys(obj),
			SecretType:        secretType(obj),
			AccessModes:       accessModes(obj),
			StorageClass:      storageClass(obj),
			LastRun:           cronLastRun(obj),
			Active:            batchActive(obj),
			Failed:            batchFailed(obj),
			ContainerStatuses: containerStatuses(obj),
		}
		for _, or := range m.GetOwnerReferences() {
			node.OwnerUIDs = append(node.OwnerUIDs, string(or.UID))
		}
		g.Nodes = append(g.Nodes, node)
	}

	var endpoints map[string]*Endpoints
	g.Edges, endpoints = buildEdges(g.Nodes, objs, newIndex(g.Nodes))
	// buildEdges returns a nil slice when nothing relates (a namespace of standalone resources — only
	// a ConfigMap + ServiceAccount, say). A nil slice marshals as JSON `null`, which the client's
	// snapshot reducer (`[...g.edges]`) threw on, hanging the whole namespace on "connecting…" forever.
	// `edges` is non-optional in the wire contract, so force `[]`.
	if g.Edges == nil {
		g.Edges = []Edge{}
	}
	annotateServiceEndpoints(g.Nodes, endpoints)
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

// GVKOf returns an object's apiVersion and kind, recovered from the Go type when it came from an
// informer lister (whose TypeMeta is empty). Lets a caller stamp the GVK back onto a manifest so the
// served YAML/JSON carries apiVersion/kind and applies cleanly.
func GVKOf(obj runtime.Object) (apiVersion, kind string) {
	k, av, _, _ := describe(obj)
	return av, k
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
	case *corev1.PersistentVolume:
		return "PersistentVolume", "v1"
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
