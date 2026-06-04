package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
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
	// Stream the full graph: the client now projects relationship subsets and groups them itself
	// (relationship filters + group-by replaced the server's per-view Filter), so there is no
	// server-side view to pick. The same graph drives the namespace rollup — the sidebar's "is this
	// ns healthy?" always sees every kind, so e.g. a Service with no endpoints can't look healthy.
	build := func() (*graph.Graph, graph.Summary) {
		full := graph.Build(store.SnapshotNamespace(ns))
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
		// The capacity view shows LIVE utilization, so drop terminal (Succeeded/Failed) pods: a
		// finished or errored pod holds no reservation and consumes nothing, yet would otherwise pad a
		// node's request/usage bars. Filtering the snapshot itself keeps the node geometry and the
		// usage feed consistent (both built from the same set). (The topology graph deliberately keeps
		// Failed pods — they're actionable there; capacity is about what's running now.)
		snap = slices.DeleteFunc(snap, stoppedPod)
		g := graph.Build(snap)
		var usage *graph.Usage
		if mc := store.MetricsClient(); mc != nil {
			resolvePod, resolveNode := uidResolvers(snap)
			if u, err := graph.BuildUsage(r.Context(), mc, "", true, resolvePod, resolveNode); err == nil {
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
	// Send the capacity payload immediately so the Nodes view isn't blank until the first tick.
	if !writeSSE(w, "capacity", buildCapacity()) {
		return
	}
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
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
			if patch := graph.Diff(prev, next); !patch.Empty() {
				if !writeSSE(w, "patch", patch) {
					return
				}
				flusher.Flush()
			}
			if nextSummary != prevSummary {
				if !writeSSE(w, "summary", nextSummary) {
					return
				}
				flusher.Flush()
			}
			prev, prevSummary = next, nextSummary
			// A graph change may have added/removed pods; refresh the capacity view too so the
			// Nodes group-by tracks pod churn without waiting for the usage tick.
			if !writeSSE(w, "capacity", buildCapacity()) {
				return
			}
			flusher.Flush()
		case <-usageTick.C:
			if !writeSSE(w, "capacity", buildCapacity()) {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
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

// podsForResource returns the live pods whose logs represent the given resource: the pod itself if
// kind is Pod, otherwise every pod reachable through ownerReferences. It resolves through the graph
// so historical/completed pods (which Build drops) are excluded from the aggregate.
func podsForResource(objs []runtime.Object, kind, name string) []*corev1.Pod {
	// Snapshots arrive as *unstructured.Unstructured from the dynamic-informer store. Convert
	// known kinds (Pod included) so the type assertion below works regardless of input shape.
	objs = graph.AsTypedSlice(objs)
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
