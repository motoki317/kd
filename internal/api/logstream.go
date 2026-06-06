package api

// Log streaming: the `log` SSE endpoint that tails a resource's logs — a single pod's, or the merged
// logs of every descendant pod of a workload. Split from sse.go (which owns the graph stream) so the
// two SSE endpoints read as separate files; they share only the writeSSE / setSSEHeaders helpers and
// the API/Store types in this package.

import (
	"bufio"
	"context"
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
	store, ok := a.resolveStore(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

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

	// This loop is the only writer to w; pod streamers fan into the shared channel.
	lines := make(chan logLine, 64)
	if follow {
		// A supervisor keeps streamers running for the live descendant pod set, re-resolving so pods
		// created mid-rollout join the stream. It never closes `lines`; the writer loop below ends
		// only when the client disconnects (ctx done), so a momentary zero-pod gap mid-rollout no
		// longer tears the stream down.
		go superviseLogStreams(r.Context(), store, ns, kind, name, container, timestamps, tail, lines)
	} else {
		// One-shot: resolve the descendant pods once, dump each, and close when all are done.
		pods := podsForResource(store.SnapshotNamespace(ns), kind, name)
		var wg sync.WaitGroup
		for _, pod := range pods {
			wg.Add(1)
			go func(pod *corev1.Pod) {
				defer wg.Done()
				streamPodLogs(r.Context(), store.Client(), pod, container, false, previous, timestamps, tail, lines)
			}(pod)
		}
		go func() { wg.Wait(); close(lines) }()
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ll, ok := <-lines:
			if !ok {
				// Only the one-shot path closes `lines` (follow's supervisor never does). The dump
				// is finished; hold the connection open (idle) so the browser's EventSource doesn't
				// auto-reconnect and re-dump. Closing the request ends it.
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

// logResolveInterval is how often a follow stream re-resolves its descendant pods. A package var so
// tests can shorten it.
var logResolveInterval = 3 * time.Second

// superviseLogStreams keeps a follow stream's set of pod streamers in sync with the resource's live
// descendant pods. It re-resolves on a short interval and starts a streamer for any pod not already
// being followed, so pods created mid-rollout (a new ReplicaSet's pods, a restarted StatefulSet
// member) join the merged stream without the client reconnecting. Each streamer removes itself when
// its pod's log ends. Runs until ctx is cancelled; never closes out.
func superviseLogStreams(ctx context.Context, store Store, ns, kind, name, container string, timestamps bool, tail *int64, out chan<- logLine) {
	var mu sync.Mutex
	streaming := make(map[string]bool) // pod names with a live streamer, so we never double-stream

	resolve := func() {
		for _, pod := range podsForResource(store.SnapshotNamespace(ns), kind, name) {
			mu.Lock()
			if streaming[pod.Name] {
				mu.Unlock()
				continue
			}
			streaming[pod.Name] = true
			mu.Unlock()
			go func(pod *corev1.Pod) {
				streamPodLogs(ctx, store.Client(), pod, container, true, false, timestamps, tail, out)
				mu.Lock()
				delete(streaming, pod.Name)
				mu.Unlock()
			}(pod)
		}
	}

	resolve() // attach immediately; don't wait a full interval for the first lines
	ticker := time.NewTicker(logResolveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			resolve()
		}
	}
}

// podsForResource returns the pods whose logs represent the given resource: the pod itself if kind is
// Pod, otherwise every pod reachable through ownerReferences. It builds with BuildForLogs so a
// COMPLETED run's pods are reachable — a finished Job/CronJob/Workflow has nothing but completed pods,
// and excluding them (as the displayed graph does) made its Logs tab silently empty.
func podsForResource(objs []runtime.Object, kind, name string) []*corev1.Pod {
	// Snapshots arrive as *unstructured.Unstructured from the dynamic-informer store. Convert
	// known kinds (Pod included) so the type assertion below works regardless of input shape.
	objs = graph.AsTypedSlice(objs)
	g := graph.BuildForLogs(objs)
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
	if c == "" {
		c = defaultLogContainer(pod)
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

// defaultLogContainer picks which container's logs to show when the request names none. An empty
// container errors on a multi-container pod, so a default is required. It prefers a container named
// "main" — the Argo Workflows convention for the step that does the actual work, which sits BEHIND a
// `wait`/executor sidecar listed first; defaulting to the first container showed only executor noise
// for a workflow pod (the exact logs an operator opens a failed run to read are in `main`). For an
// ordinary app+sidecar pod (no `main`), it falls back to the first container, the app by convention.
func defaultLogContainer(pod *corev1.Pod) string {
	for _, ct := range pod.Spec.Containers {
		if ct.Name == "main" {
			return ct.Name
		}
	}
	if len(pod.Spec.Containers) > 0 {
		return pod.Spec.Containers[0].Name
	}
	return ""
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
