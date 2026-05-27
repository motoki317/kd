// Package store maintains an in-memory, informer-backed cache of cluster state and produces
// per-namespace object snapshots for the graph builder. A single shared cache backs every
// viewer (authorization is applied above this layer); see
// docs/ADR/20260527-architecture-overview.md and 20260527-kubernetes-access-model.md.
package store

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// Cache holds the informer factory and the registered informers, and fans informer events out
// to change subscribers (used to drive the SSE watch feed).
type Cache struct {
	client  kubernetes.Interface
	factory informers.SharedInformerFactory

	namespaces cache.SharedIndexInformer   // cluster-scoped; lists namespace names
	nodes      cache.SharedIndexInformer   // cluster-scoped; included in every namespace snapshot
	namespaced []cache.SharedIndexInformer // namespaced kinds, indexed by namespace
	all        []cache.SharedIndexInformer // every informer, for sync + change handlers

	mu       sync.Mutex
	onChange []func()
}

// New registers informers for the kinds kd visualizes and returns an unstarted Cache.
func New(client kubernetes.Interface, resync time.Duration) *Cache {
	f := informers.NewSharedInformerFactory(client, resync)
	c := &Cache{client: client, factory: f}

	c.namespaces = c.track(f.Core().V1().Namespaces().Informer())
	c.nodes = c.track(f.Core().V1().Nodes().Informer())

	// Namespaced kinds whose objects belong to a single namespace's graph.
	c.namespaced = []cache.SharedIndexInformer{
		c.track(f.Core().V1().Pods().Informer()),
		c.track(f.Core().V1().Services().Informer()),
		c.track(f.Core().V1().Endpoints().Informer()),
		c.track(f.Core().V1().ConfigMaps().Informer()),
		c.track(f.Core().V1().Secrets().Informer()),
		c.track(f.Core().V1().PersistentVolumeClaims().Informer()),
		c.track(f.Core().V1().ServiceAccounts().Informer()),
		c.track(f.Core().V1().Events().Informer()),
		c.track(f.Apps().V1().Deployments().Informer()),
		c.track(f.Apps().V1().ReplicaSets().Informer()),
		c.track(f.Apps().V1().StatefulSets().Informer()),
		c.track(f.Apps().V1().DaemonSets().Informer()),
		c.track(f.Batch().V1().Jobs().Informer()),
		c.track(f.Batch().V1().CronJobs().Informer()),
		c.track(f.Networking().V1().Ingresses().Informer()),
		c.track(f.Rbac().V1().Roles().Informer()),
		c.track(f.Rbac().V1().RoleBindings().Informer()),
	}
	return c
}

// track records an informer for lifecycle management (sync + change handlers) and returns it.
func (c *Cache) track(inf cache.SharedIndexInformer) cache.SharedIndexInformer {
	c.all = append(c.all, inf)
	return inf
}

// Start runs the informers, waits for the initial cache sync, then wires change handlers so
// later events notify subscribers without flooding them during initial population.
func (c *Cache) Start(ctx context.Context) error {
	c.factory.Start(ctx.Done())
	for typ, ok := range c.factory.WaitForCacheSync(ctx.Done()) {
		if !ok {
			return fmt.Errorf("store: informer for %v failed to sync", typ)
		}
	}
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { c.notify() },
		UpdateFunc: func(any, any) { c.notify() },
		DeleteFunc: func(any) { c.notify() },
	}
	for _, inf := range c.all {
		if _, err := inf.AddEventHandler(handler); err != nil {
			return fmt.Errorf("store: add event handler: %w", err)
		}
	}
	return nil
}

// Client exposes the underlying clientset for operations that bypass the cache, e.g. log
// streaming.
func (c *Cache) Client() kubernetes.Interface { return c.client }

// ListNamespaces returns all cached namespace names, sorted.
func (c *Cache) ListNamespaces() []string {
	var names []string
	for _, obj := range c.namespaces.GetIndexer().List() {
		if m, ok := obj.(metav1.Object); ok {
			names = append(names, m.GetName())
		}
	}
	slices.Sort(names)
	return names
}

// SnapshotNamespace returns the cached objects relevant to a namespace's graph: every
// namespaced object in that namespace, plus cluster-scoped Nodes (for Pod placement edges).
func (c *Cache) SnapshotNamespace(namespace string) []runtime.Object {
	var out []runtime.Object
	for _, inf := range c.namespaced {
		objs, err := inf.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
		if err != nil {
			continue // NamespaceIndex is always registered; an error here means no items
		}
		for _, obj := range objs {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	for _, obj := range c.nodes.GetIndexer().List() {
		if o, ok := obj.(runtime.Object); ok {
			out = append(out, o)
		}
	}
	return out
}

// OnChange registers a callback invoked whenever cached state changes. Callbacks should be
// cheap and non-blocking (e.g. signal a debounce timer); the SSE layer coalesces bursts.
func (c *Cache) OnChange(fn func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onChange = append(c.onChange, fn)
}

func (c *Cache) notify() {
	c.mu.Lock()
	fns := slices.Clone(c.onChange)
	c.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}
