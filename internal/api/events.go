package api

import (
	"net/http"
	"slices"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
)

type eventEntry struct {
	Type    string `json:"type"`    // Normal | Warning
	Reason  string `json:"reason"`  // short CamelCase cause, e.g. BackOff, FailedScheduling
	Message string `json:"message"` // human-readable detail
	Count   int32  `json:"count"`   // times this event has repeated
	Last    string `json:"last"`    // RFC3339 last-seen, for relative display on the client
}

type eventsResponse struct {
	Events []eventEntry `json:"events"`
}

// handleResourceEvents returns the Kubernetes events about a resource (kubectl-describe's Events
// section): the answer to "why is this Pending/Degraded?". Authorized like the manifest — seeing a
// resource is enough to see what happened to it.
func (a *API) handleResourceEvents(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	if _, ok := a.authorize(w, r, ns, resourceClass(kind), "get"); !ok {
		return
	}
	snapshot := a.store.SnapshotNamespace(ns)
	obj, found := findResource(snapshot, kind, name)
	if !found {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	uid := ""
	if m, err := meta.Accessor(obj); err == nil {
		uid = string(m.GetUID())
	}
	writeJSON(w, eventsResponse{Events: eventsFor(snapshot, kind, name, types.UID(uid))})
}

// eventsFor collects the events whose involvedObject is the given resource, newest-first. It matches
// by UID when the event carries one (the reliable key) and falls back to kind+name so events from
// before a recreate still surface.
func eventsFor(objs []runtime.Object, kind, name string, uid types.UID) []eventEntry {
	var out []eventEntry
	for _, o := range objs {
		ev, ok := o.(*corev1.Event)
		if !ok {
			continue
		}
		io := ev.InvolvedObject
		byUID := uid != "" && io.UID == uid
		byName := io.Kind == kind && io.Name == name
		if !byUID && !byName {
			continue
		}
		out = append(out, eventEntry{
			Type:    ev.Type,
			Reason:  ev.Reason,
			Message: ev.Message,
			Count:   max(ev.Count, 1),
			Last:    lastSeen(ev),
		})
	}
	// Newest first; Warnings break ties ahead of Normal so problems sit at the top.
	slices.SortFunc(out, func(a, b eventEntry) int {
		if a.Last != b.Last {
			return -cmpStr(a.Last, b.Last)
		}
		return typeRank(b.Type) - typeRank(a.Type)
	})
	return out
}

// lastSeen prefers the modern EventTime/series time, falling back to the legacy LastTimestamp.
func lastSeen(ev *corev1.Event) string {
	if !ev.LastTimestamp.IsZero() {
		return ev.LastTimestamp.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	if ev.Series != nil && !ev.Series.LastObservedTime.IsZero() {
		return ev.Series.LastObservedTime.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	if !ev.EventTime.IsZero() {
		return ev.EventTime.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	return ev.CreationTimestamp.UTC().Format("2006-01-02T15:04:05Z07:00")
}

func typeRank(t string) int {
	if t == corev1.EventTypeWarning {
		return 1
	}
	return 0
}

func cmpStr(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}
