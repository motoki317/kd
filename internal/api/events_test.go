package api

import (
	"slices"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
)

func TestEventsForResource(t *testing.T) {
	base := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	ev := func(reason string, t string, secsAgo int, uid, kind, name string) *corev1.Event {
		return &corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: reason, Namespace: "shop"},
			InvolvedObject: corev1.ObjectReference{Kind: kind, Name: name, UID: types.UID(uid)},
			Reason:         reason,
			Type:           t,
			Message:        reason + " happened",
			Count:          1,
			LastTimestamp:  metav1.NewTime(base.Add(-time.Duration(secsAgo) * time.Second)),
		}
	}
	objs := []runtime.Object{
		ev("FailedScheduling", corev1.EventTypeWarning, 30, "pod-uid", "Pod", "web-1"),
		ev("Pulled", corev1.EventTypeNormal, 120, "pod-uid", "Pod", "web-1"),
		ev("Scaled", corev1.EventTypeNormal, 10, "other-uid", "Deployment", "web"), // different object
		ev("Started", corev1.EventTypeNormal, 5, "", "Pod", "web-1"),               // matches by name (no uid)
	}

	// uids represents the resource subtree (here just the pod itself).
	got := eventsFor(objs, map[string]bool{"pod-uid": true}, "Pod", "web-1")
	if len(got) != 3 {
		t.Fatalf("got %d events, want 3 (the Deployment event excluded): %+v", len(got), got)
	}
	// Newest first: Started (5s) > FailedScheduling (30s) > Pulled (120s).
	wantOrder := []string{"Started", "FailedScheduling", "Pulled"}
	for i, w := range wantOrder {
		if got[i].Reason != w {
			t.Errorf("event %d = %q, want %q (order: %v)", i, got[i].Reason, w, reasons(got))
		}
	}

	// Aggregation: a controller's subtree (Deployment uid + pod uid) pulls in the pod's events too.
	agg := eventsFor(objs, map[string]bool{"other-uid": true, "pod-uid": true}, "Deployment", "web")
	got2 := reasons(agg)
	if !contains(got2, "Scaled") || !contains(got2, "FailedScheduling") {
		t.Errorf("aggregated events = %v, want both the Deployment's Scaled and the pod's FailedScheduling", got2)
	}
	// Source ("Kind/name") is on every entry so the client can show which descendant emitted it
	// when viewing a controller's aggregated events.
	for _, e := range agg {
		if e.Source == "" {
			t.Errorf("event %q has empty Source; want a Kind/name", e.Reason)
		}
	}
	if src := sourceFor(agg, "Scaled"); src != "Deployment/web" {
		t.Errorf("Scaled.Source = %q, want Deployment/web", src)
	}
	if src := sourceFor(agg, "FailedScheduling"); src != "Pod/web-1" {
		t.Errorf("FailedScheduling.Source = %q, want Pod/web-1", src)
	}
}

// At an equal last-seen time, a Warning must sort ahead of a Normal (typeRank tie-break) so
// problems sit at the top of the drawer's Events list even when they coincide with routine events.
func TestEventsForTieBreaksWarningFirst(t *testing.T) {
	at := metav1.NewTime(time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC))
	mk := func(reason, typ string) *corev1.Event {
		return &corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: reason, Namespace: "shop"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "web-1", UID: types.UID("pod-uid")},
			Reason:         reason, Type: typ, Count: 1, LastTimestamp: at,
		}
	}
	// Input order puts the Normal first to prove the sort, not the input order, decides it.
	objs := []runtime.Object{mk("Pulled", corev1.EventTypeNormal), mk("BackOff", corev1.EventTypeWarning)}
	got := eventsFor(objs, map[string]bool{"pod-uid": true}, "Pod", "web-1")
	if len(got) != 2 || got[0].Reason != "BackOff" {
		t.Errorf("tie-break order = %v, want the Warning (BackOff) first", reasons(got))
	}
}

// Events that tie on BOTH last-seen second and type must still sort into one stable order regardless
// of the input order: the event stream re-lists from the apiserver and pushes only when the list
// differs, so a non-total order (which slices.SortFunc, being unstable, could permute between calls)
// would make the diff see a phantom change and push on an otherwise-idle connection.
func TestEventsForTotalOrderIsInputIndependent(t *testing.T) {
	at := metav1.NewTime(time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC))
	mk := func(reason string) *corev1.Event {
		return &corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: reason, Namespace: "shop"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "web-1", UID: types.UID("pod-uid")},
			Reason:         reason, Type: corev1.EventTypeWarning, Count: 1, LastTimestamp: at,
		}
	}
	uids := map[string]bool{"pod-uid": true}
	forward := reasons(eventsFor([]runtime.Object{mk("BackOff"), mk("FailedMount"), mk("Unhealthy")}, uids, "Pod", "web-1"))
	reversed := reasons(eventsFor([]runtime.Object{mk("Unhealthy"), mk("FailedMount"), mk("BackOff")}, uids, "Pod", "web-1"))
	if !slices.Equal(forward, reversed) {
		t.Errorf("sort order depends on input: forward=%v reversed=%v", forward, reversed)
	}
}

// lastSeen walks a fallback chain when the legacy LastTimestamp is absent: Series.LastObservedTime,
// then EventTime, then CreationTimestamp. The drawer needs a real timestamp from modern
// (series/eventTime) events too, not an empty "last".
func TestEventsForTimeFallbackChain(t *testing.T) {
	ts := time.Date(2026, 5, 27, 9, 30, 0, 0, time.UTC)
	want := ts.UTC().Format(time.RFC3339)
	base := func(reason string) corev1.Event {
		return corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Name: reason, Namespace: "shop"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "web-1", UID: types.UID("pod-uid")},
			Reason:         reason, Type: corev1.EventTypeNormal, Count: 1,
		}
	}
	series := base("FromSeries")
	series.Series = &corev1.EventSeries{LastObservedTime: metav1.NewMicroTime(ts)}
	eventTime := base("FromEventTime")
	eventTime.EventTime = metav1.NewMicroTime(ts)
	creation := base("FromCreation")
	creation.CreationTimestamp = metav1.NewTime(ts)

	for _, tc := range []struct {
		name string
		ev   corev1.Event
	}{
		{"series", series},
		{"eventTime", eventTime},
		{"creation", creation},
	} {
		ev := tc.ev
		got := eventsFor([]runtime.Object{&ev}, map[string]bool{"pod-uid": true}, "Pod", "web-1")
		if len(got) != 1 || got[0].Last != want {
			t.Errorf("%s fallback: Last = %q, want %q", tc.name, lastOf(got), want)
		}
	}
}

// A zero Count clamps to 1 — every event happened at least once; a literal 0 would read as "never".
func TestEventsForCountClampsToOne(t *testing.T) {
	ev := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "Killing", Namespace: "shop"},
		InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "web-1", UID: types.UID("pod-uid")},
		Reason:         "Killing", Type: corev1.EventTypeNormal, Count: 0,
		LastTimestamp: metav1.NewTime(time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)),
	}
	got := eventsFor([]runtime.Object{ev}, map[string]bool{"pod-uid": true}, "Pod", "web-1")
	if len(got) != 1 || got[0].Count != 1 {
		t.Errorf("Count = %d, want 1 (a zero count clamps up)", got[0].Count)
	}
}

func lastOf(es []eventEntry) string {
	if len(es) == 0 {
		return ""
	}
	return es[0].Last
}

func sourceFor(es []eventEntry, reason string) string {
	for _, e := range es {
		if e.Reason == reason {
			return e.Source
		}
	}
	return ""
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func reasons(es []eventEntry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.Reason
	}
	return out
}
