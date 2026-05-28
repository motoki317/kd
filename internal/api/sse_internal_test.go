package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/rbac"
)

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
	client := fake.NewSimpleClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web", UID: "dep-uid"}},
		&appsv1.ReplicaSet{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-rs", UID: "rs-uid",
				OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "web", UID: "dep-uid", Controller: boolp(true)}}},
			Spec:   appsv1.ReplicaSetSpec{Replicas: int32p(2)},
			Status: appsv1.ReplicaSetStatus{Replicas: 2},
		},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-a", UID: "pa", OwnerReferences: rsOwner}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	)

	reg := registry.NewInCluster(client, 0)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := reg.Prewarm(ctx, registry.InClusterContext); err != nil {
		t.Fatalf("prewarm registry: %v", err)
	}
	p, err := rbac.Parse("", "role:readonly")
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
				_, err := client.CoreV1().Pods("shop").Create(ctx,
					&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-b", UID: "pb", OwnerReferences: rsOwner}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
					metav1.CreateOptions{})
				if err != nil {
					t.Fatalf("create web-b: %v", err)
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

func boolp(b bool) *bool    { return &b }
func int32p(i int32) *int32 { return &i }
