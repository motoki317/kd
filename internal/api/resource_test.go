package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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
