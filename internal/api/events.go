package api

import (
	"cmp"
	"net/http"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/motoki317/kd/internal/kube/graph"
)

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
	// The graph (for the resource's UID and its owned subtree) comes from the cached snapshot.
	// Build re-runs the typed conversion internally, so pass the raw snapshot (like handleGraph).
	g := graph.Build(store.SnapshotNamespace(ns))
	rootID := g.NodeID(kind, name)
	if rootID == "" {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Aggregate over the resource and everything it owns, so a controller surfaces the scheduling
	// and image-pull events that actually land on its pods.
	uids := make(map[string]bool)
	for _, id := range g.DescendantIDs(rootID) {
		uids[id] = true
	}
	// Events are NOT eager-loaded into the informer cache (DefaultSkipKinds — too high-cardinality
	// and short-lived to keep watched), so they are absent from the snapshot. Fetch them live from
	// the API server on demand, kubectl-describe style. The cluster sentinel lists across all
	// namespaces (a cluster-scoped resource's events have no fixed namespace).
	eventsNS := ns
	if eventsNS == ClusterScopeNamespace {
		eventsNS = metav1.NamespaceAll
	}
	list, err := store.Client().CoreV1().Events(eventsNS).List(r.Context(), metav1.ListOptions{})
	if err != nil {
		http.Error(w, "failed to list events", http.StatusBadGateway)
		return
	}
	evs := make([]runtime.Object, len(list.Items))
	for i := range list.Items {
		evs[i] = &list.Items[i]
	}
	writeJSON(w, eventsResponse{Events: eventsFor(evs, uids, kind, name)})
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
	// Newest first; Warnings break ties ahead of Normal so problems sit at the top.
	slices.SortFunc(out, func(a, b eventEntry) int {
		if a.Last != b.Last {
			return -cmp.Compare(a.Last, b.Last)
		}
		return typeRank(b.Type) - typeRank(a.Type)
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
