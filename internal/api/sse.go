package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"

	"github.com/motoki317/kd/internal/kube/graph"
)

// handleGraphStream streams the namespace graph: an initial `snapshot` event with the full
// graph, then `patch` events as cache changes are coalesced. See
// docs/ADR/20260527-realtime-transport-sse.md.
func (a *API) handleGraphStream(w http.ResponseWriter, r *http.Request) {
	ns := r.PathValue("ns")
	if _, ok := a.authorize(w, r, ns, "pods", "list"); !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	setSSEHeaders(w)

	changes, unsubscribe := a.store.Subscribe()
	defer unsubscribe()

	view := graph.ParseView(r.URL.Query().Get("view"))
	build := func() *graph.Graph { return graph.Build(a.store.SnapshotNamespace(ns)).Filter(view) }

	prev := build()
	if !writeSSE(w, "snapshot", prev) {
		return
	}
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
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
			next := build()
			if patch := graph.Diff(prev, next); !patch.Empty() {
				if !writeSSE(w, "patch", patch) {
					return
				}
				flusher.Flush()
			}
			prev = next
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

type logLine struct {
	// Pod names the source pod so the client can label lines when a workload's logs are
	// aggregated across several pods. It is the pod's own name even for a single Pod.
	Pod string `json:"pod"`
	// Time is the line's emission timestamp (RFC3339Nano), set only when the client asked for
	// timestamps; it lets the client order an interleaved aggregate by true emission time.
	Time string `json:"time,omitempty"`
	Line string `json:"line"`
}

// handleResourceLogStream tails the logs of a resource as SSE `log` events. For a Pod that is the
// pod's own log; for a workload (Deployment, ReplicaSet, StatefulSet, ...) it is the merged logs of
// every descendant pod, so the developer reads one stream instead of opening each pod. Each line
// carries its source pod name.
func (a *API) handleResourceLogStream(w http.ResponseWriter, r *http.Request) {
	ns, kind, name := r.PathValue("ns"), r.PathValue("kind"), r.PathValue("name")
	if _, ok := a.authorize(w, r, ns, "logs", "get"); !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	pods := podsForResource(a.store.SnapshotNamespace(ns), kind, name)

	container := r.URL.Query().Get("container")
	tail := parseTail(r.URL.Query().Get("tailLines"))
	// "previous" returns the logs of the prior, crashed container (kubectl --previous) — the place a
	// CrashLoopBackOff reason actually lives. A terminated container can't be followed, so previous
	// implies a one-shot dump.
	previous := r.URL.Query().Get("previous") == "true"
	follow := !previous && r.URL.Query().Get("follow") != "false"
	timestamps := r.URL.Query().Get("timestamps") == "true"

	setSSEHeaders(w)
	flusher.Flush() // commit 200 + headers even before the first line (or when there are no pods)

	// Fan out: one goroutine per pod streams into a shared channel; this loop is the only writer
	// to w. The channel closes once every pod stream ends (all pods gone, or a non-follow EOF).
	lines := make(chan logLine, 64)
	var wg sync.WaitGroup
	for _, pod := range pods {
		wg.Add(1)
		go func(pod *corev1.Pod) {
			defer wg.Done()
			streamPodLogs(r.Context(), a.store.Client(), pod, container, follow, previous, timestamps, tail, lines)
		}(pod)
	}
	go func() { wg.Wait(); close(lines) }()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ll, ok := <-lines:
			if !ok {
				if follow {
					return // live stream: all pods gone, let the client reconnect
				}
				// One-shot dump finished; hold the connection open (idle) so the browser's
				// EventSource doesn't auto-reconnect and re-dump. Closing the request ends it.
				lines = nil
				continue
			}
			if !writeSSE(w, "log", ll) {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			// Keep the connection open through proxies even while idle (e.g. no pods yet).
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// podsForResource returns the live pods whose logs represent the given resource: the pod itself if
// kind is Pod, otherwise every pod reachable through ownerReferences. It resolves through the graph
// so historical/completed pods (which Build drops) are excluded from the aggregate.
func podsForResource(objs []runtime.Object, kind, name string) []*corev1.Pod {
	g := graph.Build(objs)
	rootID := g.NodeID(kind, name)
	if rootID == "" {
		return nil
	}
	want := make(map[string]bool)
	for _, p := range g.DescendantPodNames(rootID) {
		want[p] = true
	}
	var pods []*corev1.Pod
	for _, obj := range objs {
		if p, ok := obj.(*corev1.Pod); ok && want[p.Name] {
			pods = append(pods, p)
		}
	}
	return pods
}

// streamPodLogs follows one pod's logs, sending each line (tagged with the pod name) to out until
// the stream ends or ctx is cancelled. A pod that fails to open is skipped, not fatal, so one bad
// pod never aborts the rest of an aggregate.
func streamPodLogs(ctx context.Context, client kubernetes.Interface, pod *corev1.Pod, container string, follow, previous, timestamps bool, tail *int64, out chan<- logLine) {
	c := container
	// An empty container errors on multi-container pods, so default to the first container.
	if c == "" && len(pod.Spec.Containers) > 0 {
		c = pod.Spec.Containers[0].Name
	}
	opts := &corev1.PodLogOptions{Container: c, Follow: follow, Previous: previous, Timestamps: timestamps}
	if tail != nil {
		opts.TailLines = tail
	}
	stream, err := client.CoreV1().Pods(pod.Namespace).GetLogs(pod.Name, opts).Stream(ctx)
	if err != nil {
		return
	}
	defer stream.Close()
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		ll := logLine{Pod: pod.Name, Line: scanner.Text()}
		if timestamps {
			// kubelet prepends "<RFC3339Nano> " to each line; split it into its own field so the
			// client can render it dimmed (and the raw line stays clean for copy).
			ll.Time, ll.Line = splitLogTimestamp(ll.Line)
		}
		select {
		case out <- ll:
		case <-ctx.Done():
			return
		}
	}
}

// splitLogTimestamp separates the kubelet timestamp prefix ("<RFC3339Nano> message") from the
// message. It returns ("", line) unchanged when the first token isn't a timestamp, so a stray line
// without the prefix is never mangled.
func splitLogTimestamp(line string) (ts, msg string) {
	tok, rest, ok := strings.Cut(line, " ")
	if !ok {
		return "", line
	}
	if _, err := time.Parse(time.RFC3339Nano, tok); err != nil {
		return "", line
	}
	return tok, rest
}

func parseTail(s string) *int64 {
	if s == "" {
		return nil
	}
	var n int64
	if _, err := fmt.Sscan(s, &n); err != nil || n < 0 {
		return nil
	}
	return &n
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
