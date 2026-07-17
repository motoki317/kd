package api

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
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

func TestLogStreamKeyIncludesNamespace(t *testing.T) {
	a := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-a", Name: "agent"}}
	b := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "team-b", Name: "agent"}}
	if logStreamKey(a) == logStreamKey(b) {
		t.Fatalf("same-named pods in different namespaces share key %q", logStreamKey(a))
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

// scanLogStream must stay quiet when the client closes the viewer (ctx cancelled → context.Canceled
// from the body read) — that is normal teardown on every tailed pod/container, not an anomaly. It must
// still warn on a genuine abnormal end (an oversized line → bufio.ErrTooLong; a mid-stream read
// failure) so a truncated stream stays diagnosable. Reproduces the "log stream ended early
// err=context canceled" warning spam seen on open/close.
func TestScanLogStreamEndReporting(t *testing.T) {
	pod := &corev1.Pod{}
	pod.Namespace, pod.Name = "team-a", "api-b-0"

	cases := []struct {
		name     string
		reader   func(ctx context.Context) io.Reader
		cancel   bool // cancel ctx before scanning (client closed the viewer)
		wantWarn bool
	}{
		{
			name:     "client closed viewer: context canceled stays quiet",
			reader:   func(ctx context.Context) io.Reader { return blockUntilCancelled{ctx} },
			cancel:   true,
			wantWarn: false,
		},
		{
			name:     "normal EOF stays quiet",
			reader:   func(context.Context) io.Reader { return strings.NewReader("line one\nline two\n") },
			wantWarn: false,
		},
		{
			name:     "oversized line warns (bufio.ErrTooLong)",
			reader:   func(context.Context) io.Reader { return strings.NewReader(strings.Repeat("x", 2*1024*1024)) },
			wantWarn: true,
		},
		{
			name: "mid-stream read failure warns",
			reader: func(context.Context) io.Reader {
				return io.MultiReader(strings.NewReader("partial"), errReader{io.ErrUnexpectedEOF})
			},
			wantWarn: true,
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
			scanLogStream(ctx, c.reader(ctx), pod, "api-b", false, out)
			close(out)
			<-done

			gotWarn := strings.Contains(buf.String(), "log stream ended early")
			if gotWarn != c.wantWarn {
				t.Errorf("warning emitted = %v, want %v\nlog: %s", gotWarn, c.wantWarn, buf.String())
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
