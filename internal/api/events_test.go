package api

import (
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
