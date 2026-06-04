package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/motoki317/kd/internal/kube/graph"
)

// resourceClasses authorizes access: a kind maps to its legacy class plus (for a non-core group) the
// GVR group, and the enforcer allows if EITHER matches. Getting this wrong is a security issue —
// either locking out a legitimately-granted operator or widening access. Pin the contract.
func TestResourceClasses(t *testing.T) {
	eq := func(got, want []string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range want {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	cases := []struct {
		kind, group string
		want        []string
	}{
		{"Pod", "", []string{"pods"}},                                        // core group adds NO group class
		{"Node", "", []string{"nodes"}},                                      // (a "" group rule would mean "any")
		{"Deployment", "apps", []string{"workloads", "apps"}},                // legacy class + group
		{"Workflow", "argoproj.io", []string{"workloads", "argoproj.io"}},    // a CR: workloads fallback + its group
		{"Role", "rbac.authorization.k8s.io", []string{"rbac", "rbac.authorization.k8s.io"}},
	}
	for _, c := range cases {
		if got := resourceClasses(c.kind, c.group); !eq(got, c.want) {
			t.Errorf("resourceClasses(%q, %q) = %v, want %v", c.kind, c.group, got, c.want)
		}
	}
}

func TestLegacyClass(t *testing.T) {
	cases := map[string]string{
		"Pod": "pods", "Node": "nodes", "Event": "events", "Namespace": "namespaces",
		"Role": "rbac", "RoleBinding": "rbac", "ClusterRole": "rbac",
		"ClusterRoleBinding": "rbac", "ServiceAccount": "rbac",
		"Deployment": "workloads", "Secret": "workloads", "Workflow": "workloads", // default bucket
	}
	for kind, want := range cases {
		if got := legacyClass(kind); got != want {
			t.Errorf("legacyClass(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestFindResource(t *testing.T) {
	objs := []runtime.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}}, // same name, different kind
	}
	// Kind AND name must both match — a Pod and a Service named "web" must not collide.
	if obj, ok := findResource(objs, "Service", "web"); !ok {
		t.Error("findResource(Service, web) should find the Service")
	} else if graph.KindOf(obj) != "Service" {
		t.Errorf("findResource returned a %s, want Service", graph.KindOf(obj))
	}
	if _, ok := findResource(objs, "Pod", "absent"); ok {
		t.Error("findResource(Pod, absent) should be (_, false)")
	}
}

func TestPresentableStripsBookkeepingAndSecrets(t *testing.T) {
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "p",
			Annotations: map[string]string{"kubectl.kubernetes.io/last-applied-configuration": "{...}", "keep": "yes"},
			ManagedFields: []metav1.ManagedFieldsEntry{
				{Manager: "kube-controller-manager"},
			},
		},
	}
	got := presentable(pod).(*corev1.Pod)

	if len(got.ManagedFields) != 0 {
		t.Error("managedFields should be stripped")
	}
	if _, ok := got.Annotations["kubectl.kubernetes.io/last-applied-configuration"]; ok {
		t.Error("last-applied-configuration annotation should be stripped")
	}
	if got.Annotations["keep"] != "yes" {
		t.Error("other annotations should be retained")
	}
	if len(pod.ManagedFields) == 0 {
		t.Error("presentable must not mutate the cached original")
	}
}

func TestPresentableBlanksSecretValues(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "s"},
		Data:       map[string][]byte{"token": []byte("super-secret")},
	}
	got := presentable(secret).(*corev1.Secret)

	if len(got.Data["token"]) != 0 {
		t.Error("secret value should be blanked")
	}
	if _, ok := got.Data["token"]; !ok {
		t.Error("secret key should be retained")
	}
	if string(secret.Data["token"]) != "super-secret" {
		t.Error("presentable must not mutate the cached original secret")
	}
}

func TestPresentableStampsGVK(t *testing.T) {
	// Objects from the informer lister carry empty TypeMeta, so a served manifest would omit
	// apiVersion/kind and not apply. presentable must recover and stamp the GVK back.
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web"}}
	gvk := presentable(dep).GetObjectKind().GroupVersionKind()
	if gvk.Kind != "Deployment" || gvk.GroupVersion().String() != "apps/v1" {
		t.Errorf("GVK = %q/%q, want apps/v1/Deployment", gvk.GroupVersion().String(), gvk.Kind)
	}
}

func TestWriteManifestFormats(t *testing.T) {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "settings", Namespace: "shop"},
		Data:       map[string]string{"key": "value"},
	}

	t.Run("default is YAML", func(t *testing.T) {
		w := httptest.NewRecorder()
		writeManifest(w, cm, "")
		if ct := w.Header().Get("Content-Type"); ct != "application/yaml" {
			t.Errorf("Content-Type = %q, want application/yaml", ct)
		}
		body := w.Body.String()
		if !strings.Contains(body, "name: settings") || !strings.Contains(body, "key: value") {
			t.Errorf("YAML body missing expected fields:\n%s", body)
		}
		if strings.Contains(body, "{") {
			t.Errorf("YAML body should not contain JSON braces:\n%s", body)
		}
	})

	t.Run("json is opt-in and indented", func(t *testing.T) {
		w := httptest.NewRecorder()
		writeManifest(w, cm, "json")
		if ct := w.Header().Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		body := w.Body.String()
		if !strings.Contains(body, `"name": "settings"`) {
			t.Errorf("JSON body missing expected fields:\n%s", body)
		}
		if !strings.Contains(body, "\n  ") {
			t.Errorf("JSON body should be indented:\n%s", body)
		}
	})
}
