package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/motoki317/kd/internal/kube/graph"
)

// namespacesRefreshInterval bounds how often the namespaces stream re-summarizes the cluster. Unlike
// the graph stream — which rebuilds ONE namespace per change and can afford a 300ms debounce — this
// rolls up EVERY visible namespace, so recomputing on each store change would turn constant lease
// churn (leases renew every few seconds in every cluster) into a full-cluster re-summarization several
// times a second. Recompute on this coarse cadence instead, gated by whether anything changed, so CPU
// matches the old 15s client poll while only diffs reach the wire. The OPEN namespace stays instantly
// fresh via the graph stream's `summary` event; this feed keeps the OTHER namespaces coarsely current.
const namespacesRefreshInterval = 15 * time.Second

// handleNamespacesStream streams the sidebar's per-namespace health: a `namespaces` event with the
// full list on connect, then again whenever the rolled-up health changes. Replaces the client's 15s
// /namespaces poll. See docs/ADR/20260527-realtime-transport-sse.md.
func (a *API) handleNamespacesStream(w http.ResponseWriter, r *http.Request) {
	id, ok := a.requireIdentity(w, r)
	if !ok {
		return
	}
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	setSSEHeaders(w)

	changes, unsubscribe := store.Subscribe()
	defer unsubscribe()

	// Wait for the informers to settle before the first push, exactly like the REST handler, so the
	// sidebar's first paint isn't a half-synced partial that flashes false Degraded.
	a.waitForNamespaceSync(r.Context(), store)

	var sent []namespaceEntry
	have := false
	push := func() bool {
		next := a.namespaceEntries(store, id)
		if have && slices.Equal(sent, next) {
			return true // unchanged: stay silent so an idle cluster costs nothing on the wire
		}
		sent, have = next, true
		if !writeSSE(w, "namespaces", namespacesResponse{Namespaces: next}) {
			return false
		}
		flusher.Flush()
		return true
	}
	if !push() {
		return
	}

	refresh := time.NewTicker(namespacesRefreshInterval)
	defer refresh.Stop()
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	// dirty gates the recompute: the change signal is cluster-wide and fires on unrelated churn, so a
	// refresh tick re-summarizes only when something actually changed since the last push (and never on
	// a fully idle cluster). Bounds the full-cluster rollup to once per refresh interval.
	dirty := false
	for {
		select {
		case <-r.Context().Done():
			return
		case <-changes:
			dirty = true
		case <-refresh.C:
			if !dirty {
				continue
			}
			dirty = false
			if !push() {
				return
			}
		case <-heartbeat.C:
			if !writeHeartbeat(w) {
				return
			}
			flusher.Flush()
		}
	}
}

// sseHeartbeatInterval is how often an idle SSE stream emits a `ping` event, so a proxy or browser
// doesn't drop a connection that simply has no events to send — and so the client can tell a live
// connection from a silently stalled one (see writeHeartbeat). Shared by every SSE handler
// (namespaces, graph, events, log stream).
const sseHeartbeatInterval = 15 * time.Second

// handleGraphStream streams the namespace graph: an initial `snapshot` event with the full
// graph, then `patch` events as cache changes are coalesced. See
// docs/ADR/20260527-realtime-transport-sse.md.
func (a *API) handleGraphStream(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("ns")
	id, ok := a.authorize(w, r, ns, "pods", "list")
	if !ok {
		return
	}
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	setSSEHeaders(w)

	changes, unsubscribe := store.Subscribe()
	defer unsubscribe()

	clusterScope := ns == ClusterScopeNamespace
	canReadPodLogs := func(podNS string) bool {
		return a.enforcer.Enforce(id.User, id.Groups, podNS, "logs", "get")
	}
	// Loggable makes graph payloads viewer-dependent. This is safe while each stream builds its own
	// graph; any future build sharing must keep this authorization annotation per viewer.
	// Stream the full graph: the client now projects relationship subsets and groups them itself
	// (relationship filters + group-by replaced the server's per-view Filter), so there is no
	// server-side view to pick. The same graph drives the namespace rollup — the sidebar's "is this
	// ns healthy?" always sees every kind, so e.g. a Service with no endpoints can't look healthy.
	build := func() (*graph.Graph, graph.Summary) {
		display := store.SnapshotNamespace(ns)
		sourceSnapshot := display
		if clusterScope {
			sourceSnapshot = store.SnapshotNodesAndPods()
		}
		full := graph.BuildWithLogSources(display, authorizedLogSourcePods(sourceSnapshot, canReadPodLogs))
		return full, graph.SummarizeBuilt(full, clusterScope)
	}

	// buildCapacity assembles the Nodes group-by (capacity view) payload: the WHOLE cluster's
	// Nodes + Pods (not just this namespace's), each with allocatable/requests/limits/health, plus
	// live per-UID usage from metrics-server. The capacity view is cluster-wide by nature — a node
	// hosts pods from every namespace — so it always carries all pods and the client dims those
	// outside the selected namespace. Usage is built with clusterScope=true so every namespace's
	// pod metrics resolve. metrics-server absence leaves Usage nil (bars fall back to requests).
	buildCapacity := func() capacityPayload {
		snap := store.SnapshotNodesAndPods()
		sourcePods := authorizedLogSourcePods(snap, canReadPodLogs)
		// The capacity view shows LIVE utilization, so drop terminal (Succeeded/Failed) pods: a
		// finished or errored pod holds no reservation and consumes nothing, yet would otherwise pad a
		// node's request/usage bars. Filtering the snapshot itself keeps the node geometry and the
		// usage feed consistent (both built from the same set). (The topology graph deliberately keeps
		// Failed pods — they're actionable there; capacity is about what's running now.)
		snap = slices.DeleteFunc(snap, stoppedPod)
		g := graph.BuildWithLogSources(snap, sourcePods)
		var usage *graph.Usage
		if mc := store.MetricsClient(); mc != nil {
			resolvePod, resolveNode := uidResolvers(snap)
			ctx, cancel := context.WithTimeout(r.Context(), a.usageTimeout)
			u, err := graph.BuildUsage(ctx, mc, "", true, resolvePod, resolveNode)
			cancel()
			if err == nil {
				usage = u
			}
		}
		return capacityPayload{Nodes: g.Nodes, Usage: usage}
	}

	prev, prevSummary := build()
	if !writeSSE(w, "snapshot", prev) {
		return
	}
	if !writeSSE(w, "summary", prevSummary) {
		return
	}
	// Flush the topology snapshot+summary NOW — it's the primary payload and must not wait on the
	// capacity build below. buildCapacity snapshots the whole cluster's nodes/pods and calls
	// metrics-server; when that is slow (or hangs), gating the flush behind it left small-snapshot
	// namespaces (few resources, so the write stays under the HTTP buffer and never auto-flushes)
	// stuck on "connecting…" indefinitely, while large namespaces happened to auto-flush and looked
	// fine. Decoupling the flush makes the graph appear immediately for every namespace; capacity
	// follows when ready (and the Nodes view falls back to requests until then).
	flusher.Flush()
	// Send the capacity payload so the Nodes view isn't blank until the first tick.
	if !writeSSE(w, "capacity", buildCapacity()) {
		return
	}
	flusher.Flush()

	heartbeat := time.NewTicker(a.heartbeatInterval)
	defer heartbeat.Stop()
	// The capacity view is refreshed on its own cadence: metrics-server samples ~every 15s, and a
	// usage push is independent of graph-change debouncing.
	usageTick := time.NewTicker(15 * time.Second)
	defer usageTick.Stop()
	// Fixed-window debounce: the first change after a quiet period arms the timer; further
	// changes within the window are absorbed, bounding update latency to a.debounce.
	debounce := time.NewTimer(0)
	if !debounce.Stop() {
		<-debounce.C
	}
	armed := false

	for {
		select {
		case <-r.Context().Done():
			return
		case <-changes:
			if !armed {
				armed = true
				debounce.Reset(a.debounce)
			}
		case <-debounce.C:
			armed = false
			next, nextSummary := build()
			graphChanged := false
			if patch := graph.Diff(prev, next); !patch.Empty() {
				if !writeSSE(w, "patch", patch) {
					return
				}
				flusher.Flush()
				graphChanged = true
			}
			if nextSummary != prevSummary {
				if !writeSSE(w, "summary", nextSummary) {
					return
				}
				flusher.Flush()
			}
			prev, prevSummary = next, nextSummary
			// Re-send the capacity payload only when THIS namespace's graph actually changed (pods
			// added/removed). The store's change signal is cluster-wide and fires on unrelated churn —
			// notably Lease heartbeats, which renew every few seconds in EVERY cluster — so the old
			// unconditional re-send pushed the ~40KB cluster-wide capacity payload on every debounce
			// tick. On an idle namespace that flooded the stream (hundreds of KB/s of redundant data)
			// and could swamp the client before it rendered. Cross-namespace pod changes that don't
			// touch this graph still refresh on the 15s usageTick below (metrics sample at ~that rate
			// anyway), so the Nodes view stays current without the flood.
			if graphChanged {
				if !writeSSE(w, "capacity", buildCapacity()) {
					return
				}
				flusher.Flush()
			}
		case <-usageTick.C:
			if !writeSSE(w, "capacity", buildCapacity()) {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if !writeHeartbeat(w) {
				return
			}
			flusher.Flush()
		}
	}
}

func authorizedLogSourcePods(objs []runtime.Object, canRead func(string) bool) []runtime.Object {
	permissions := make(map[string]bool)
	var pods []runtime.Object
	for _, obj := range objs {
		apiVersion, kind := graph.GVKOf(obj)
		if apiVersion != "v1" || kind != "Pod" {
			continue
		}
		m, err := meta.Accessor(obj)
		if err != nil {
			continue
		}
		allowed, checked := permissions[m.GetNamespace()]
		if !checked {
			allowed = canRead(m.GetNamespace())
			permissions[m.GetNamespace()] = allowed
		}
		if allowed {
			pods = append(pods, obj)
		}
	}
	return pods
}

// uidResolvers builds (namespace, name) → UID lookups over a cache snapshot for the usage feed:
// one for namespaced Pods and one for cluster-scoped Nodes (whose namespace is ""). metrics-server
// reports metrics by name, but the graph keys nodes by UID, so usage must be re-keyed via these.
func uidResolvers(snapshot []runtime.Object) (resolvePod, resolveNode graph.UIDResolver) {
	type key struct{ ns, name string }
	pods := map[key]string{}
	nodes := map[string]string{}
	for _, obj := range snapshot {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		uid := string(u.GetUID())
		if uid == "" {
			continue
		}
		switch u.GetKind() {
		case "Pod":
			pods[key{u.GetNamespace(), u.GetName()}] = uid
		case "Node":
			nodes[u.GetName()] = uid
		}
	}
	resolvePod = func(ns, name string) (string, bool) {
		uid, ok := pods[key{ns, name}]
		return uid, ok
	}
	resolveNode = func(_, name string) (string, bool) {
		uid, ok := nodes[name]
		return uid, ok
	}
	return resolvePod, resolveNode
}

// stoppedPod reports whether a pod has reached a terminal phase (Succeeded or Failed) and so no longer
// reserves or consumes node resources — the capacity view drops these (see buildCapacity). Reads the
// phase from the cached unstructured shape, or a typed Pod (tests). Non-pods are never "stopped".
func stoppedPod(obj runtime.Object) bool {
	switch o := obj.(type) {
	case *unstructured.Unstructured:
		if o.GetKind() != "Pod" {
			return false
		}
		phase, _, _ := unstructured.NestedString(o.Object, "status", "phase")
		return phase == string(corev1.PodSucceeded) || phase == string(corev1.PodFailed)
	case *corev1.Pod:
		return o.Status.Phase == corev1.PodSucceeded || o.Status.Phase == corev1.PodFailed
	default:
		return false
	}
}

// capacityPayload is the SSE `capacity` event: the cluster-wide Node + Pod set the Nodes group-by
// renders (every namespace's pods on each node) plus live usage keyed by UID. Sent in full each
// time (no diff) — it's a small, node-and-pod-only graph refreshed on the ~15s metrics cadence.
type capacityPayload struct {
	Nodes []graph.Node `json:"nodes"`
	Usage *graph.Usage `json:"usage,omitempty"`
}

func setSSEHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Disable proxy buffering so events are delivered promptly through nginx/traefik.
	h.Set("X-Accel-Buffering", "no")
}

// writeSSE emits one event; it reports success so the caller can stop on a broken connection.
func writeSSE(w http.ResponseWriter, event string, data any) bool {
	payload, err := json.Marshal(data)
	if err != nil {
		return false
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload)
	return err == nil
}

// writeHeartbeat emits a `ping` event to hold an idle stream open through proxies AND to give the
// client a liveness signal it can act on: an SSE COMMENT (`: heartbeat`) keeps the connection warm
// but EventSource never surfaces it to JS, so a client can't tell a quiet-but-alive stream from one a
// proxy has silently half-closed (which fires no `error`). A dispatched event can. The `data: {}` is
// required — the SSE spec dispatches an event only when its data buffer is non-empty, so a bare
// `event: ping` would be parsed and silently dropped. Like writeSSE it reports success so the caller
// can stop on a broken connection. The caller flushes.
func writeHeartbeat(w http.ResponseWriter) bool {
	return writeSSE(w, "ping", struct{}{})
}
