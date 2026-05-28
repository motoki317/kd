// Package api serves kd's HTTP API: the RBAC-filtered namespace list, per-namespace
// relationship graphs (snapshot + SSE patch feed), resource detail, and pod log streaming.
// Reads are served from the informer cache; every request is authorized via policy.csv.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"

	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/graph"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/rbac"
)

// Store is the read surface the API needs from a single context's informer cache.
type Store interface {
	ListNamespaces() []string
	SnapshotNamespace(namespace string) []runtime.Object
	Subscribe() (<-chan struct{}, func())
	Client() kubernetes.Interface
}

// Contexts is the registry surface the API depends on. *registry.Registry satisfies it;
// tests can supply a single-context fake.
type Contexts interface {
	Get(ctx context.Context, name string) (Store, error)
	List() []registry.ContextInfo
	Default() string
	Enabled() bool
}

// API holds the dependencies shared by all handlers.
type API struct {
	contexts Contexts
	enforcer *rbac.Enforcer
	// debounce coalesces a burst of cache changes before recomputing a stream's graph.
	debounce time.Duration
}

// New constructs an API over the given context registry and authorization enforcer.
func New(contexts Contexts, enforcer *rbac.Enforcer) *API {
	return &API{contexts: contexts, enforcer: enforcer, debounce: 300 * time.Millisecond}
}

// FromRegistry adapts *registry.Registry to Contexts. Registry.Get returns the concrete
// *store.Cache, which satisfies Store structurally — Go's nominal typing needs this method
// shim to bridge the return-type difference.
func FromRegistry(r *registry.Registry) Contexts { return registryAdapter{r} }

type registryAdapter struct{ *registry.Registry }

func (a registryAdapter) Get(ctx context.Context, name string) (Store, error) {
	return a.Registry.Get(ctx, name)
}

// Routes registers the API endpoints and returns the handler. Callers wrap it with the auth
// middleware so every handler can read the identity from the request context.
//
// Every namespaced route lives under /api/v1/contexts/{ctx}/... so handlers can resolve the
// per-context cache from the path. /api/v1/contexts itself is unprefixed: the client calls it
// before it has a context to ask for.
func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/contexts", a.handleContexts)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces", a.handleNamespaces)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces/{ns}/graph", a.handleGraph)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces/{ns}/graph/stream", a.handleGraphStream)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces/{ns}/resources/{kind}/{name}", a.handleResource)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces/{ns}/resources/{kind}/{name}/events", a.handleResourceEvents)
	mux.HandleFunc("GET /api/v1/contexts/{ctx}/namespaces/{ns}/resources/{kind}/{name}/log/stream", a.handleResourceLogStream)
	return mux
}

// resolveStore looks up the per-context cache named by the {ctx} path parameter. Returns
// nil + writes an HTTP error (404 for unknown context, 503 for build failures) on miss.
func (a *API) resolveStore(w http.ResponseWriter, r *http.Request) (Store, bool) {
	name := r.PathValue("ctx")
	store, err := a.contexts.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, registry.ErrUnknownContext) {
			http.Error(w, "unknown context", http.StatusNotFound)
			return nil, false
		}
		http.Error(w, "context unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return nil, false
	}
	return store, true
}

// authorize resolves the caller and checks the policy, writing 401/403 and returning false on
// failure so handlers can `if id, ok := a.authorize(...); !ok { return }`.
func (a *API) authorize(w http.ResponseWriter, r *http.Request, namespace, resource, action string) (auth.Identity, bool) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return id, false
	}
	if !a.enforcer.Enforce(id.User, id.Groups, namespace, resource, action) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return id, false
	}
	return id, true
}

type contextEntry struct {
	Name   string `json:"name"`
	Status string `json:"status"`          // "pending" | "syncing" | "ready" | "error"
	Error  string `json:"error,omitempty"` // populated only when Status == "error"
}

type contextsResponse struct {
	// Enabled reports whether the UI switcher should be shown — false in in-cluster mode where
	// there is no real kubeconfig and only one cache exists.
	Enabled  bool           `json:"enabled"`
	Default  string         `json:"default"`
	Contexts []contextEntry `json:"contexts"`
}

// handleContexts reports the available contexts so the client can render (or hide) the
// switcher and pick a default. Unauthenticated callers are still served — the listing is
// public so the page can render the switcher before any namespace fetch has authorized.
func (a *API) handleContexts(w http.ResponseWriter, r *http.Request) {
	infos := a.contexts.List()
	entries := make([]contextEntry, 0, len(infos))
	for _, info := range infos {
		entries = append(entries, contextEntry{Name: info.Name, Status: string(info.Status), Error: info.Error})
	}
	writeJSON(w, contextsResponse{Enabled: a.contexts.Enabled(), Default: a.contexts.Default(), Contexts: entries})
}

type namespacesResponse struct {
	Namespaces []namespaceEntry `json:"namespaces"`
}

type namespaceEntry struct {
	Name string `json:"name"`
	// Health is the worst resource health in the namespace, so the sidebar can flag trouble
	// without the user opening each one.
	Health string `json:"health"`
	// NonReady is how many resources are not Healthy, so the sidebar can convey the scale of
	// trouble (3 degraded things vs 1) for triage at cluster scale.
	NonReady int `json:"nonReady,omitempty"`
}

func (a *API) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	visible := a.enforcer.VisibleNamespaces(id.User, id.Groups, store.ListNamespaces())
	resp := namespacesResponse{Namespaces: make([]namespaceEntry, 0, len(visible))}
	for _, n := range visible {
		s := graph.Summarize(store.SnapshotNamespace(n))
		resp.Namespaces = append(resp.Namespaces, namespaceEntry{Name: n, Health: string(s.Health), NonReady: s.NonReady})
	}
	writeJSON(w, resp)
}

func (a *API) handleGraph(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("ns")
	if _, ok := a.authorize(w, r, ns, "pods", "list"); !ok {
		return
	}
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	view := graph.ParseView(r.URL.Query().Get("view"))
	g := graph.Build(store.SnapshotNamespace(ns)).Filter(view)
	writeJSON(w, g)
}

func (a *API) handleResource(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	if _, ok := a.authorize(w, r, ns, resourceClass(kind), "get"); !ok {
		return
	}
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	obj, found := findResource(store.SnapshotNamespace(ns), kind, name)
	if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	writeManifest(w, presentable(obj), r.URL.Query().Get("format"))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// Headers may already be sent on a streaming encode failure; log-and-move-on is the
		// best we can do without corrupting the response.
		return
	}
}
