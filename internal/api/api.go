// Package api serves kd's HTTP API: the RBAC-filtered namespace list, per-namespace
// relationship graphs (snapshot + SSE patch feed), resource detail, and pod log streaming.
// Reads are served from the informer cache; every request is authorized via policy.csv.
package api

import (
	"encoding/json"
	"net/http"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"

	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/graph"
	"github.com/motoki317/kd/internal/rbac"
)

// Store is the read surface the API needs from the informer cache.
type Store interface {
	ListNamespaces() []string
	SnapshotNamespace(namespace string) []runtime.Object
	Subscribe() (<-chan struct{}, func())
	Client() kubernetes.Interface
}

// API holds the dependencies shared by all handlers.
type API struct {
	store    Store
	enforcer *rbac.Enforcer
	// debounce coalesces a burst of cache changes before recomputing a stream's graph.
	debounce time.Duration
}

// New constructs an API over the given store and authorization enforcer.
func New(store Store, enforcer *rbac.Enforcer) *API {
	return &API{store: store, enforcer: enforcer, debounce: 300 * time.Millisecond}
}

// Routes registers the API endpoints and returns the handler. Callers wrap it with the auth
// middleware so every handler can read the identity from the request context.
func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/namespaces", a.handleNamespaces)
	mux.HandleFunc("GET /api/v1/namespaces/{ns}/graph", a.handleGraph)
	mux.HandleFunc("GET /api/v1/namespaces/{ns}/graph/stream", a.handleGraphStream)
	mux.HandleFunc("GET /api/v1/namespaces/{ns}/resources/{kind}/{name}", a.handleResource)
	mux.HandleFunc("GET /api/v1/namespaces/{ns}/pods/{pod}/log/stream", a.handleLogStream)
	return mux
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

type namespacesResponse struct {
	Namespaces []namespaceEntry `json:"namespaces"`
}

type namespaceEntry struct {
	Name string `json:"name"`
	// Health is the worst resource health in the namespace, so the sidebar can flag trouble
	// without the user opening each one.
	Health string `json:"health"`
}

func (a *API) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	id, ok := auth.FromContext(r.Context())
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	visible := a.enforcer.VisibleNamespaces(id.User, id.Groups, a.store.ListNamespaces())
	resp := namespacesResponse{Namespaces: make([]namespaceEntry, 0, len(visible))}
	for _, n := range visible {
		health := graph.Summarize(a.store.SnapshotNamespace(n))
		resp.Namespaces = append(resp.Namespaces, namespaceEntry{Name: n, Health: string(health)})
	}
	writeJSON(w, resp)
}

func (a *API) handleGraph(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("ns")
	if _, ok := a.authorize(w, r, ns, "pods", "list"); !ok {
		return
	}
	view := graph.ParseView(r.URL.Query().Get("view"))
	g := graph.Build(a.store.SnapshotNamespace(ns)).Filter(view)
	writeJSON(w, g)
}

func (a *API) handleResource(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	if _, ok := a.authorize(w, r, ns, resourceClass(kind), "get"); !ok {
		return
	}
	obj, found := findResource(a.store.SnapshotNamespace(ns), kind, name)
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
