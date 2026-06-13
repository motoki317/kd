package store

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/tools/cache"
)

// stripForCache is the informer TransformFunc kd installs on every dynamic informer. It drops
// fields kd never reads from the object BEFORE the object enters the shared cache, so the
// resident set holds only what the topology/health/spec layers actually use. The win is large
// and measured (GOMAXPROCS=4, ~95-CRD cluster):
//   - CRD `spec.versions[].schema` (the OpenAPI v3 validation schemas) was ~87% of CRD bytes and
//     CRDs were ~74% of the entire live heap — deeply-nested map[string]interface{} trees nothing
//     in kd inspects (crdSummary reads only names/scope/served versions). The detail drawer fetches
//     CRDs live (Cache.GetLive) so the full manifest is still available on demand.
//   - metadata.managedFields (~24% of every other object) and the last-applied-configuration
//     annotation: pure apiserver bookkeeping. presentable() already strips both from the detail
//     view, so removing them from the cache is invisible to every reader.
//
// Mutates the object in place: the informer hands the transform a freshly-decoded object it owns,
// and the func is idempotent (deleting an absent key is a no-op), satisfying the SetTransform
// contract that a transform may run more than once on the same object.
func stripForCache(obj any) (any, error) {
	if tomb, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		return tomb, nil // a tombstone carries only a key + last-known object; nothing to trim
	}
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return obj, nil
	}
	if md, ok := u.Object["metadata"].(map[string]any); ok {
		delete(md, "managedFields")
		if ann, ok := md["annotations"].(map[string]any); ok {
			delete(ann, "kubectl.kubernetes.io/last-applied-configuration")
			if len(ann) == 0 {
				delete(md, "annotations")
			}
		}
	}
	if u.GetKind() == "CustomResourceDefinition" {
		if spec, ok := u.Object["spec"].(map[string]any); ok {
			if versions, ok := spec["versions"].([]any); ok {
				for _, v := range versions {
					if vm, ok := v.(map[string]any); ok {
						delete(vm, "schema")
					}
				}
			}
		}
	}
	return u, nil
}
