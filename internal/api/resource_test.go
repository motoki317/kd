package api

import (
	"testing"

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
