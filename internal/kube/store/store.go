// Package store maintains an in-memory, dynamic-informer-backed cache of cluster state and
// produces snapshots (per-namespace, or cluster-scope) for the graph builder. A single
// shared cache backs every viewer (authorization is applied above this layer); see
// docs/ADR/20260527-architecture-overview.md and 20260527-kubernetes-access-model.md.
//
// Every kind the cluster exposes — built-in or CRD-defined — is watched via a single
// dynamic informer factory keyed by GroupVersionResource (GVR). Objects are stored as
// *unstructured.Unstructured; the graph package converts to typed structs at the boundary
// for the kinds where per-field logic exists (health rules, edge inferrers, …).
package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"

	"github.com/motoki317/kd/internal/kube/discovery"
)

// uidIndex names the secondary index kd installs on every informer so the ride-along
// resolver can do O(1) UID lookups instead of scanning every cluster-scoped object.
const uidIndex = "uid"

func uidIndexFunc(obj any) ([]string, error) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return nil, nil
	}
	uid := u.GetUID()
	if uid == "" {
		return nil, nil
	}
	return []string{string(uid)}, nil
}

// ClusterScope is the sentinel namespace name kd uses for cluster-scoped resources. It is
// invalid as a real Kubernetes namespace (DNS-1123 disallows underscores) so it can never
// collide with one. Path handlers and the client use this string in URLs.
const ClusterScope = "__cluster__"

// DefaultSkipKinds are the high-cardinality, low-signal kinds that are NOT eager-loaded by
// default. They're served by dedicated handlers (events) or are implementation-detail noise
// (controllerrevisions, leases, endpointslices) that dominates memory without informing the
// topology. Operators can override via --eager-kinds / --skip-kinds.
var DefaultSkipKinds = []string{
	"events",                                  // core/v1; we already query events on-demand
	"leases",                                  // coordination.k8s.io/v1; controller-leader churn
	"endpointslices",                          // discovery.k8s.io/v1; high-cardinality and we use Service selectors
	"controllerrevisions",                     // apps/v1; StatefulSet/DaemonSet rollout history
}

// well-known GVRs the store handles specially.
var (
	namespacesGVR = schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}
	crdsGVR       = schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}
)

// Options tunes Cache construction. Zero-value Options is valid: defaults eager-load
// everything discovered, minus DefaultSkipKinds.
type Options struct {
	// Resync is the informer resync period (Kubernetes-recommended ~10min).
	Resync time.Duration
	// SkipKinds removes resource names from the eager-load set, on top of DefaultSkipKinds.
	// "kind" here is the resource name ("pods", "workflows") to match what discovery
	// reports.
	SkipKinds []string
	// EagerKinds adds resource names back into the eager-load set, overriding both
	// DefaultSkipKinds and SkipKinds. Lets an operator explicitly opt back into watching
	// e.g. "events" if they want the full picture.
	EagerKinds []string
	// Discoverer overrides the default discovery.FromClient(client.Discovery()). Tests
	// inject a static discoverer to bypass the fake clientset's empty
	// ServerPreferredResources. Nil means "use the typed client's discovery".
	Discoverer discovery.Discoverer
}

// Cache holds the dynamic informer factory, the per-GVR informer + metadata, and fans
// informer events out to change subscribers (used to drive the SSE watch feed).
type Cache struct {
	client    kubernetes.Interface // typed: log streaming + discovery
	dynClient dynamic.Interface    // dynamic: every cached read
	disc      discovery.Discoverer
	factory   dynamicinformer.DynamicSharedInformerFactory
	opts      Options

	// stopCh is the lifetime of the informer goroutines: closed on Shutdown (or via the
	// caller's context done in Start). Held so the CRD watcher can Start newly-added
	// dynamic informers with the same lifetime as the originals.
	stopCh chan struct{}

	mu        sync.Mutex
	resources map[schema.GroupVersionResource]Resource // by GVR; updated on CRD add/remove
	failedAt  map[schema.GroupVersionResource]time.Time // last WARN time per GVR (throttle)

	// reconcileMu serializes CRD-triggered reconciles and coalesces bursts: while one is
	// running, additional triggers set `reconcilePending` instead of stacking goroutines.
	reconcileMu      sync.Mutex
	reconcileRunning bool
	reconcilePending bool

	subs    map[int]chan struct{}
	nextSub int
}

// Resource is the cached metadata for one watched GVR.
type Resource struct {
	GVR        schema.GroupVersionResource
	Kind       string
	Namespaced bool
	Informer   cache.SharedIndexInformer
}

// New constructs an unstarted Cache. Start must be called before snapshots/subscriptions are
// served. disc may be nil; New defaults to discovery.FromClient(client.Discovery()) in that
// case, which is the production wiring. opts.Discoverer takes precedence over disc when set.
func New(client kubernetes.Interface, dynClient dynamic.Interface, disc discovery.Discoverer, opts Options) *Cache {
	if opts.Discoverer != nil {
		disc = opts.Discoverer
	}
	if disc == nil {
		disc = discovery.FromClient(client.Discovery())
	}
	// Wrap with Cached so the startup path and the CRD-watcher reconciler don't issue
	// concurrent ServerPreferredResources round-trips on the apiserver.
	disc = discovery.NewCached(disc)
	if opts.Resync == 0 {
		opts.Resync = 10 * time.Minute
	}
	return &Cache{
		client:    client,
		dynClient: dynClient,
		disc:      disc,
		factory:   dynamicinformer.NewDynamicSharedInformerFactory(dynClient, opts.Resync),
		opts:      opts,
		stopCh:    make(chan struct{}),
		resources: map[schema.GroupVersionResource]Resource{},
		failedAt:  map[schema.GroupVersionResource]time.Time{},
	}
}

// Start discovers the cluster's resources, registers a dynamic informer for each non-skipped
// kind, waits for the initial cache sync, then wires change handlers + the CRD watcher. The
// caller's context cancellation tears every informer down.
func (c *Cache) Start(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		// Idempotent close so manual Shutdown + ctx-cancel both work.
		select {
		case <-c.stopCh:
		default:
			close(c.stopCh)
		}
	}()

	resources, err := c.disc.Discover(ctx)
	if err != nil {
		return fmt.Errorf("store: discover: %w", err)
	}
	c.registerEager(resources)

	// Start every registered informer, then block until they're synced. A failing watch
	// (RBAC denied, gone CRD) won't ever HasSynced; we time-bound the wait so a single bad
	// GVR doesn't hold up the rest.
	c.factory.Start(c.stopCh)
	c.waitForSync(ctx)

	// Wire change handlers AFTER initial sync so subscribers aren't flooded by initial
	// population events.
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { c.notify() },
		UpdateFunc: func(any, any) { c.notify() },
		DeleteFunc: func(any) { c.notify() },
	}
	c.mu.Lock()
	for gvr, r := range c.resources {
		if _, err := r.Informer.AddEventHandler(handler); err != nil {
			slog.Warn("store: add event handler failed", "gvr", gvr.String(), "err", err)
		}
	}
	c.mu.Unlock()

	// CRD watcher keeps the informer set in sync as CRDs are installed/removed at runtime.
	// Idempotent: if discovery already covered the CustomResourceDefinitions GVR (it
	// usually does), we just attach a handler to the existing informer.
	c.startCRDWatcher(ctx)

	return nil
}

// registerEager registers a dynamic informer for every resource not in the skip set. The
// factory de-dupes per GVR so calling this twice (initial Start + CRD reconcile) is safe.
func (c *Cache) registerEager(resources []discovery.Resource) {
	skip := c.skipSet()
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, r := range resources {
		if skip[r.GVR.Resource] {
			continue
		}
		if _, already := c.resources[r.GVR]; already {
			continue
		}
		c.registerLocked(r)
	}
}

// registerLocked adds an informer for one resource. Called under c.mu.
func (c *Cache) registerLocked(r discovery.Resource) {
	inf := c.factory.ForResource(r.GVR).Informer()
	// Add a UID secondary index so appendRideAlong can resolve ownerReferences in O(refs)
	// instead of scanning every cluster-scoped object. Must happen before the informer
	// starts; registerLocked runs before factory.Start, so this is safe.
	if err := inf.AddIndexers(cache.Indexers{uidIndex: uidIndexFunc}); err != nil {
		slog.Warn("store: add UID indexer failed", "gvr", r.GVR.String(), "err", err)
	}
	// Suppress noisy reflector errors (RBAC-denied watches, gone CRDs) — throttle to once
	// per (GVR, hour). Without this, a single missing-permission kind floods stderr with
	// the default ERROR every few seconds.
	gvr := r.GVR
	_ = inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
		c.recordWatchErr(gvr, err)
	})
	c.resources[r.GVR] = Resource{GVR: r.GVR, Kind: r.Kind, Namespaced: r.Namespaced, Informer: inf}
}

// waitForSync blocks up to a soft deadline waiting for every started informer to sync. A
// few unsyncable ones (RBAC denied) shouldn't hold up startup — they'll keep retrying in
// the background and just be excluded from snapshots.
func (c *Cache) waitForSync(ctx context.Context) {
	deadline, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c.factory.WaitForCacheSync(deadline.Done())
}

// skipSet returns the resource-name set excluded from eager startup. Defaults minus
// explicit EagerKinds, plus operator-supplied SkipKinds.
func (c *Cache) skipSet() map[string]bool {
	skip := make(map[string]bool, len(DefaultSkipKinds)+len(c.opts.SkipKinds))
	for _, k := range DefaultSkipKinds {
		skip[k] = true
	}
	for _, k := range c.opts.SkipKinds {
		skip[k] = true
	}
	for _, k := range c.opts.EagerKinds {
		delete(skip, k)
	}
	return skip
}

// recordWatchErr logs an informer watch error throttled to once per (GVR, hour), so an
// always-failing kind doesn't flood the log. Shutdown noise (context.Canceled) is dropped
// entirely — it isn't actionable for operators.
func (c *Cache) recordWatchErr(gvr schema.GroupVersionResource, err error) {
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}
	c.mu.Lock()
	last := c.failedAt[gvr]
	if time.Since(last) < time.Hour {
		c.mu.Unlock()
		return
	}
	c.failedAt[gvr] = time.Now()
	c.mu.Unlock()
	slog.Warn("store: watch error", "gvr", gvr.String(), "err", err)
}

// startCRDWatcher attaches an event handler to the CRD informer (if registered) and
// rediscovers on add/delete. The reconcile reads ServerPreferredResources fresh and
// registers any GVR not already in the cache. Removed CRDs are NOT explicitly stopped —
// the dynamic factory has no per-informer stop; their watches will fail and be throttled
// silently via recordWatchErr.
//
// A burst of CRD installs (Helm chart with 30 CRDs) triggers many add events back-to-back.
// Each is dispatched to triggerReconcile which coalesces via reconcileRunning/Pending so the
// expensive discovery round-trip runs at most once per burst, off the informer goroutine.
func (c *Cache) startCRDWatcher(ctx context.Context) {
	c.mu.Lock()
	r, ok := c.resources[crdsGVR]
	c.mu.Unlock()
	if !ok {
		return // CRDs API not available (e.g. an older or stripped cluster)
	}
	_, _ = r.Informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { c.triggerReconcile(ctx) },
		DeleteFunc: func(any) { c.triggerReconcile(ctx) },
	})
}

// triggerReconcile starts a reconcile goroutine if none is running; otherwise it marks one
// pending so a final reconcile runs after the current one drains. Returns immediately.
func (c *Cache) triggerReconcile(ctx context.Context) {
	c.reconcileMu.Lock()
	if c.reconcileRunning {
		c.reconcilePending = true
		c.reconcileMu.Unlock()
		return
	}
	c.reconcileRunning = true
	c.reconcileMu.Unlock()
	go c.reconcileLoop(ctx)
}

// reconcileLoop runs reconciles serially until no more are pending. Each iteration reads
// pending under the lock, clears it, runs the reconcile unlocked, then re-checks.
func (c *Cache) reconcileLoop(ctx context.Context) {
	for {
		c.reconcile(ctx)
		c.reconcileMu.Lock()
		if !c.reconcilePending {
			c.reconcileRunning = false
			c.reconcileMu.Unlock()
			return
		}
		c.reconcilePending = false
		c.reconcileMu.Unlock()
	}
}

func (c *Cache) reconcile(ctx context.Context) {
	discCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resources, err := c.disc.Discover(discCtx)
	if err != nil {
		slog.Warn("store: CRD reconcile discovery failed", "err", err)
		return
	}
	c.registerEager(resources)
	// Start any newly-registered informers. The factory tracks startedInformers so this is
	// a no-op for ones already running.
	c.factory.Start(c.stopCh)
}

// Client exposes the underlying typed clientset for operations that bypass the cache, e.g.
// log streaming.
func (c *Cache) Client() kubernetes.Interface { return c.client }

// GroupForKind returns the API group of the registered resource whose Kind matches, so the
// RBAC layer can authorize a kind-named URL against group-keyed policy.csv rules. Returns
// ("", false) when no registered resource has that kind. Empty string is the core group,
// which is a valid (and common) result.
//
// When two registered resources share a Kind (e.g. a malicious CRD installed under a
// different group than the legitimate one), GroupForKind returns the lexicographically
// smallest group deterministically — so policy decisions are stable across map-iteration
// orders and the same URL doesn't route to different RBAC rules between calls.
func (c *Cache) GroupForKind(kind string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var groups []string
	for _, r := range c.resources {
		if r.Kind == kind {
			groups = append(groups, r.GVR.Group)
		}
	}
	if len(groups) == 0 {
		return "", false
	}
	sort.Strings(groups)
	return groups[0], true
}

// ListNamespaces returns all cached namespace names, sorted. Returns nil if the
// namespaces informer isn't available (e.g. RBAC denied).
func (c *Cache) ListNamespaces() []string {
	c.mu.Lock()
	r, ok := c.resources[namespacesGVR]
	c.mu.Unlock()
	if !ok {
		return nil
	}
	var names []string
	for _, obj := range r.Informer.GetIndexer().List() {
		if m, err := meta(obj); err == nil {
			names = append(names, m.GetName())
		}
	}
	slices.Sort(names)
	return names
}

// SnapshotNamespace returns every cached object in the given namespace, plus the
// cluster-scoped objects that a namespaced object in this namespace references (one hop
// via ownerReferences or any spec-field reference that resolves to a cluster-scoped
// object). See ride-along policy in docs/ADR/20260528-dynamic-informers-and-cluster-scope.md.
//
// For the cluster sentinel (ClusterScope) returns every cluster-scoped object.
func (c *Cache) SnapshotNamespace(namespace string) []runtime.Object {
	if namespace == ClusterScope {
		return c.SnapshotCluster()
	}
	c.mu.Lock()
	resources := make([]Resource, 0, len(c.resources))
	for _, r := range c.resources {
		resources = append(resources, r)
	}
	c.mu.Unlock()

	var out []runtime.Object
	for _, r := range resources {
		if !r.Namespaced {
			continue
		}
		objs, err := r.Informer.GetIndexer().ByIndex(cache.NamespaceIndex, namespace)
		if err != nil {
			continue
		}
		for _, obj := range objs {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	out = appendRideAlong(out, resources)
	return out
}

// SnapshotCluster returns every cluster-scoped cached object.
func (c *Cache) SnapshotCluster() []runtime.Object {
	c.mu.Lock()
	resources := make([]Resource, 0, len(c.resources))
	for _, r := range c.resources {
		resources = append(resources, r)
	}
	c.mu.Unlock()

	var out []runtime.Object
	for _, r := range resources {
		if r.Namespaced {
			continue
		}
		for _, obj := range r.Informer.GetIndexer().List() {
			if o, ok := obj.(runtime.Object); ok {
				out = append(out, o)
			}
		}
	}
	return out
}

// Subscribe returns a channel that receives a signal whenever cached state changes, plus a
// cancel function the subscriber must call to unsubscribe (e.g. when an SSE connection closes).
// The channel is buffered to depth 1 and coalescing: bursts collapse into a single pending
// signal, so subscribers see "something changed" rather than every event.
func (c *Cache) Subscribe() (<-chan struct{}, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.subs == nil {
		c.subs = map[int]chan struct{}{}
	}
	id := c.nextSub
	c.nextSub++
	ch := make(chan struct{}, 1)
	c.subs[id] = ch
	return ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if existing, ok := c.subs[id]; ok {
			delete(c.subs, id)
			close(existing)
		}
	}
}

func (c *Cache) notify() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ch := range c.subs {
		select {
		case ch <- struct{}{}:
		default: // a signal is already pending; coalesce
		}
	}
}

// meta is a thin wrapper around the apimachinery meta accessor so call sites don't import it.
func meta(obj any) (metav1.Object, error) {
	o, ok := obj.(metav1.Object)
	if ok {
		return o, nil
	}
	// Unstructured satisfies metav1.Object via its GetObjectMeta pointer; the type
	// assertion above should always succeed for cached objects. Fall through is defensive.
	return nil, fmt.Errorf("store: object is not metav1.Object: %T", obj)
}

// appendRideAlong adds cluster-scoped objects that are referenced (one hop) by the
// namespaced objects already in `out`. Resolved references:
//   - metadata.ownerReferences UID → any cluster-scoped object with that UID
//   - Pod.spec.nodeName → Node
//   - PVC.spec.volumeName → PersistentVolume
//
// Lookups go through the per-informer indexer: UID via the uidIndex secondary index
// (installed by registerLocked), Node/PV by name via the default key index. Each lookup is
// O(|refs|) so the total work is bounded by the namespaced-object reference fan-out, not by
// the size of cluster-scoped state — important on clusters with thousands of CRs.
func appendRideAlong(out []runtime.Object, resources []Resource) []runtime.Object {
	if len(out) == 0 {
		return out
	}
	wantUIDs := map[string]bool{}
	wantNodeNames := map[string]bool{}
	wantPVNames := map[string]bool{}
	have := map[string]bool{}
	for _, obj := range out {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		if uid := string(u.GetUID()); uid != "" {
			have[uid] = true
		}
		for _, or := range u.GetOwnerReferences() {
			if or.UID != "" {
				wantUIDs[string(or.UID)] = true
			}
		}
		switch u.GetKind() {
		case "Pod":
			if name, found, _ := unstructured.NestedString(u.Object, "spec", "nodeName"); found && name != "" {
				wantNodeNames[name] = true
			}
		case "PersistentVolumeClaim":
			if name, found, _ := unstructured.NestedString(u.Object, "spec", "volumeName"); found && name != "" {
				wantPVNames[name] = true
			}
		}
	}
	if len(wantUIDs) == 0 && len(wantNodeNames) == 0 && len(wantPVNames) == 0 {
		return out
	}
	add := func(obj any) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			return
		}
		uid := string(u.GetUID())
		if have[uid] {
			return
		}
		have[uid] = true
		out = append(out, u)
	}
	for _, r := range resources {
		if r.Namespaced {
			continue
		}
		idx := r.Informer.GetIndexer()
		for uid := range wantUIDs {
			objs, err := idx.ByIndex(uidIndex, uid)
			if err != nil {
				continue
			}
			for _, obj := range objs {
				add(obj)
			}
		}
		switch r.Kind {
		case "Node":
			for name := range wantNodeNames {
				if obj, exists, _ := idx.GetByKey(name); exists {
					add(obj)
				}
			}
		case "PersistentVolume":
			for name := range wantPVNames {
				if obj, exists, _ := idx.GetByKey(name); exists {
					add(obj)
				}
			}
		}
	}
	return out
}

// Shutdown stops every informer and waits for the goroutines. Safe to call multiple times.
func (c *Cache) Shutdown() {
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}
	c.factory.Shutdown()
}
