package graph

import (
	"strings"
	"testing"
	"time"

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

// creationTime renders the RFC3339 UTC age stamp, empty when unset; nodeID prefers the object UID
// and falls back to a stable synthetic kind/ns/name so an object missing its UID still gets a
// deterministic id (no collisions, survives across snapshots).
func TestCreationTimeAndNodeID(t *testing.T) {
	if got := creationTime(&corev1.Pod{}); got != "" {
		t.Errorf("creationTime(unset) = %q, want empty", got)
	}
	withTime := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{CreationTimestamp: metav1.Date(2026, 6, 5, 12, 30, 0, 0, time.UTC)}}
	if got := creationTime(withTime); got != "2026-06-05T12:30:00Z" {
		t.Errorf("creationTime = %q, want 2026-06-05T12:30:00Z", got)
	}

	withUID := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{UID: "abc-123"}}
	if got := nodeID("Pod", withUID); got != "abc-123" {
		t.Errorf("nodeID(uid) = %q, want abc-123", got)
	}
	noUID := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web"}}
	if got := nodeID("Pod", noUID); got != "Pod/shop/web" {
		t.Errorf("nodeID(no uid) = %q, want Pod/shop/web", got)
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

func TestBuildMarksLoggableFloorKinds(t *testing.T) {
	floor := []struct {
		apiVersion string
		kind       string
	}{
		{"v1", "Pod"},
		{"v1", "ReplicationController"},
		{"apps/v1", "ReplicaSet"},
		{"apps/v1", "Deployment"},
		{"apps/v1", "StatefulSet"},
		{"apps/v1", "DaemonSet"},
		{"batch/v1", "Job"},
		{"batch/v1", "CronJob"},
		{"argoproj.io/v1alpha1", "Workflow"},
		{"argoproj.io/v1alpha1", "CronWorkflow"},
	}

	objs := make([]runtime.Object, 0, len(floor)+1)
	for _, item := range floor {
		objs = append(objs, &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": item.apiVersion,
			"kind":       item.kind,
			"metadata": map[string]any{
				"name":      strings.ToLower(item.kind),
				"namespace": "team-a",
				"uid":       strings.ToLower(item.kind) + "-uid",
			},
		}})
	}
	objs = append(objs, &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.io/v1",
		"kind":       "PipelineRun",
		"metadata": map[string]any{
			"name": "build-a", "namespace": "team-a", "uid": "build-a-uid",
		},
	}})

	g := Build(objs)
	for _, item := range floor {
		n := nodeByName(g, item.kind, strings.ToLower(item.kind))
		if n == nil || !n.Loggable {
			t.Errorf("%s with no pods must be loggable, got %+v", item.kind, n)
		}
	}
	if n := nodeByName(g, "PipelineRun", "build-a"); n == nil || n.Loggable {
		t.Errorf("non-floor kind with no source pods must not be loggable, got %+v", n)
	}
	typed := Build([]runtime.Object{&corev1.ReplicationController{ObjectMeta: metav1.ObjectMeta{
		Name: "legacy-a", Namespace: "team-a", UID: "legacy-a-uid",
	}}})
	if n := nodeByName(typed, "ReplicationController", "legacy-a"); n == nil || !n.Loggable {
		t.Errorf("typed ReplicationController with no pods must be retained and loggable, got %+v", n)
	}
}

func TestBuildWithLogSourcesMarksOwnerWithoutDisplayingSource(t *testing.T) {
	display := decodeFixture(t, `
apiVersion: v1
kind: Node
metadata: { name: node-a, uid: node-a-uid }
---
apiVersion: v1
kind: Node
metadata: { name: node-b, uid: node-b-uid }
`)
	sources := decodeFixture(t, `
apiVersion: v1
kind: Pod
metadata:
  name: agent-a
  namespace: team-a
  uid: agent-a-uid
  ownerReferences:
    - { apiVersion: v1, kind: Node, name: node-a, uid: node-a-uid, controller: true }
status: { phase: Running }
`)

	g := BuildWithLogSources(display, sources)
	if n := nodeByName(g, "Node", "node-a"); n == nil || !n.Loggable {
		t.Errorf("Node owning an authorized source pod must be loggable, got %+v", n)
	}
	if n := nodeByName(g, "Node", "node-b"); n == nil || n.Loggable {
		t.Errorf("Node without a source pod must not be loggable, got %+v", n)
	}
	if n := nodeByName(g, "Pod", "agent-a"); n != nil {
		t.Errorf("source pod must not enter the displayed graph, got %+v", n)
	}
	if n := nodeByName(Build(display), "Node", "node-a"); n == nil || n.Loggable {
		t.Errorf("plain Build must apply floor-only marking, got %+v", n)
	}
}

func TestLoggableUIDsWalksCompletedWorkflowChainFromUnstructuredPod(t *testing.T) {
	cron := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow",
		"metadata": map[string]any{"name": "nightly", "namespace": "team-a", "uid": "cron-uid"},
	}}
	workflow := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
		"metadata": map[string]any{
			"name": "nightly-a", "namespace": "team-a", "uid": "workflow-uid",
			"ownerReferences": []any{map[string]any{
				"apiVersion": "argoproj.io/v1alpha1", "kind": "CronWorkflow",
				"name": "nightly", "uid": "cron-uid", "controller": true,
			}},
		},
	}}
	unrelated := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.io/v1", "kind": "PipelineRun",
		"metadata": map[string]any{"name": "build-b", "namespace": "team-a", "uid": "unrelated-uid"},
	}}
	pod := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{
			"name": "nightly-a-step", "namespace": "team-a", "uid": "pod-uid",
			"ownerReferences": []any{map[string]any{
				"apiVersion": "argoproj.io/v1alpha1", "kind": "Workflow",
				"name": "nightly-a", "uid": "workflow-uid", "controller": true,
			}},
		},
		"status": map[string]any{"phase": "Succeeded"},
	}}

	got := loggableUIDs([]runtime.Object{cron, workflow, unrelated}, []runtime.Object{pod})
	for _, uid := range []string{"pod-uid", "workflow-uid", "cron-uid"} {
		if !got[uid] {
			t.Errorf("completed Workflow chain UID %q must be marked, got %v", uid, got)
		}
	}
	if got["unrelated-uid"] {
		t.Errorf("unrelated CRD must remain unmarked, got %v", got)
	}
}

func TestLoggableUIDsStopsAtSupersededReplicaSet(t *testing.T) {
	objs := decodeFixture(t, `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api-a, namespace: team-a, uid: deployment-uid }
---
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: api-a-old
  namespace: team-a
  uid: replicaset-uid
  ownerReferences:
    - { apiVersion: apps/v1, kind: Deployment, name: api-a, uid: deployment-uid, controller: true }
spec: { replicas: 0 }
status: { replicas: 0 }
---
apiVersion: v1
kind: Pod
metadata:
  name: api-a-old-pod
  namespace: team-a
  uid: pod-uid
  ownerReferences:
    - { apiVersion: apps/v1, kind: ReplicaSet, name: api-a-old, uid: replicaset-uid, controller: true }
status: { phase: Succeeded }
`)

	got := loggableUIDs(objs, objs[2:])
	if !got["pod-uid"] {
		t.Errorf("source pod must be marked, got %v", got)
	}
	for _, uid := range []string{"replicaset-uid", "deployment-uid"} {
		if got[uid] {
			t.Errorf("BuildForLogs-excluded owner %q must not be marked, got %v", uid, got)
		}
	}
}
