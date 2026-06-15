// Package registry maps kubeconfig context names to live informer caches. The first request
// for a context builds its client + cache and starts informers; subsequent callers share the
// same cache. Single-flight protects concurrent first-callers from double-building.
//
// In in-cluster mode the registry holds exactly one cache under the sentinel name
// "in-cluster"; the multi-context UI is gated off by the API's /contexts response.
package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	metricsversioned "k8s.io/metrics/pkg/client/clientset/versioned"

	"github.com/motoki317/kd/internal/kube/discovery"
	"github.com/motoki317/kd/internal/kube/kubeconfig"
	"github.com/motoki317/kd/internal/kube/store"
)

// ErrUnknownContext is returned by Get when the caller names a context the registry does
// not know. API handlers use errors.Is to map this to a 404.
var ErrUnknownContext = errors.New("registry: unknown context")

// InClusterContext is the sentinel context name used when kd runs against in-cluster config —
// there is no real kubeconfig context, but the API path still needs a name to route on.
const InClusterContext = "in-cluster"

// Status describes a context's cache lifecycle as seen by callers.
type Status string

const (
	StatusPending Status = "pending" // never accessed; no build attempted yet
	StatusSyncing Status = "syncing" // build started, informers not yet ready
	StatusReady   Status = "ready"   // informers synced; cache serves snapshots
	StatusError   Status = "error"   // build or sync failed; Err() carries the cause
)

// ContextInfo is a per-context status snapshot for the API surface.
type ContextInfo struct {
	Name   string
	Status Status
	Error  string
}

// Clients bundles the typed + dynamic Kubernetes clients a Cache needs. The typed client
// drives discovery and log streaming; the dynamic client backs every cached read. Metrics is
// the metrics-server client for the live usage feed and may be nil (metrics-server absent).
type Clients struct {
	Typed   kubernetes.Interface
	Dynamic dynamic.Interface
	Metrics metricsversioned.Interface
}

// Registry resolves a context name to its *store.Cache, lazily.
type Registry struct {
	resync  time.Duration
	mode    mode
	current string
	build   func(name string) (Clients, error)
	// storeOpts is forwarded to store.New (eager/skip kind overrides, …). Resync is
	// supplied from r.resync; SkipKinds/EagerKinds come from this template.
	storeOpts store.Options

	// listed contexts (kubeconfig only; "in-cluster" mode keeps this empty so the API can
	// report enabled=false and the UI hides the switcher).
	contexts []string

	mu      sync.Mutex
	entries map[string]*entry
}

type mode int

const (
	modeInCluster mode = iota
	modeKubeconfig
)

type entry struct {
	once   sync.Once
	ready  chan struct{} // closed when the build finishes (success or error)
	cache  *store.Cache
	err    error
	status Status // updated under registry.mu
}

// NewInCluster returns a single-context registry over the given in-cluster clients. The
// reported default context name is InClusterContext.
func NewInCluster(clients Clients, resync time.Duration, storeOpts store.Options) *Registry {
	return &Registry{
		resync:    resync,
		mode:      modeInCluster,
		current:   InClusterContext,
		build:     func(string) (Clients, error) { return clients, nil },
		storeOpts: storeOpts,
		entries:   map[string]*entry{},
	}
}

// NewKubeconfig returns a registry that lazily builds one cache per declared kubeconfig
// context. The default context is the kubeconfig's current-context. Each context's typed +
// dynamic clients are built from its rest.Config on first access.
func NewKubeconfig(loader *kubeconfig.Loader, resync time.Duration, storeOpts store.Options) *Registry {
	return NewWithBuilder(loader.Current(), loader.Contexts(), resync, storeOpts, func(name string) (Clients, error) {
		cfg, err := loader.RESTConfig(name)
		if err != nil {
			return Clients{}, err
		}
		typed, err := kubernetes.NewForConfig(cfg)
		if err != nil {
			return Clients{}, err
		}
		dyn, err := dynamic.NewForConfig(cfg)
		if err != nil {
			return Clients{}, err
		}
		// Tolerate a missing metrics client: metrics-server may not be installed. A nil
		// Metrics degrades the usage feed to a no-op rather than failing cache construction.
		metricsClient, _ := metricsversioned.NewForConfig(cfg)
		return Clients{Typed: typed, Dynamic: dyn, Metrics: metricsClient}, nil
	})
}

// NewWithBuilder is the lower-level constructor behind NewKubeconfig. Tests use it to inject
// a fake clients builder; production callers should prefer NewKubeconfig / NewInCluster.
func NewWithBuilder(current string, contexts []string, resync time.Duration, storeOpts store.Options, build func(name string) (Clients, error)) *Registry {
	return &Registry{
		resync:    resync,
		mode:      modeKubeconfig,
		current:   current,
		contexts:  append([]string(nil), contexts...),
		build:     build,
		storeOpts: storeOpts,
		entries:   map[string]*entry{},
	}
}

// Enabled reports whether the multi-context UI should be shown. False when running against
// in-cluster config (only one context exists), true otherwise.
func (r *Registry) Enabled() bool { return r.mode == modeKubeconfig }

// Default returns the default context name (kubeconfig's current-context, or InClusterContext).
func (r *Registry) Default() string { return r.current }

// List returns every context the registry knows about, with its current status. Pending
// entries (never accessed) appear with Status=StatusPending.
func (r *Registry) List() []ContextInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	names := r.knownNamesLocked()
	out := make([]ContextInfo, 0, len(names))
	for _, n := range names {
		info := ContextInfo{Name: n, Status: StatusPending}
		if e, ok := r.entries[n]; ok {
			info.Status = e.status
			if e.err != nil {
				info.Error = e.err.Error()
			}
		}
		out = append(out, info)
	}
	return out
}

// knownNamesLocked returns the union of declared contexts and any accessed sentinel names.
// (In-cluster mode declares no contexts up front but lazily registers "in-cluster" on first Get.)
func (r *Registry) knownNamesLocked() []string {
	if r.mode == modeKubeconfig {
		return r.contexts
	}
	out := make([]string, 0, len(r.entries))
	for n := range r.entries {
		out = append(out, n)
	}
	return out
}

// Get returns the cache for the named context, building it (and waiting for the initial
// informer sync) on first access. Concurrent first-callers share one build via single-flight.
// Empty name resolves to the default context.
func (r *Registry) Get(ctx context.Context, name string) (*store.Cache, error) {
	if name == "" {
		name = r.current
	}
	if !r.known(name) {
		return nil, fmt.Errorf("%w: %q", ErrUnknownContext, name)
	}
	e := r.getOrCreate(name)
	// Kick the build off lazily; once.Do guarantees a single build per entry across goroutines.
	go e.once.Do(func() { r.runBuild(name, e) })
	select {
	case <-e.ready:
		return e.cache, e.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Prewarm builds the cache for the named context AND waits for its initial sync to complete,
// returning the build error. Intended for the default context on startup so the cache lands fully
// populated. Get alone returns as soon as the cache is serving (watches started) — Prewarm adds the
// sync wait, so it is the "ready-to-use" signal. Production runs it in the background, so the wait
// never delays startup; tests rely on it for a deterministic, fully-synced cache.
func (r *Registry) Prewarm(ctx context.Context, name string) error {
	c, err := r.Get(ctx, name)
	if err != nil {
		return err
	}
	c.WaitForCacheSync(ctx)
	return nil
}

func (r *Registry) known(name string) bool {
	if r.mode == modeInCluster {
		return name == InClusterContext
	}
	for _, n := range r.contexts {
		if n == name {
			return true
		}
	}
	return false
}

func (r *Registry) getOrCreate(name string) *entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[name]; ok {
		return e
	}
	e := &entry{ready: make(chan struct{}), status: StatusSyncing}
	r.entries[name] = e
	return e
}

// runBuild constructs the clients + cache for one context and starts its informers. Runs
// once per entry (guarded by entry.once). Closes ready so waiters can proceed.
func (r *Registry) runBuild(name string, e *entry) {
	defer close(e.ready)
	// Log lazily-built contexts (a UI context switch) the same way main.go logs the default at
	// startup, so the server log shows the switch being handled instead of going silent — the
	// "nothing happens, no 'connecting to cluster' log" an operator sees on a multi-context switch.
	// The default context is already logged (with a full-sync "connected") around the startup
	// Prewarm, so skip it here to avoid a duplicate line.
	lazy := name != r.current
	if lazy {
		slog.Info("connecting to cluster", "context", name)
	}
	clients, err := r.build(name)
	if err != nil {
		if lazy {
			slog.Error("cluster connection failed", "context", name, "err", err)
		}
		r.setStatus(e, StatusError, err)
		return
	}
	opts := r.storeOpts
	opts.Resync = r.resync
	c := store.New(clients.Typed, clients.Dynamic, clients.Metrics, discovery.FromClient(clients.Typed.Discovery()), opts)
	// Cache lifetime is tied to the process — once started, informers run until the kd
	// process exits. A dedicated context keeps Start() independent of any single HTTP request.
	startCtx := context.Background()
	if err := c.Start(startCtx); err != nil {
		if lazy {
			slog.Error("cluster connection failed", "context", name, "err", err)
		}
		r.setStatus(e, StatusError, fmt.Errorf("registry: start cache for %q: %w", name, err))
		return
	}
	if lazy {
		slog.Info("cluster connected", "context", name)
	}
	r.mu.Lock()
	e.cache = c
	e.err = nil
	e.status = StatusReady
	r.mu.Unlock()
}

func (r *Registry) setStatus(e *entry, s Status, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e.status = s
	if err != nil {
		e.err = err
	}
}
