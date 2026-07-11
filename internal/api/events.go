package api

import (
	"cmp"
	"context"
	"net/http"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/motoki317/kd/internal/kube/graph"
)

// eventStreamInterval is how often the event stream re-lists events from the apiserver. Events are
// not cached (DefaultSkipKinds — too high-cardinality and short-lived to watch), so the stream
// polls the live API server-side and pushes only when the list changes. This is the SAME List the
// client used to issue every 8s; moving it server-side lets the drawer hold one quiet SSE
// connection that's silent while nothing changes, instead of re-fetching the full list on a timer.
const eventStreamInterval = 8 * time.Second

type eventEntry struct {
	Type    string `json:"type"`             // Normal | Warning
	Reason  string `json:"reason"`           // short CamelCase cause, e.g. BackOff, FailedScheduling
	Message string `json:"message"`          // human-readable detail
	Count   int32  `json:"count"`            // times this event has repeated
	Last    string `json:"last"`             // RFC3339 last-seen, for relative display on the client
	Source  string `json:"source,omitempty"` // "Kind/name" of involvedObject; lets the client show which descendant emitted this event when aggregating
}

type eventsResponse struct {
	Events []eventEntry `json:"events"`
}

// handleResourceEvents returns the Kubernetes events about a resource (kubectl-describe's Events
// section): the answer to "why is this Pending/Degraded?". Authorized like the manifest — seeing a
// resource is enough to see what happened to it.
func (a *API) handleResourceEvents(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	if _, ok := a.authorizeKind(w, r, store, ns, kind, "get"); !ok {
		return
	}
	events, found, err := resourceEvents(r.Context(), store, ns, kind, name)
	if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "failed to list events", http.StatusBadGateway)
		return
	}
	writeJSON(w, eventsResponse{Events: events})
}

// handleResourceEventStream streams a resource's events over SSE: an `events` event carrying the full
// list on connect, then again whenever the list changes. The server re-lists from the apiserver on
// eventStreamInterval and diffs, so an idle resource's stream stays silent between heartbeats — the
// drawer holds one connection instead of polling. See docs/ADR/20260527-realtime-transport-sse.md.
func (a *API) handleResourceEventStream(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	if _, ok := a.authorizeKind(w, r, store, ns, kind, "get"); !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	setSSEHeaders(w)

	// Push the current list only when it differs from the last sent one. A resource absent from the
	// graph (deleted mid-stream, or a connect-time race) pushes an empty list rather than erroring:
	// the drawer's deleted-banner — driven by the graph stream — owns that UX, so the event feed just
	// goes quiet.
	var sent []eventEntry
	have := false
	push := func() bool {
		events, _, err := resourceEvents(r.Context(), store, ns, kind, name)
		if err != nil {
			return true // transient apiserver error: keep the stream open and retry next tick
		}
		if events == nil {
			events = []eventEntry{}
		}
		if have && slices.Equal(sent, events) {
			return true
		}
		sent, have = events, true
		if !writeSSE(w, "events", eventsResponse{Events: events}) {
			return false
		}
		flusher.Flush()
		return true
	}

	if !push() {
		return
	}
	poll := time.NewTicker(eventStreamInterval)
	defer poll.Stop()
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-poll.C:
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

// resourceEvents resolves the resource's UID and owned subtree from the cached graph snapshot and
// returns the live events landing on that subtree, newest-first (kubectl-describe style). found is
// false when the resource is absent from the graph; err is a non-nil apiserver List failure. Events
// are NOT in the informer cache (DefaultSkipKinds), so they're listed live; the cluster sentinel
// lists across all namespaces (a cluster-scoped resource's events have no fixed namespace).
func resourceEvents(ctx context.Context, store Store, ns, kind, name string) (events []eventEntry, found bool, err error) {
	g := graph.Build(store.SnapshotNamespace(ns))
	rootID := g.NodeID(kind, name)
	if rootID == "" {
		return nil, false, nil
	}
	// Aggregate over the resource and everything it owns, so a controller surfaces the scheduling
	// and image-pull events that actually land on its pods.
	uids := make(map[string]bool)
	for _, id := range g.DescendantIDs(rootID) {
		uids[id] = true
	}
	eventsNS := ns
	if eventsNS == ClusterScopeNamespace {
		eventsNS = metav1.NamespaceAll
	}
	list, err := store.Client().CoreV1().Events(eventsNS).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, true, err
	}
	evs := make([]runtime.Object, len(list.Items))
	for i := range list.Items {
		evs[i] = &list.Items[i]
	}
	return eventsFor(evs, uids, kind, name), true, nil
}

// eventsFor collects the events whose involvedObject is in the uid set (the resource and its
// descendants), newest-first. The root also matches by kind+name as a fallback for events that
// predate the current object (no UID match).
func eventsFor(objs []runtime.Object, uids map[string]bool, rootKind, rootName string) []eventEntry {
	var out []eventEntry
	for _, o := range objs {
		ev, ok := o.(*corev1.Event)
		if !ok {
			continue
		}
		io := ev.InvolvedObject
		byUID := io.UID != "" && uids[string(io.UID)]
		byName := io.UID == "" && io.Kind == rootKind && io.Name == rootName
		if !byUID && !byName {
			continue
		}
		out = append(out, eventEntry{
			Type:    ev.Type,
			Reason:  ev.Reason,
			Message: ev.Message,
			Count:   max(ev.Count, 1),
			Last:    lastSeen(ev),
			Source:  io.Kind + "/" + io.Name,
		})
	}
	// Newest first; Warnings break ties ahead of Normal so problems sit at the top. The remaining
	// fields are tiebreakers only to make this a TOTAL order: two events sharing a last-seen second
	// and type would otherwise compare equal, and pdqsort (slices.SortFunc is not stable) could swap
	// them between List calls — the event stream's diff would read that swap as a change and push on an
	// otherwise-idle connection, defeating the point of streaming.
	slices.SortFunc(out, func(a, b eventEntry) int {
		return cmp.Or(
			-cmp.Compare(a.Last, b.Last),
			typeRank(b.Type)-typeRank(a.Type),
			cmp.Compare(a.Reason, b.Reason),
			cmp.Compare(a.Source, b.Source),
			cmp.Compare(a.Message, b.Message),
			cmp.Compare(b.Count, a.Count),
		)
	})
	return out
}

// lastSeen prefers the modern EventTime/series time, falling back to the legacy LastTimestamp.
func lastSeen(ev *corev1.Event) string {
	if !ev.LastTimestamp.IsZero() {
		return ev.LastTimestamp.UTC().Format(time.RFC3339)
	}
	if ev.Series != nil && !ev.Series.LastObservedTime.IsZero() {
		return ev.Series.LastObservedTime.UTC().Format(time.RFC3339)
	}
	if !ev.EventTime.IsZero() {
		return ev.EventTime.UTC().Format(time.RFC3339)
	}
	return ev.CreationTimestamp.UTC().Format(time.RFC3339)
}

func typeRank(t string) int {
	if t == corev1.EventTypeWarning {
		return 1
	}
	return 0
}
