package api

import (
	"encoding/json"
	"net/http"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"

	"github.com/motoki317/kd/internal/kube/graph"
)

// resourceClasses maps a Kubernetes kind to the kd RBAC resource classes that authorize
// access to it. v1 returns both the legacy class name (pods/nodes/workloads/…) AND the
// GVR group (core="" / apps / argoproj.io / …) when the group is known: the enforcer
// allows access if EITHER class matches. This keeps existing policy.csv files working
// (legacy classes are still authoritative) while enabling group-targeted rules for CRs
// — `p, alice, *, argoproj.io, *, allow` lets an operator authorize every CR in that group
// without enumerating each kind.
func resourceClasses(kind, group string) []string {
	classes := []string{legacyClass(kind)}
	// "" (core group) is intentionally NOT added as a separate class: a rule like
	// `p, alice, *, "", *` would otherwise be indistinguishable from "any resource". Core
	// kinds rely on their legacy class; non-core groups layer on as an additional grant.
	if group != "" {
		classes = append(classes, group)
	}
	return classes
}

// legacyClass is the pre-CRD kind→class mapping kept as-is so existing policy.csv files
// continue to work. New kinds (CRs) fall into "workloads" if they aren't matched by their
// GVR group rule either.
func legacyClass(kind string) string {
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
//
// Accepts either a typed object (e.g. *corev1.Secret from a fixture) or an
// *unstructured.Unstructured (what the dynamic-informer store yields). Secret blanking is
// dispatched by GVK string so it covers both shapes uniformly.
func presentable(obj runtime.Object) runtime.Object {
	obj = obj.DeepCopyObject()
	// Informer-listed typed objects have empty TypeMeta, so the manifest would omit
	// apiVersion/kind and not apply. Stamp the GVK back (recovered from the Go type) when
	// it's missing. Unstructured always has TypeMeta set, so this is a no-op for them.
	if obj.GetObjectKind().GroupVersionKind().Empty() {
		apiVersion, kind := graph.GVKOf(obj)
		obj.GetObjectKind().SetGroupVersionKind(schema.FromAPIVersionAndKind(apiVersion, kind))
	}
	gvk := obj.GetObjectKind().GroupVersionKind()
	if isSecret(gvk) {
		blankSecret(obj)
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

// isSecret matches the core/v1 Secret GVK ("Secret" in the core group, any version) so the
// blanking path triggers regardless of whether the object came in as typed or unstructured.
func isSecret(gvk schema.GroupVersionKind) bool {
	return gvk.Group == "" && gvk.Kind == "Secret"
}

// blankSecret zeros out a Secret's data values while keeping the keys (so the manifest still
// shows what's in it). Handles both typed *corev1.Secret and *unstructured.Unstructured.
func blankSecret(obj runtime.Object) {
	if s, ok := obj.(*corev1.Secret); ok {
		for k := range s.Data {
			s.Data[k] = []byte{}
		}
		s.StringData = nil
		return
	}
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return
	}
	if data, found, _ := unstructured.NestedMap(u.Object, "data"); found {
		blanked := make(map[string]any, len(data))
		for k := range data {
			blanked[k] = ""
		}
		_ = unstructured.SetNestedMap(u.Object, blanked, "data")
	}
	unstructured.RemoveNestedField(u.Object, "stringData")
}

// writeManifest renders a resource as YAML (default) or JSON. YAML is the default because it is
// what operators read by default (`kubectl get -o yaml`); JSON stays available for tooling. Both
// go through the object's json tags, so the two views describe the same fields.
func writeManifest(w http.ResponseWriter, obj runtime.Object, format string) {
	var (
		body []byte
		err  error
		ct   string
	)
	if format == "json" {
		ct = "application/json"
		body, err = json.MarshalIndent(obj, "", "  ")
	} else {
		ct = "application/yaml"
		body, err = yaml.Marshal(obj)
	}
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(body)
}
