package api

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"

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
	Line string `json:"line"`
}

// handleLogStream tails a pod container's logs as SSE `log` events, wrapping the Kubernetes
// pods/log follow stream.
func (a *API) handleLogStream(w http.ResponseWriter, r *http.Request) {
	ns, podName := r.PathValue("ns"), r.PathValue("pod")
	if _, ok := a.authorize(w, r, ns, "logs", "get"); !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	follow := r.URL.Query().Get("follow") != "false"
	opts := &corev1.PodLogOptions{
		Container: r.URL.Query().Get("container"),
		Follow:    follow,
	}
	if tail := parseTail(r.URL.Query().Get("tailLines")); tail != nil {
		opts.TailLines = tail
	}

	stream, err := a.store.Client().CoreV1().Pods(ns).GetLogs(podName, opts).Stream(r.Context())
	if err != nil {
		http.Error(w, "could not open log stream", http.StatusBadGateway)
		return
	}
	defer stream.Close()

	setSSEHeaders(w)
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if !writeSSE(w, "log", logLine{Line: scanner.Text()}) {
			return
		}
		flusher.Flush()
	}
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
