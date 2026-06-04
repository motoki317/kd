package graph

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// KindOf/GVKOf recover an object's kind+apiVersion from the Go type when TypeMeta is empty — the
// shape every object has coming off an informer lister. These power the manifest handler (stamping
// apiVersion/kind back onto served YAML) and cross-package classification, so the per-type mapping
// must be exact across groups (core, apps, batch, networking, rbac).
func TestKindOfGVKOfFromGoType(t *testing.T) {
	cases := []struct {
		obj          runtime.Object
		kind, apiVer string
	}{
		{&corev1.Pod{}, "Pod", "v1"},
		{&corev1.Service{}, "Service", "v1"},
		{&corev1.Node{}, "Node", "v1"},
		{&corev1.Namespace{}, "Namespace", "v1"},
		{&corev1.ConfigMap{}, "ConfigMap", "v1"},
		{&corev1.Secret{}, "Secret", "v1"},
		{&corev1.PersistentVolumeClaim{}, "PersistentVolumeClaim", "v1"},
		{&corev1.PersistentVolume{}, "PersistentVolume", "v1"},
		{&corev1.ServiceAccount{}, "ServiceAccount", "v1"},
		{&corev1.Endpoints{}, "Endpoints", "v1"},
		{&corev1.Event{}, "Event", "v1"},
		{&appsv1.Deployment{}, "Deployment", "apps/v1"},
		{&appsv1.ReplicaSet{}, "ReplicaSet", "apps/v1"},
		{&appsv1.StatefulSet{}, "StatefulSet", "apps/v1"},
		{&appsv1.DaemonSet{}, "DaemonSet", "apps/v1"},
		{&batchv1.Job{}, "Job", "batch/v1"},
		{&batchv1.CronJob{}, "CronJob", "batch/v1"},
		{&networkingv1.Ingress{}, "Ingress", "networking.k8s.io/v1"},
		{&rbacv1.Role{}, "Role", "rbac.authorization.k8s.io/v1"},
		{&rbacv1.RoleBinding{}, "RoleBinding", "rbac.authorization.k8s.io/v1"},
		{&rbacv1.ClusterRole{}, "ClusterRole", "rbac.authorization.k8s.io/v1"},
		{&rbacv1.ClusterRoleBinding{}, "ClusterRoleBinding", "rbac.authorization.k8s.io/v1"},
	}
	for _, c := range cases {
		if got := KindOf(c.obj); got != c.kind {
			t.Errorf("KindOf(%T) = %q, want %q", c.obj, got, c.kind)
		}
		av, k := GVKOf(c.obj)
		if av != c.apiVer || k != c.kind {
			t.Errorf("GVKOf(%T) = (%q, %q), want (%q, %q)", c.obj, av, k, c.apiVer, c.kind)
		}
	}
}

// When TypeMeta IS populated (a decoded fixture or an explicitly-stamped object), it wins over the
// Go-type fallback — so a kind kd has no case for still classifies correctly.
func TestKindOfPrefersTypeMeta(t *testing.T) {
	// A type with no kindFromType case, but carrying TypeMeta, must report from TypeMeta.
	lease := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "coordination.k8s.io/v1", "kind": "Lease",
		"metadata": map[string]any{"name": "l", "namespace": "kube-system"},
	}}
	if got := KindOf(lease); got != "Lease" {
		t.Errorf("KindOf(unstructured Lease) = %q, want Lease", got)
	}
	av, k := GVKOf(lease)
	if av != "coordination.k8s.io/v1" || k != "Lease" {
		t.Errorf("GVKOf(unstructured Lease) = (%q, %q), want (coordination.k8s.io/v1, Lease)", av, k)
	}

	// A typed object with TypeMeta explicitly set uses it verbatim too.
	pod := &corev1.Pod{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"}}
	if got := KindOf(pod); got != "Pod" {
		t.Errorf("KindOf(typed Pod w/ TypeMeta) = %q, want Pod", got)
	}
}

// A type kd has no mapping for and no TypeMeta yields an empty kind — describe()'s ok=false path,
// which Build uses to skip an unclassifiable object rather than emit a kind-less node.
func TestKindOfUnknownType(t *testing.T) {
	if got := KindOf(&corev1.Binding{}); got != "" {
		t.Errorf("KindOf(unmapped, TypeMeta-less *corev1.Binding) = %q, want \"\"", got)
	}
}
