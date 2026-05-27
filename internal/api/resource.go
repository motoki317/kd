package api

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/motoki317/kd/internal/kube/graph"
)

// resourceClass maps a Kubernetes kind to the kd RBAC resource class checked in policy.csv.
func resourceClass(kind string) string {
	switch kind {
	case "Pod":
		return "pods"
	case "Node":
		return "nodes"
	case "Event":
		return "events"
	case "Namespace":
		return "namespaces"
	case "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding", "ServiceAccount":
		return "rbac"
	default:
		// Deployment, ReplicaSet, Service, Ingress, ConfigMap, Secret, PVC, ...
		return "workloads"
	}
}

// findResource locates a cached object by kind and name within a namespace snapshot.
func findResource(objs []runtime.Object, kind, name string) (runtime.Object, bool) {
	for _, obj := range objs {
		if graph.KindOf(obj) != kind {
			continue
		}
		m, err := meta.Accessor(obj)
		if err != nil {
			continue
		}
		if m.GetName() == name {
			return obj, true
		}
	}
	return nil, false
}

// presentable returns a copy of obj that is safe and tidy to expose in the detail view:
//   - Secret values are blanked (keys retained) so the broad read ServiceAccount never leaks
//     secret contents through kd (see docs/ADR/20260527-kubernetes-access-model.md).
//   - managedFields and the last-applied-configuration annotation are stripped — they are pure
//     API-server bookkeeping that otherwise dominates the manifest and bloats the payload.
func presentable(obj runtime.Object) runtime.Object {
	obj = obj.DeepCopyObject()
	if s, ok := obj.(*corev1.Secret); ok {
		for k := range s.Data {
			s.Data[k] = []byte{}
		}
		s.StringData = nil
	}
	if m, err := meta.Accessor(obj); err == nil {
		m.SetManagedFields(nil)
		if ann := m.GetAnnotations(); ann != nil {
			delete(ann, "kubectl.kubernetes.io/last-applied-configuration")
			if len(ann) == 0 {
				ann = nil
			}
			m.SetAnnotations(ann)
		}
	}
	return obj
}
