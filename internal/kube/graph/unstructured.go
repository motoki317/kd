package graph

import (
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// This file is the boundary between the dynamic-informer store (which yields
// *unstructured.Unstructured for every object, CR or not) and the rest of the graph
// package's typed per-kind logic (health rules, edge inferrers, spec renderers).
//
// For the kinds kd has dedicated logic for, we convert unstructured → the matching typed
// struct once at the top of Build, so downstream code sees the same typed objects it would
// from a YAML fixture or a typed clientset's lister. Unknown kinds (CRs without bespoke
// rules) stay unstructured and flow through the CR-specific paths (CR health heuristic,
// CR-defined edge inferrer).

// typedFactories enumerates every kind the graph package has typed per-kind logic for, mapped
// to a factory that returns a fresh empty value of that type. The kind/apiVersion key is the
// stringified GVK as kd already exposes via describe().
var typedFactories = map[string]func() runtime.Object{
	"v1/Pod":                                   func() runtime.Object { return &corev1.Pod{} },
	"v1/Service":                               func() runtime.Object { return &corev1.Service{} },
	"v1/Node":                                  func() runtime.Object { return &corev1.Node{} },
	"v1/Namespace":                             func() runtime.Object { return &corev1.Namespace{} },
	"v1/ConfigMap":                             func() runtime.Object { return &corev1.ConfigMap{} },
	"v1/Secret":                                func() runtime.Object { return &corev1.Secret{} },
	"v1/PersistentVolumeClaim":                 func() runtime.Object { return &corev1.PersistentVolumeClaim{} },
	"v1/PersistentVolume":                      func() runtime.Object { return &corev1.PersistentVolume{} },
	"v1/ServiceAccount":                        func() runtime.Object { return &corev1.ServiceAccount{} },
	"v1/Endpoints":                             func() runtime.Object { return &corev1.Endpoints{} },
	"v1/Event":                                 func() runtime.Object { return &corev1.Event{} },
	"apps/v1/Deployment":                       func() runtime.Object { return &appsv1.Deployment{} },
	"apps/v1/ReplicaSet":                       func() runtime.Object { return &appsv1.ReplicaSet{} },
	"apps/v1/StatefulSet":                      func() runtime.Object { return &appsv1.StatefulSet{} },
	"apps/v1/DaemonSet":                        func() runtime.Object { return &appsv1.DaemonSet{} },
	"batch/v1/Job":                             func() runtime.Object { return &batchv1.Job{} },
	"batch/v1/CronJob":                         func() runtime.Object { return &batchv1.CronJob{} },
	"policy/v1/PodDisruptionBudget":            func() runtime.Object { return &policyv1.PodDisruptionBudget{} },
	"networking.k8s.io/v1/Ingress":             func() runtime.Object { return &networkingv1.Ingress{} },
	"networking.k8s.io/v1/NetworkPolicy":       func() runtime.Object { return &networkingv1.NetworkPolicy{} },
	"rbac.authorization.k8s.io/v1/Role":        func() runtime.Object { return &rbacv1.Role{} },
	"rbac.authorization.k8s.io/v1/RoleBinding": func() runtime.Object { return &rbacv1.RoleBinding{} },
	"rbac.authorization.k8s.io/v1/ClusterRole": func() runtime.Object { return &rbacv1.ClusterRole{} },
	"rbac.authorization.k8s.io/v1/ClusterRoleBinding": func() runtime.Object { return &rbacv1.ClusterRoleBinding{} },
}

// AsTyped converts a runtime.Object to its typed-struct form when the object is
// *unstructured.Unstructured AND the GVK matches a kind in typedFactories. Already-typed
// objects pass through unchanged. CRs (unknown GVK) also pass through as unstructured for
// the CR-specific code paths to handle. Exported for API handlers that iterate snapshots
// directly (events, logs) instead of going through Build.
func AsTyped(obj runtime.Object) runtime.Object { return toTyped(obj) }

// AsTypedSlice converts each entry of objs via AsTyped, returning a new slice so the input
// isn't mutated. Returns nil for nil input.
func AsTypedSlice(objs []runtime.Object) []runtime.Object {
	if objs == nil {
		return nil
	}
	out := make([]runtime.Object, len(objs))
	for i, o := range objs {
		out[i] = AsTyped(o)
	}
	return out
}

// gvkKey is the string form used as the typedFactories map key. Centralized so the format
// is defined once and changes (e.g. switching to a different separator) only happen here.
func gvkKey(gvk schema.GroupVersionKind) string {
	return gvk.GroupVersion().String() + "/" + gvk.Kind
}

// toTyped is the unexported worker. See AsTyped.
func toTyped(obj runtime.Object) runtime.Object {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj
	}
	factory, known := typedFactories[gvkKey(u.GroupVersionKind())]
	if !known {
		return obj // CR or kind kd doesn't have typed logic for; keep as unstructured
	}
	dst := factory()
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, dst); err != nil {
		// Conversion failures are rare (malformed object); fall back to unstructured so
		// the graph at least still has a node for this object.
		return obj
	}
	// FromUnstructured doesn't always populate TypeMeta on the typed struct (api machinery
	// chooses), but describe() falls back to kindFromType so kind/apiVersion still come
	// out right downstream.
	return dst
}

// IsUnstructuredCR reports whether obj is an unstructured object kd has no dedicated typed
// logic for — i.e. a custom resource. Used by build.go to dispatch to the CR-specific
// health heuristic and edge inferrer.
func IsUnstructuredCR(obj runtime.Object) bool {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return false
	}
	_, known := typedFactories[gvkKey(u.GroupVersionKind())]
	return !known
}
