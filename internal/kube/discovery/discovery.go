// Package discovery enumerates every API resource a cluster exposes — built-in or
// CRD-defined — for the dynamic-informer store to watch. It wraps the typed discovery
// client with a small filtered view: resources that can be list+watch'd, no subresources,
// classified namespaced vs cluster-scoped, kind names preserved for display.
package discovery

import (
	"cmp"
	"context"
	"fmt"
	"slices"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// Resource is one watchable API resource — the bit of an APIResourceList kd actually needs to
// register a dynamic informer.
type Resource struct {
	GVR        schema.GroupVersionResource
	Kind       string // display kind, e.g. "Pod", "Workflow"
	Namespaced bool
	// ShortNames are the API's own abbreviations for this kind (kubectl's SHORTNAMES column),
	// e.g. ["cm"] for ConfigMap, ["pdb"] for PodDisruptionBudget. The client labels cards with
	// these so abbreviations track the cluster's source of truth — including CRD-defined ones —
	// instead of a hardcoded table. Empty for kinds the API gives no short name.
	ShortNames []string
}

// Discoverer enumerates resources the connected cluster exposes. The interface lets tests
// inject a fixed list without exercising the live discovery API.
type Discoverer interface {
	// Discover lists every watchable resource the cluster currently exposes. Returned in a
	// stable order (group, version, resource) so logs and tests are deterministic.
	Discover(ctx context.Context) ([]Resource, error)
}

// FromClient returns a Discoverer backed by a real Kubernetes discovery client.
func FromClient(d discovery.DiscoveryInterface) Discoverer { return clientDiscoverer{d: d} }

type clientDiscoverer struct{ d discovery.DiscoveryInterface }

// Discover calls ServerPreferredResources (one preferred version per group, which is what we
// want — informers should not run twice for v1beta1+v1 of the same kind) and filters to
// resources that support list+watch and aren't subresources (which carry "/" in Name and are
// served by their parent informer's writes).
func (c clientDiscoverer) Discover(ctx context.Context) ([]Resource, error) {
	lists, err := c.d.ServerPreferredResources()
	// Partial discovery is normal on a cluster with broken or stale APIService aggregations
	// (e.g. a metrics-server that's down). Return what we got rather than failing the whole
	// startup; the caller logs the per-group errors.
	if err != nil && !discovery.IsGroupDiscoveryFailedError(err) {
		return nil, fmt.Errorf("discovery: server preferred resources: %w", err)
	}
	var out []Resource
	for _, list := range lists {
		if list == nil {
			continue
		}
		gv, parseErr := schema.ParseGroupVersion(list.GroupVersion)
		if parseErr != nil {
			continue
		}
		for _, r := range list.APIResources {
			if !canListWatch(r) || isSubresource(r) {
				continue
			}
			// APIResource.Group/Version override the list-level GV only when set — most
			// resources leave them empty and inherit from the list.
			g, v := r.Group, r.Version
			if g == "" {
				g = gv.Group
			}
			if v == "" {
				v = gv.Version
			}
			out = append(out, Resource{
				GVR:        schema.GroupVersionResource{Group: g, Version: v, Resource: r.Name},
				Kind:       r.Kind,
				Namespaced: r.Namespaced,
				ShortNames: r.ShortNames,
			})
		}
	}
	slices.SortFunc(out, func(a, b Resource) int {
		if c := cmp.Compare(a.GVR.Group, b.GVR.Group); c != 0 {
			return c
		}
		if c := cmp.Compare(a.GVR.Version, b.GVR.Version); c != 0 {
			return c
		}
		return cmp.Compare(a.GVR.Resource, b.GVR.Resource)
	})
	return out, nil
}

// canListWatch reports whether a resource exposes both list and watch verbs — the minimum an
// informer needs. A resource with only get (e.g. a virtual /me endpoint) can't be cached.
func canListWatch(r metav1.APIResource) bool {
	var hasList, hasWatch bool
	for _, v := range r.Verbs {
		switch v {
		case "list":
			hasList = true
		case "watch":
			hasWatch = true
		}
	}
	return hasList && hasWatch
}

// isSubresource reports whether the resource is a subresource like pods/log or
// deployments/scale, which a dynamic informer cannot handle (and shouldn't — the parent
// informer's events already cover changes to the parent object).
func isSubresource(r metav1.APIResource) bool {
	for _, c := range r.Name {
		if c == '/' {
			return true
		}
	}
	return false
}

// Static returns a Discoverer that yields a fixed list of resources. Tests use it to bypass
// the live discovery API.
func Static(res []Resource) Discoverer { return staticDiscoverer{res: slices.Clone(res)} }

type staticDiscoverer struct{ res []Resource }

func (s staticDiscoverer) Discover(context.Context) ([]Resource, error) { return s.res, nil }
