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

// redact returns a copy of obj safe to expose. Secret values are blanked (keys retained) so the
// broad read ServiceAccount never leaks secret contents through kd.
// See docs/ADR/20260527-kubernetes-access-model.md.
func redact(obj runtime.Object) runtime.Object {
	if s, ok := obj.(*corev1.Secret); ok {
		c := s.DeepCopy()
		for k := range c.Data {
			c.Data[k] = []byte{}
		}
		c.StringData = nil
		return c
	}
	return obj
}
