package graph

// Storage and data-holding essence — PVC/PV access modes and classes, StorageClass parameters,
// ConfigMap/Secret data keys (names + sizes only, NEVER values), and ResourceQuota headroom.

import (
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// dataKeys lists a ConfigMap's or Secret's data keys as "key · size" rows, sorted (nil for other
// kinds), so the drawer answers "what does this hold?" without opening the manifest — the same
// declarative-essence surfacing routes/rules give an Ingress/Role. Only key NAMES and byte sizes are
// emitted, NEVER values: for a Secret the values are sensitive, and a name+size list is strictly less
// than the (RBAC-gated) Manifest tab already reveals. ConfigMap binaryData is included alongside data.
func dataKeys(obj runtime.Object) []string {
	sizes := map[string]int{}
	switch o := obj.(type) {
	case *corev1.ConfigMap:
		for k, v := range o.Data {
			sizes[k] = len(v)
		}
		for k, v := range o.BinaryData {
			sizes[k] = len(v)
		}
	case *corev1.Secret:
		for k, v := range o.Data {
			sizes[k] = len(v) // already-decoded bytes; we surface the length, not the content
		}
		for k, v := range o.StringData {
			sizes[k] = len(v)
		}
	default:
		return nil
	}
	if len(sizes) == 0 {
		return nil
	}
	keys := make([]string, 0, len(sizes))
	for k := range sizes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = k + " · " + humanizeBytes(int64(sizes[k]))
	}
	return out
}

// quotaUsage rolls a ResourceQuota's per-resource consumption into "resource · used / hard" rows —
// the only fact an operator wants from a quota (how much room is left), which the manifest splits
// across status.used and status.hard. Falls back to spec.hard when the controller hasn't filled
// status yet; a resource absent from used genuinely means zero tracked consumption.
func quotaUsage(obj runtime.Object) []string {
	q, ok := obj.(*corev1.ResourceQuota)
	if !ok {
		return nil
	}
	hard := q.Status.Hard
	if len(hard) == 0 {
		hard = q.Spec.Hard
	}
	if len(hard) == 0 {
		return nil
	}
	names := make([]string, 0, len(hard))
	for name := range hard {
		names = append(names, string(name))
	}
	sort.Strings(names)
	out := make([]string, len(names))
	for i, name := range names {
		used := "0"
		if u, ok := q.Status.Used[corev1.ResourceName(name)]; ok {
			used = u.String()
		}
		h := hard[corev1.ResourceName(name)]
		out[i] = name + " · " + used + " / " + h.String()
	}
	return out
}

// accessModeShort abbreviates a PVC/PV access mode to the form operators read in `kubectl get pvc`
// (RWO/ROX/RWX/RWOP), so the drawer answers "can more than one pod mount this?" at a glance.
func accessModeShort(m corev1.PersistentVolumeAccessMode) string {
	switch m {
	case corev1.ReadWriteOnce:
		return "RWO"
	case corev1.ReadOnlyMany:
		return "ROX"
	case corev1.ReadWriteMany:
		return "RWX"
	case corev1.ReadWriteOncePod:
		return "RWOP"
	}
	return string(m)
}

// accessModes joins a PVC's or PV's access modes in the abbreviated kubectl form (nil-safe, "" for
// other kinds). De-duplicated because the API can list a mode more than once.
func accessModes(obj runtime.Object) string {
	var modes []corev1.PersistentVolumeAccessMode
	switch o := obj.(type) {
	case *corev1.PersistentVolumeClaim:
		modes = o.Spec.AccessModes
	case *corev1.PersistentVolume:
		modes = o.Spec.AccessModes
	default:
		return ""
	}
	seen := map[string]bool{}
	var out []string
	for _, m := range modes {
		s := accessModeShort(m)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return strings.Join(out, "/")
}

// storageClass returns a PVC's or PV's storage class name (the provisioner/tier), "" when unset for
// other kinds. A PVC's spec.storageClassName is the request; we don't fall back to the bound PV's class
// here (the client shows whichever the object itself declares — the manifest carries the resolved one).
func storageClass(obj runtime.Object) string {
	switch o := obj.(type) {
	case *corev1.PersistentVolumeClaim:
		if o.Spec.StorageClassName != nil {
			return *o.Spec.StorageClassName
		}
	case *corev1.PersistentVolume:
		return o.Spec.StorageClassName
	}
	return ""
}

// asStorageClass returns the object as an unstructured StorageClass (kd has no typed factory for it), or
// nil. A StorageClass's fields (provisioner, reclaimPolicy, …) sit at the top level, not under spec.
func asStorageClass(obj runtime.Object) *unstructured.Unstructured {
	return asUnstructuredKind(obj, "StorageClass")
}

// storageClassProvisioner returns a StorageClass's provisioner (its defining fact — which CSI driver /
// plugin backs volumes on it), "" for other kinds.
func storageClassProvisioner(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		s, _, _ := unstructured.NestedString(u.Object, "provisioner")
		return s
	}
	return ""
}

// storageClassSummary renders a StorageClass's headline — its provisioner plus a "default" marker when
// it's the cluster default (the class a PVC gets when it names none, via the is-default-class
// annotation). The default marker was surfaced nowhere before, yet it's the key differentiator among
// StorageClasses. Mirrors ingressClassSummary ("controller · default") so the cluster-scoped config
// kinds read alike (Repetition); the drawer's reclaim/binding/expandable chips carry the rest.
func storageClassSummary(obj runtime.Object) string {
	u := asStorageClass(obj)
	if u == nil {
		return ""
	}
	provisioner, _, _ := unstructured.NestedString(u.Object, "provisioner")
	if provisioner == "" {
		return ""
	}
	if u.GetAnnotations()["storageclass.kubernetes.io/is-default-class"] == "true" {
		return provisioner + " · default"
	}
	return provisioner
}

// storageClassReclaim returns a StorageClass's reclaim policy (Delete/Retain — does deleting a PVC
// destroy the underlying data?). The API default is Delete when unset.
func storageClassReclaim(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		if s, found, _ := unstructured.NestedString(u.Object, "reclaimPolicy"); found {
			return s
		}
		return "Delete"
	}
	return ""
}

// storageClassBinding returns a StorageClass's volume binding mode (Immediate / WaitForFirstConsumer).
// Immediate is the API default when unset.
func storageClassBinding(obj runtime.Object) string {
	if u := asStorageClass(obj); u != nil {
		if s, found, _ := unstructured.NestedString(u.Object, "volumeBindingMode"); found {
			return s
		}
		return "Immediate"
	}
	return ""
}

// storageClassExpandable reports a StorageClass's allowVolumeExpansion (can PVCs on it grow?).
func storageClassExpandable(obj runtime.Object) bool {
	if u := asStorageClass(obj); u != nil {
		b, _, _ := unstructured.NestedBool(u.Object, "allowVolumeExpansion")
		return b
	}
	return false
}

// secretType returns a Secret's type as a display string (empty for non-Secrets). An empty type
// defaults to Opaque, mirroring Kubernetes.
func secretType(obj runtime.Object) string {
	s, ok := obj.(*corev1.Secret)
	if !ok {
		return ""
	}
	if s.Type == "" {
		return string(corev1.SecretTypeOpaque)
	}
	return string(s.Type)
}
