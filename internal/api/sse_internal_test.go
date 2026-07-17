package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	metricsversioned "k8s.io/metrics/pkg/client/clientset/versioned"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/discovery"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/kube/store"
	"github.com/motoki317/kd/internal/rbac"
)

func TestGraphStreamMetricsTimeoutKeepsEventsFlowing(t *testing.T) {
	metricsRequested := make(chan struct{}, 1)
	hangSrv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case metricsRequested <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	t.Cleanup(hangSrv.Close)
	metricsClient, err := metricsversioned.NewForConfig(&rest.Config{Host: hangSrv.URL})
	if err != nil {
		t.Fatalf("create metrics client: %v", err)
	}

	seed := []runtime.Object{&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}}}
	typed := fake.NewSimpleClientset(seed...)
	dyn := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, seed...)
	resources := []discovery.Resource{
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}, Kind: "Namespace", Namespaced: false},
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}, Kind: "Node", Namespaced: false},
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
	}
	reg := registry.NewInCluster(
		registry.Clients{Typed: typed, Dynamic: dyn, Metrics: metricsClient},
		0,
		store.Options{Discoverer: discovery.Static(resources)},
	)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := reg.Prewarm(ctx, registry.InClusterContext); err != nil {
		t.Fatalf("prewarm registry: %v", err)
	}
	p, err := rbac.Parse(nil)
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	a := New(FromRegistry(reg), rbac.NewEnforcer(p))
	a.usageTimeout = 50 * time.Millisecond
	a.heartbeatInterval = 50 * time.Millisecond
	srv := httptest.NewServer(auth.Config{UserHeader: "X-Forwarded-User"}.Middleware(a.Routes()))
	t.Cleanup(srv.Close)

	reqCtx, reqCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer reqCancel()
	req, err := http.NewRequestWithContext(
		reqCtx,
		http.MethodGet,
		srv.URL+"/api/v1/contexts/"+registry.InClusterContext+"/namespaces/shop/graph/stream",
		nil,
	)
	if err != nil {
		t.Fatalf("create graph stream request: %v", err)
	}
	req.Header.Set("X-Forwarded-User", "alice")
	started := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open graph stream: %v", err)
	}
	defer resp.Body.Close()

	var event string
	sawSnapshot, sawCapacity, sawPing := false, false, false
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			data := strings.TrimPrefix(line, "data: ")
			switch event {
			case "snapshot":
				sawSnapshot = true
			case "capacity":
				if !sawCapacity && time.Since(started) > 2*time.Second {
					t.Errorf("initial capacity arrived after %v, want under 2s", time.Since(started))
				}
				sawCapacity = true
				if strings.Contains(data, `"usage"`) {
					t.Errorf("timed-out capacity payload includes usage: %s", data)
				}
			case "ping":
				sawPing = true
			}
		}
		if sawSnapshot && sawCapacity && sawPing {
			break
		}
	}
	if err := sc.Err(); err != nil && reqCtx.Err() == nil {
		t.Fatalf("read graph stream: %v", err)
	}
	select {
	case <-metricsRequested:
	default:
		t.Error("graph stream never called the hanging metrics server")
	}
	if !sawSnapshot || !sawCapacity || !sawPing {
		t.Errorf("graph stream events: snapshot=%v capacity=%v ping=%v, want all", sawSnapshot, sawCapacity, sawPing)
	}
}

func TestSplitLogTimestamp(t *testing.T) {
	tests := map[string]struct {
		line     string
		wantTime string
		wantMsg  string
	}{
		"rfc3339nano prefix is split off": {
			line:     "2026-05-28T01:02:03.123456789Z hello world",
			wantTime: "2026-05-28T01:02:03.123456789Z",
			wantMsg:  "hello world",
		},
		"timezone offset prefix is split off": {
			line:     "2026-05-28T10:02:03+09:00 こんにちは",
			wantTime: "2026-05-28T10:02:03+09:00",
			wantMsg:  "こんにちは",
		},
		"a line without a timestamp is left intact": {
			line:    "plain log line without timestamp",
			wantMsg: "plain log line without timestamp",
		},
		"a non-timestamp first token is not mistaken for one": {
			line:    "INFO starting up",
			wantMsg: "INFO starting up",
		},
		"a line with no space is left intact": {
			line:    "single-token",
			wantMsg: "single-token",
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			ts, msg := splitLogTimestamp(tc.line)
			if ts != tc.wantTime || msg != tc.wantMsg {
				t.Errorf("splitLogTimestamp(%q) = (%q, %q), want (%q, %q)", tc.line, ts, msg, tc.wantTime, tc.wantMsg)
			}
		})
	}
}

// TestFollowLogStreamPicksUpNewPods guards the mid-rollout fix: a follow stream must attach to a
// descendant pod created after the stream opened (a rollout's new ReplicaSet pods), not just the
// pods present at connect time. It shortens logResolveInterval so the supervisor re-resolves fast.
func TestFollowLogStreamPicksUpNewPods(t *testing.T) {
	saved := logResolveInterval
	logResolveInterval = 40 * time.Millisecond
	t.Cleanup(func() { logResolveInterval = saved })

	rsOwner := []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-rs", UID: types.UID("rs-uid"), Controller: boolp(true)}}
	seed := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web", UID: "dep-uid"}},
		&appsv1.ReplicaSet{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-rs", UID: "rs-uid",
				OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "web", UID: "dep-uid", Controller: boolp(true)}}},
			Spec:   appsv1.ReplicaSetSpec{Replicas: int32p(2)},
			Status: appsv1.ReplicaSetStatus{Replicas: 2},
		},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-a", UID: "pa", OwnerReferences: rsOwner}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	}
	client := fake.NewSimpleClientset(seed...)
	dyn := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, seed...)
	resources := []discovery.Resource{
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}, Kind: "Namespace", Namespaced: false},
		{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
		{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, Kind: "Deployment", Namespaced: true},
		{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}, Kind: "ReplicaSet", Namespaced: true},
	}
	opts := store.Options{Discoverer: discovery.Static(resources)}
	reg := registry.NewInCluster(registry.Clients{Typed: client, Dynamic: dyn}, 0, opts)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := reg.Prewarm(ctx, registry.InClusterContext); err != nil {
		t.Fatalf("prewarm registry: %v", err)
	}
	p, err := rbac.Parse(nil)
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	srv := httptest.NewServer(auth.Config{UserHeader: "X-Forwarded-User"}.Middleware(New(FromRegistry(reg), rbac.NewEnforcer(p)).Routes()))
	t.Cleanup(srv.Close)

	reqCtx, reqCancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer reqCancel()
	req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, srv.URL+"/api/v1/contexts/"+registry.InClusterContext+"/namespaces/shop/resources/Deployment/web/log/stream", nil)
	req.Header.Set("X-Forwarded-User", "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("log stream request: %v", err)
	}
	defer resp.Body.Close()

	createdB := false
	sawA, sawB := false, false
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ll struct{ Pod string }
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ll) != nil {
			continue
		}
		switch ll.Pod {
		case "web-a":
			sawA = true
			// Only after the stream is live and following web-a, roll out a second pod.
			if !createdB {
				createdB = true
				// Create web-b on BOTH fakes: the dynamic client drives the store's
				// informer (so the supervisor's re-resolve picks it up), the typed
				// client drives Pod.GetLogs() (so the streamer can actually open a log
				// stream once we attach).
				webB := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-b", UID: "pb", OwnerReferences: rsOwner}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
				if _, err := client.CoreV1().Pods("shop").Create(ctx, webB, metav1.CreateOptions{}); err != nil {
					t.Fatalf("create web-b (typed): %v", err)
				}
				webBU := &unstructured.Unstructured{Object: map[string]any{
					"apiVersion": "v1", "kind": "Pod",
					"metadata": map[string]any{
						"namespace": "shop", "name": "web-b", "uid": "pb",
						"ownerReferences": []any{map[string]any{"kind": "ReplicaSet", "name": "web-rs", "uid": "rs-uid", "controller": true, "apiVersion": "apps/v1"}},
					},
					"status": map[string]any{"phase": "Running"},
				}}
				podGVR := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
				if _, err := dyn.Resource(podGVR).Namespace("shop").Create(ctx, webBU, metav1.CreateOptions{}); err != nil {
					t.Fatalf("create web-b (dynamic): %v", err)
				}
			}
		case "web-b":
			sawB = true
		}
		if sawA && sawB {
			reqCancel() // got what we came for; stop the (never-ending) follow stream
			break
		}
	}
	if !sawA || !sawB {
		t.Errorf("follow stream saw web-a=%v web-b=%v, want both (pod created mid-stream must join)", sawA, sawB)
	}
}

// stubLogStore satisfies just the two Store methods superviseLogStreams touches; objs() controls
// the snapshot per call, so the test mutates the "cluster" deterministically (no informer plumbing).
type stubLogStore struct {
	Store
	objs   func() []runtime.Object
	client kubernetes.Interface
}

func (s *stubLogStore) SnapshotNamespace(string) []runtime.Object { return s.objs() }
func (s *stubLogStore) Client() kubernetes.Interface              { return s.client }

// TestSuperviseLogStreamsReportsResourceGone guards the deleted-while-tailing fix: when the tailed
// resource itself vanishes from the snapshot, the supervisor signals `gone` (once per transition) so
// the viewer can render a terminal state instead of "waiting for log output…" forever. A zero-pod
// gap with the resource still PRESENT stays silent — the mid-rollout tolerance.
func TestSuperviseLogStreamsReportsResourceGone(t *testing.T) {
	saved := logResolveInterval
	logResolveInterval = 20 * time.Millisecond
	t.Cleanup(func() { logResolveInterval = saved })

	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-a", UID: "pa"}, Status: corev1.PodStatus{Phase: corev1.PodRunning}}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web", UID: "dep-uid"}}
	var mu sync.Mutex
	snapshot := []runtime.Object{pod}
	st := &stubLogStore{
		objs: func() []runtime.Object {
			mu.Lock()
			defer mu.Unlock()
			return append([]runtime.Object(nil), snapshot...)
		},
		client: fake.NewSimpleClientset(pod),
	}
	setSnapshot := func(objs ...runtime.Object) {
		mu.Lock()
		snapshot = objs
		mu.Unlock()
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	lines := make(chan logLine, 64)
	gone := make(chan struct{}, 1)
	go superviseLogStreams(ctx, st, "shop", "Pod", "web-a", "", false, nil, func(string) bool { return true }, lines, gone)
	go func() { // drain so streamers never block on the lines channel
		for {
			select {
			case <-ctx.Done():
				return
			case <-lines:
			}
		}
	}()

	expectGone := func(want bool, what string) {
		t.Helper()
		select {
		case <-gone:
			if !want {
				t.Fatalf("unexpected gone signal: %s", what)
			}
		case <-time.After(400 * time.Millisecond):
			if want {
				t.Fatalf("no gone signal: %s", what)
			}
		}
	}

	expectGone(false, "resource present and streaming")
	setSnapshot() // the pod is deleted while tailing
	expectGone(true, "resource deleted from the snapshot")
	expectGone(false, "gone fires once per transition, not every tick")
	setSnapshot(pod) // a same-name re-create resumes streaming…
	expectGone(false, "resource back")
	setSnapshot() // …and a second deletion is a new transition
	expectGone(true, "second deletion")

	// Zero pods with the resource still present is the mid-rollout gap — silent by design.
	cancel()
	ctx2, cancel2 := context.WithCancel(context.Background())
	t.Cleanup(cancel2)
	gone2 := make(chan struct{}, 1)
	setSnapshot(dep) // Deployment exists, no pods yet
	go superviseLogStreams(ctx2, st, "shop", "Deployment", "web", "", false, nil, func(string) bool { return true }, lines, gone2)
	select {
	case <-gone2:
		t.Fatal("gone fired for a zero-pod gap with the resource still present")
	case <-time.After(150 * time.Millisecond):
	}
}

func TestUIDResolvers(t *testing.T) {
	obj := func(kind, ns, name, uid string) *unstructured.Unstructured {
		md := map[string]any{"name": name}
		if ns != "" {
			md["namespace"] = ns
		}
		if uid != "" {
			md["uid"] = uid
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "v1", "kind": kind, "metadata": md,
		}}
	}
	snapshot := []runtime.Object{
		obj("Pod", "shop", "web", "pod-uid"),
		obj("Node", "", "worker-1", "node-uid"),
		obj("Pod", "shop", "ghost", ""),          // no UID → not indexed
		obj("Service", "shop", "web", "svc-uid"), // non-Pod/Node → ignored
		&corev1.Pod{},                            // non-unstructured → skipped, must not panic
	}
	resolvePod, resolveNode := uidResolvers(snapshot)

	if uid, ok := resolvePod("shop", "web"); !ok || uid != "pod-uid" {
		t.Errorf("resolvePod(shop/web) = (%q, %v), want (pod-uid, true)", uid, ok)
	}
	// Namespace is part of the key: a same-named pod in another namespace must not match.
	if _, ok := resolvePod("other", "web"); ok {
		t.Error("resolvePod must key on namespace too, not name alone")
	}
	// A pod without a UID is skipped entirely (no graph node to attach usage to).
	if _, ok := resolvePod("shop", "ghost"); ok {
		t.Error("resolvePod should not resolve a UID-less pod")
	}
	// A Service named "web" must not leak into the pod resolver despite sharing the pod's name.
	if uid, _ := resolvePod("shop", "web"); uid == "svc-uid" {
		t.Error("a non-Pod must not populate the pod resolver")
	}
	if uid, ok := resolveNode("", "worker-1"); !ok || uid != "node-uid" {
		t.Errorf("resolveNode(worker-1) = (%q, %v), want (node-uid, true)", uid, ok)
	}
	if _, ok := resolveNode("", "absent"); ok {
		t.Error("resolveNode(absent) should be (_, false)")
	}
}

func TestStoppedPod(t *testing.T) {
	pod := func(phase string) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "v1", "kind": "Pod",
			"metadata": map[string]any{"name": "p"},
			"status":   map[string]any{"phase": phase},
		}}
	}
	node := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Node", "metadata": map[string]any{"name": "n"},
	}}
	cases := []struct {
		name string
		obj  runtime.Object
		want bool
	}{
		{"running pod kept", pod("Running"), false},
		{"pending pod kept", pod("Pending"), false},
		{"succeeded pod dropped", pod("Succeeded"), true},
		{"failed pod dropped", pod("Failed"), true},
		{"node never stopped", node, false},
		{"typed failed pod dropped", &corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodFailed}}, true},
		{"typed running pod kept", &corev1.Pod{Status: corev1.PodStatus{Phase: corev1.PodRunning}}, false},
	}
	for _, c := range cases {
		if got := stoppedPod(c.obj); got != c.want {
			t.Errorf("%s: stoppedPod = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestWriteHeartbeatEmitsDispatchablePing guards the sidebar-desync fix: the SSE keep-alive must be a
// dispatchable `ping` EVENT, not a comment. EventSource never surfaces comment lines to JS, so a
// comment keep-alive can't let the client tell a silently-stalled connection from a quiet one. The
// event MUST carry a `data:` line — the SSE spec dispatches an event only when its data buffer is
// non-empty, so a bare `event: ping` would be parsed and silently dropped.
func TestWriteHeartbeatEmitsDispatchablePing(t *testing.T) {
	rec := httptest.NewRecorder()
	if !writeHeartbeat(rec) {
		t.Fatal("writeHeartbeat reported failure")
	}
	got := rec.Body.String()
	if !strings.Contains(got, "event: ping\n") {
		t.Errorf("heartbeat missing `event: ping` line: %q", got)
	}
	// Dispatchability: a data line with a NON-EMPTY buffer. A `data: \n` (empty value) parses but does
	// not dispatch, so pin the exact `{}` payload — a regression that empties the buffer must fail here.
	if !strings.Contains(got, "\ndata: {}\n") {
		t.Errorf("heartbeat lacks a non-empty `data:` line, so EventSource would not dispatch it: %q", got)
	}
	if strings.HasPrefix(strings.TrimSpace(got), ":") {
		t.Errorf("heartbeat is an SSE comment, which EventSource never surfaces to JS: %q", got)
	}
}

func boolp(b bool) *bool    { return &b }
func int32p(i int32) *int32 { return &i }
