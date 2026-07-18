package api

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

func TestPodsForResourceMatchesDescendantsByNamespaceAndName(t *testing.T) {
	owner := []metav1.OwnerReference{{
		APIVersion: "v1", Kind: "Node", Name: "node-a", UID: "node-a-uid", Controller: boolp(true),
	}}
	objs := []runtime.Object{
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-a", UID: "node-a-uid"}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Namespace: "team-a", Name: "agent", UID: types.UID("team-a-agent-uid"), OwnerReferences: owner,
		}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Namespace: "team-b", Name: "agent", UID: types.UID("team-b-agent-uid"),
		}},
	}

	pods, rootExists := podsForResource(objs, "Node", "node-a")
	if !rootExists {
		t.Fatal("node-a must resolve")
	}
	if len(pods) != 1 || pods[0].Namespace != "team-a" || pods[0].Name != "agent" {
		t.Fatalf("resolved pods = %s, want only team-a/agent", podNames(pods))
	}
}

func TestLogStreamKeyIncludesPodUIDAndContainer(t *testing.T) {
	a := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "agent", UID: "agent-a-uid"}}
	b := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "agent", UID: "agent-b-uid"}}
	if logStreamKey(a, "main") == logStreamKey(b, "main") {
		t.Fatalf("same-named pods with different UIDs share key %q", logStreamKey(a, "main"))
	}
	if logStreamKey(a, "main") == logStreamKey(a, "sidecar") {
		t.Fatalf("different containers share key %q", logStreamKey(a, "main"))
	}
}

func useFastLogResolveInterval(t *testing.T) {
	t.Helper()
	saved := logResolveInterval
	logResolveInterval = 20 * time.Millisecond
	t.Cleanup(func() { logResolveInterval = saved })
}

func newLogStreamTestClient(t *testing.T, transport roundTripFunc) kubernetes.Interface {
	t.Helper()
	client, err := kubernetes.NewForConfigAndClient(
		&rest.Config{Host: "https://example.invalid"},
		&http.Client{Transport: transport},
	)
	if err != nil {
		t.Fatalf("create Kubernetes client: %v", err)
	}
	return client
}

func testLogPod(uid types.UID, phase corev1.PodPhase, containers ...string) *corev1.Pod {
	specContainers := make([]corev1.Container, 0, len(containers))
	for _, name := range containers {
		specContainers = append(specContainers, corev1.Container{Name: name})
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "shop-0", UID: uid},
		Spec:       corev1.PodSpec{Containers: specContainers},
		Status:     corev1.PodStatus{Phase: phase},
	}
}

func testLogPodWithContainerStatus(uid types.UID, phase corev1.PodPhase, container string, state corev1.ContainerState, restartCount int32) *corev1.Pod {
	pod := testLogPod(uid, phase, container)
	pod.Status.ContainerStatuses = []corev1.ContainerStatus{{
		Name: container, State: state, RestartCount: restartCount,
	}}
	return pod
}

func testLogPodWithInitContainerStatus(uid types.UID, phase corev1.PodPhase, container string, state corev1.ContainerState, restartCount int32) *corev1.Pod {
	pod := testLogPod(uid, phase, "main")
	pod.Spec.InitContainers = []corev1.Container{{Name: container}}
	pod.Status.InitContainerStatuses = []corev1.ContainerStatus{{
		Name: container, State: state, RestartCount: restartCount,
	}}
	return pod
}

func startSupervisedPodLogs(t *testing.T, st Store, pod *corev1.Pod, container string) <-chan logLine {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	lines := make(chan logLine, 8)
	go superviseLogStreams(ctx, st, pod.Namespace, "Pod", pod.Name, container, false, nil, func(string) bool { return true }, lines, nil)
	return lines
}

func waitForFreshLogResolves(t *testing.T, resolved <-chan struct{}, count int) {
	t.Helper()
	for {
		select {
		case <-resolved:
			continue
		default:
		}
		break
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for range count {
		select {
		case <-resolved:
		case <-timer.C:
			t.Fatalf("timed out waiting for %d fresh log resolutions", count)
		}
	}
}

func TestSuperviseLogStreamsDoesNotRedumpCompletedPod(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requestCount := 0
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requestCount++
		mu.Unlock()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(strings.NewReader("finished once\n")),
			Request:    r,
		}, nil
	}))
	pod := testLogPod("shop-0-uid", corev1.PodSucceeded, "main")
	resolved := make(chan struct{}, 16)
	st := &stubLogStore{
		objs: func() []runtime.Object {
			resolved <- struct{}{}
			return []runtime.Object{pod}
		},
		client: client,
	}
	lines := startSupervisedPodLogs(t, st, pod, "")

	select {
	case got := <-lines:
		if got.Line != "finished once" {
			t.Fatalf("first line = %q, want %q", got.Line, "finished once")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for completed pod log")
	}

	waitForFreshLogResolves(t, resolved, 5)
	mu.Lock()
	gotRequests := requestCount
	mu.Unlock()
	if gotRequests != 1 {
		t.Fatalf("GetLogs requests = %d after repeated resolutions, want 1", gotRequests)
	}
	select {
	case got := <-lines:
		t.Fatalf("completed pod log repeated as %q", got.Line)
	default:
	}
}

func TestSuperviseLogStreamsReattachesCrashloopOnlyAfterNewContainerInstance(t *testing.T) {
	cases := []struct {
		name      string
		state     corev1.ContainerState
		container string
		pod       func(corev1.ContainerState, int32) *corev1.Pod
	}{
		{
			name:      "waiting in backoff",
			state:     corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			container: "main",
			pod: func(state corev1.ContainerState, restartCount int32) *corev1.Pod {
				return testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", state, restartCount)
			},
		},
		{
			name:      "terminated sidecar",
			state:     corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error"}},
			container: "main",
			pod: func(state corev1.ContainerState, restartCount int32) *corev1.Pod {
				return testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", state, restartCount)
			},
		},
		{
			name:      "waiting init container",
			state:     corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}},
			container: "setup",
			pod: func(state corev1.ContainerState, restartCount int32) *corev1.Pod {
				return testLogPodWithInitContainerStatus("shop-0-uid", corev1.PodRunning, "setup", state, restartCount)
			},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			useFastLogResolveInterval(t)

			var mu sync.Mutex
			requestCount := 0
			generation := int32(1)
			current := c.pod(c.state, generation)
			client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
				mu.Lock()
				requestCount++
				restartCount := generation
				mu.Unlock()
				var body io.Reader = strings.NewReader("instance one\n")
				if restartCount == 2 {
					body = io.MultiReader(strings.NewReader("instance two\n"), blockUntilCancelled{r.Context()})
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/plain"}},
					Body:       io.NopCloser(body),
					Request:    r,
				}, nil
			}))
			resolved := make(chan struct{}, 16)
			st := &stubLogStore{
				objs: func() []runtime.Object {
					mu.Lock()
					pod := current
					mu.Unlock()
					resolved <- struct{}{}
					return []runtime.Object{pod}
				},
				client: client,
			}
			lines := startSupervisedPodLogs(t, st, current, c.container)

			select {
			case got := <-lines:
				if got.Line != "instance one" {
					t.Fatalf("first line = %q, want %q", got.Line, "instance one")
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for first container instance log")
			}

			waitForFreshLogResolves(t, resolved, 5)
			mu.Lock()
			gotRequests := requestCount
			mu.Unlock()
			if gotRequests != 1 {
				t.Fatalf("GetLogs requests = %d while restart generation was unchanged, want 1", gotRequests)
			}

			mu.Lock()
			generation = 2
			current = c.pod(corev1.ContainerState{
				Running: &corev1.ContainerStateRunning{},
			}, generation)
			mu.Unlock()
			select {
			case got := <-lines:
				if got.Line != "instance two" {
					t.Fatalf("new instance line = %q, want %q", got.Line, "instance two")
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for new container instance log")
			}
			mu.Lock()
			gotRequests = requestCount
			mu.Unlock()
			if gotRequests != 2 {
				t.Fatalf("GetLogs requests = %d after new container instance, want 2", gotRequests)
			}
		})
	}
}

func TestSuperviseLogStreamsReattachesWhenDrainedGenerationMayHaveMoreLogs(t *testing.T) {
	cases := []struct {
		name string
		next func() *corev1.Pod
	}{
		{
			name: "running at same restart count",
			next: func() *corev1.Pod {
				return testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", corev1.ContainerState{
					Running: &corev1.ContainerStateRunning{},
				}, 4)
			},
		},
		{
			name: "container status missing",
			next: func() *corev1.Pod {
				return testLogPod("shop-0-uid", corev1.PodRunning, "main")
			},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			useFastLogResolveInterval(t)

			var mu sync.Mutex
			requestCount := 0
			current := testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", corev1.ContainerState{
				Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"},
			}, 4)
			client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
				mu.Lock()
				requestCount++
				attempt := requestCount
				mu.Unlock()
				var body io.Reader = strings.NewReader("drained generation\n")
				if attempt > 1 {
					body = io.MultiReader(strings.NewReader("eligible tail\n"), blockUntilCancelled{r.Context()})
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"text/plain"}},
					Body:       io.NopCloser(body),
					Request:    r,
				}, nil
			}))
			resolved := make(chan struct{}, 16)
			st := &stubLogStore{
				objs: func() []runtime.Object {
					mu.Lock()
					pod := current
					mu.Unlock()
					resolved <- struct{}{}
					return []runtime.Object{pod}
				},
				client: client,
			}
			lines := startSupervisedPodLogs(t, st, current, "")

			select {
			case got := <-lines:
				if got.Line != "drained generation" {
					t.Fatalf("first line = %q, want %q", got.Line, "drained generation")
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for drained generation log")
			}
			waitForFreshLogResolves(t, resolved, 5)
			mu.Lock()
			gotRequests := requestCount
			mu.Unlock()
			if gotRequests != 1 {
				t.Fatalf("GetLogs requests = %d before status transition, want 1", gotRequests)
			}

			mu.Lock()
			current = c.next()
			mu.Unlock()
			select {
			case got := <-lines:
				if got.Line != "eligible tail" {
					t.Fatalf("eligible line = %q, want %q", got.Line, "eligible tail")
				}
			case <-time.After(time.Second):
				t.Fatal("timed out waiting for eligible same-generation tail")
			}
			mu.Lock()
			gotRequests = requestCount
			mu.Unlock()
			if gotRequests != 2 {
				t.Fatalf("GetLogs requests = %d after eligible transition, want 2", gotRequests)
			}
		})
	}
}

func TestSuperviseLogStreamsStreamsSameNameReplacementPod(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requestCount := 0
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requestCount++
		line := "first run\n"
		if requestCount > 1 {
			line = "replacement run\n"
		}
		mu.Unlock()
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(strings.NewReader(line)),
			Request:    r,
		}, nil
	}))
	pod := func(uid types.UID) *corev1.Pod {
		return testLogPod(uid, corev1.PodSucceeded, "main")
	}
	current := pod("first-uid")
	st := &stubLogStore{
		objs: func() []runtime.Object {
			mu.Lock()
			defer mu.Unlock()
			return []runtime.Object{current}
		},
		client: client,
	}
	lines := startSupervisedPodLogs(t, st, current, "")

	select {
	case got := <-lines:
		if got.Line != "first run" {
			t.Fatalf("first pod line = %q, want %q", got.Line, "first run")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first pod log")
	}
	mu.Lock()
	current = pod("replacement-uid")
	mu.Unlock()

	select {
	case got := <-lines:
		if got.Line != "replacement run" {
			t.Fatalf("replacement pod line = %q, want %q", got.Line, "replacement run")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for same-name replacement pod log")
	}
}

func TestSuperviseLogStreamsReattachesRunningPodAfterCleanEOF(t *testing.T) {
	useFastLogResolveInterval(t)

	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(strings.NewReader("running attempt\n")),
			Request:    r,
		}, nil
	}))
	pod := testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", corev1.ContainerState{
		Running: &corev1.ContainerStateRunning{},
	}, 4)
	st := &stubLogStore{objs: func() []runtime.Object { return []runtime.Object{pod} }, client: client}
	lines := startSupervisedPodLogs(t, st, pod, "")

	for attempt := 1; attempt <= 2; attempt++ {
		select {
		case got := <-lines:
			if got.Line != "running attempt" {
				t.Fatalf("attempt %d line = %q, want %q", attempt, got.Line, "running attempt")
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for running pod log attempt %d", attempt)
		}
	}
}

func TestSuperviseLogStreamsReattachesAfterRunningContainerTerminatesAtSameRestartCount(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requestCount := 0
	current := testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", corev1.ContainerState{
		Running: &corev1.ContainerStateRunning{},
	}, 4)
	releaseFirstEOF := make(chan struct{})
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requestCount++
		attempt := requestCount
		mu.Unlock()
		var body io.Reader = strings.NewReader("final tail\n")
		if attempt == 1 {
			body = io.MultiReader(strings.NewReader("running prefix\n"), eofAfter{releaseFirstEOF})
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(body),
			Request:    r,
		}, nil
	}))
	resolved := make(chan struct{}, 16)
	st := &stubLogStore{
		objs: func() []runtime.Object {
			mu.Lock()
			pod := current
			mu.Unlock()
			resolved <- struct{}{}
			return []runtime.Object{pod}
		},
		client: client,
	}
	lines := startSupervisedPodLogs(t, st, current, "")

	select {
	case got := <-lines:
		if got.Line != "running prefix" {
			t.Fatalf("running line = %q, want %q", got.Line, "running prefix")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for running container log")
	}
	mu.Lock()
	current = testLogPodWithContainerStatus("shop-0-uid", corev1.PodRunning, "main", corev1.ContainerState{
		Terminated: &corev1.ContainerStateTerminated{Reason: "Error"},
	}, 4)
	mu.Unlock()
	close(releaseFirstEOF)

	select {
	case got := <-lines:
		if got.Line != "final tail" {
			t.Fatalf("final line = %q, want %q", got.Line, "final tail")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for final same-generation tail")
	}
	waitForFreshLogResolves(t, resolved, 5)
	mu.Lock()
	gotRequests := requestCount
	mu.Unlock()
	if gotRequests != 2 {
		t.Fatalf("GetLogs requests = %d after final tail drain, want 2", gotRequests)
	}
}

func TestSuperviseLogStreamsRetriesCompletedPodAfterOpenFailure(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requestCount := 0
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requestCount++
		attempt := requestCount
		mu.Unlock()
		status := http.StatusOK
		body := "retried log\n"
		if attempt == 1 {
			status = http.StatusInternalServerError
			body = "open failed"
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	}))
	pod := testLogPod("shop-0-uid", corev1.PodFailed, "main")
	st := &stubLogStore{objs: func() []runtime.Object { return []runtime.Object{pod} }, client: client}
	lines := startSupervisedPodLogs(t, st, pod, "")

	select {
	case got := <-lines:
		if got.Line != "retried log" {
			t.Fatalf("line after retry = %q, want %q", got.Line, "retried log")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for retry after log stream open failure")
	}
	mu.Lock()
	gotRequests := requestCount
	mu.Unlock()
	if gotRequests < 2 {
		t.Fatalf("GetLogs requests = %d, want at least 2", gotRequests)
	}
}

func TestSuperviseLogStreamsRetriesCompletedPodAfterScanError(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requestCount := 0
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		requestCount++
		attempt := requestCount
		mu.Unlock()
		var body io.ReadCloser
		if attempt == 1 {
			body = io.NopCloser(io.MultiReader(
				strings.NewReader("truncated line\n"),
				errReader{io.ErrUnexpectedEOF},
			))
		} else {
			body = io.NopCloser(strings.NewReader("complete after scan error\n"))
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       body,
			Request:    r,
		}, nil
	}))
	pod := testLogPod("shop-0-uid", corev1.PodFailed, "main")
	st := &stubLogStore{objs: func() []runtime.Object { return []runtime.Object{pod} }, client: client}
	lines := startSupervisedPodLogs(t, st, pod, "")

	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	retriedLine := false
	for !retriedLine {
		select {
		case got := <-lines:
			retriedLine = got.Line == "complete after scan error"
		case <-timer.C:
			t.Fatal("timed out waiting for retry after log stream scan error")
		}
	}
	mu.Lock()
	gotRequests := requestCount
	mu.Unlock()
	if gotRequests < 2 {
		t.Fatalf("GetLogs requests = %d, want at least 2", gotRequests)
	}
}

func TestSuperviseLogStreamsRetriesFailedAllContainerTargetIndependently(t *testing.T) {
	useFastLogResolveInterval(t)

	var mu sync.Mutex
	requests := map[string]int{}
	requested := make(chan struct{}, 8)
	client := newLogStreamTestClient(t, roundTripFunc(func(r *http.Request) (*http.Response, error) {
		container := r.URL.Query().Get("container")
		mu.Lock()
		requests[container]++
		attempt := requests[container]
		mu.Unlock()
		requested <- struct{}{}
		status := http.StatusOK
		body := container + " log\n"
		if container == "sidecar" && attempt == 1 {
			status = http.StatusInternalServerError
			body = "open failed"
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": []string{"text/plain"}},
			Body:       io.NopCloser(strings.NewReader(body)),
			Request:    r,
		}, nil
	}))
	pod := testLogPod("shop-0-uid", corev1.PodFailed, "main", "sidecar")
	resolved := make(chan struct{}, 16)
	st := &stubLogStore{
		objs: func() []runtime.Object {
			resolved <- struct{}{}
			return []runtime.Object{pod}
		},
		client: client,
	}
	startSupervisedPodLogs(t, st, pod, allContainers)

	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		mu.Lock()
		retriedFailedTarget := requests["sidecar"] >= 2
		mu.Unlock()
		if retriedFailedTarget {
			break
		}
		select {
		case <-requested:
		case <-timer.C:
			t.Fatal("timed out waiting for failed sidecar log target to retry")
		}
	}
	waitForFreshLogResolves(t, resolved, 5)
	mu.Lock()
	gotMain, gotSidecar := requests["main"], requests["sidecar"]
	mu.Unlock()
	if gotMain != 1 || gotSidecar != 2 {
		t.Fatalf("GetLogs requests = main:%d sidecar:%d, want main:1 sidecar:2", gotMain, gotSidecar)
	}
}

func podNames(pods []*corev1.Pod) []string {
	names := make([]string, 0, len(pods))
	for _, pod := range pods {
		names = append(names, pod.Namespace+"/"+pod.Name)
	}
	return names
}

// blockUntilCancelled is a log stream that blocks on Read until ctx is cancelled, then surfaces
// ctx.Err() — exactly how a kube GetLogs body read behaves when the client closes the viewer and the
// request context is cancelled.
type blockUntilCancelled struct{ ctx context.Context }

func (r blockUntilCancelled) Read([]byte) (int, error) {
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}

type eofAfter struct{ done <-chan struct{} }

func (r eofAfter) Read([]byte) (int, error) {
	<-r.done
	return 0, io.EOF
}

// scanLogStream must stay quiet when the client closes the viewer (ctx cancelled → context.Canceled
// from the body read) — that is normal teardown on every tailed pod/container, not an anomaly. It must
// still warn on a genuine abnormal end (an oversized line → bufio.ErrTooLong; a mid-stream read
// failure) so a truncated stream stays diagnosable. Reproduces the "log stream ended early
// err=context canceled" warning spam seen on open/close.
func TestScanLogStreamEndReporting(t *testing.T) {
	pod := &corev1.Pod{}
	pod.Namespace, pod.Name = "team-a", "api-b-0"

	cases := []struct {
		name         string
		reader       func(ctx context.Context) io.Reader
		cancel       bool // cancel ctx before scanning (client closed the viewer)
		wantWarn     bool
		wantCleanEOF bool
	}{
		{
			name:         "client closed viewer: context canceled stays quiet",
			reader:       func(ctx context.Context) io.Reader { return blockUntilCancelled{ctx} },
			cancel:       true,
			wantWarn:     false,
			wantCleanEOF: false,
		},
		{
			name:         "normal EOF stays quiet",
			reader:       func(context.Context) io.Reader { return strings.NewReader("line one\nline two\n") },
			wantWarn:     false,
			wantCleanEOF: true,
		},
		{
			name:         "oversized line warns (bufio.ErrTooLong)",
			reader:       func(context.Context) io.Reader { return strings.NewReader(strings.Repeat("x", 2*1024*1024)) },
			wantWarn:     true,
			wantCleanEOF: false,
		},
		{
			name: "mid-stream read failure warns",
			reader: func(context.Context) io.Reader {
				return io.MultiReader(strings.NewReader("partial"), errReader{io.ErrUnexpectedEOF})
			},
			wantWarn:     true,
			wantCleanEOF: false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
			defer slog.SetDefault(prev)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if c.cancel {
				cancel()
			}

			out := make(chan logLine, 16)
			done := make(chan struct{})
			go func() {
				for range out {
				}
				close(done)
			}()
			gotCleanEOF := scanLogStream(ctx, c.reader(ctx), pod, "api-b", false, out)
			close(out)
			<-done

			gotWarn := strings.Contains(buf.String(), "log stream ended early")
			if gotWarn != c.wantWarn {
				t.Errorf("warning emitted = %v, want %v\nlog: %s", gotWarn, c.wantWarn, buf.String())
			}
			if gotCleanEOF != c.wantCleanEOF {
				t.Errorf("clean EOF = %v, want %v", gotCleanEOF, c.wantCleanEOF)
			}
		})
	}
}

// errReader yields its error on the first Read, simulating a stream that fails partway.
type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

// defaultLogContainer prefers a container named "main" (the Argo Workflows step that does the real
// work, behind a `wait` executor sidecar) so a workflow pod's logs aren't just executor noise; it
// falls back to the first container for an ordinary app+sidecar pod.
func TestDefaultLogContainer(t *testing.T) {
	pod := func(names ...string) *corev1.Pod {
		var cs []corev1.Container
		for _, n := range names {
			cs = append(cs, corev1.Container{Name: n})
		}
		return &corev1.Pod{Spec: corev1.PodSpec{Containers: cs}}
	}
	cases := []struct {
		name string
		pod  *corev1.Pod
		want string
	}{
		{"argo: wait first, main second → main", pod("wait", "main"), "main"},
		{"app+sidecar, no main → first container", pod("app", "istio-proxy"), "app"},
		{"single container → it", pod("app"), "app"},
		{"no containers → empty", pod(), ""},
	}
	for _, c := range cases {
		if got := defaultLogContainer(c.pod); got != c.want {
			t.Errorf("%s: defaultLogContainer = %q, want %q", c.name, got, c.want)
		}
	}
}

// parseTail maps the ?tail= query value to an optional line count. A bad or negative value must read
// as "unset" (nil) — same as omitting it — so a malformed client param falls back to the server
// default rather than erroring or streaming a negative tail.
func TestParseTail(t *testing.T) {
	cases := []struct {
		in   string
		want *int64
	}{
		{"", nil},         // omitted → default
		{"100", ptr(100)}, // explicit count
		{"0", ptr(0)},     // zero is valid (tail nothing, then follow)
		{"-5", nil},       // negative → unset, not a negative tail
		{"abc", nil},      // non-numeric → unset
		{"12x", nil},      // trailing garbage → unset (not a half-parsed 12)
		{" 12 ", nil},     // surrounding whitespace → unset
		{"0x10", nil},     // hex → unset (not 16)
	}
	for _, c := range cases {
		got := parseTail(c.in)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("parseTail(%q) = %d, want nil", c.in, *got)
		case c.want != nil && got == nil:
			t.Errorf("parseTail(%q) = nil, want %d", c.in, *c.want)
		case c.want != nil && got != nil && *got != *c.want:
			t.Errorf("parseTail(%q) = %d, want %d", c.in, *got, *c.want)
		}
	}
}

func ptr(n int64) *int64 { return &n }
