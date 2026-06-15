package api

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

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
