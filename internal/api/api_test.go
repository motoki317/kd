package api_test

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
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/motoki317/kd/internal/api"
	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/graph"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/rbac"
)

// ctxPath is the context segment used in every test URL below — newServer always builds an
// in-cluster registry, which serves a single cache under this sentinel name.
const ctxPath = "/api/v1/contexts/" + registry.InClusterContext

func meta(ns, name, uid string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Namespace: ns, Name: name, UID: types.UID(uid)}
}

func newServer(t *testing.T, policy string, objs ...runtime.Object) *httptest.Server {
	t.Helper()
	reg := registry.NewInCluster(fake.NewSimpleClientset(objs...), 0)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := reg.Prewarm(ctx, registry.InClusterContext); err != nil {
		t.Fatalf("prewarm registry: %v", err)
	}
	p, err := rbac.Parse(policy, "role:readonly")
	if err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	a := api.New(api.FromRegistry(reg), rbac.NewEnforcer(p))
	authCfg := auth.Config{UserHeader: "X-Forwarded-User"}
	srv := httptest.NewServer(authCfg.Middleware(a.Routes()))
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, srv *httptest.Server, path, user string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if user != "" {
		req.Header.Set("X-Forwarded-User", user)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body := make([]byte, 0)
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
	}
	return resp, body
}

var fixtureObjs = []runtime.Object{
	&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
	&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "secret-ns"}},
	&appsv1.Deployment{ObjectMeta: meta("shop", "web", "dep-uid"), Spec: appsv1.DeploymentSpec{}},
	&corev1.Pod{ObjectMeta: meta("shop", "web-1", "pod-uid"), Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	&corev1.Secret{
		ObjectMeta: meta("shop", "creds", "sec-uid"),
		Data:       map[string][]byte{"password": []byte("hunter2")},
	},
}

func TestListNamespacesRBAC(t *testing.T) {
	// dev is denied secret-ns; admin sees everything.
	srv := newServer(t, "p, dev, secret-ns, *, *, deny\ng, admin, role:admin", fixtureObjs...)

	resp, body := get(t, srv, ctxPath + "/namespaces", "dev")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var out struct {
		Namespaces []struct{ Name string } `json:"namespaces"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	names := map[string]bool{}
	for _, n := range out.Namespaces {
		names[n.Name] = true
	}
	if !names["shop"] {
		t.Error("dev should see shop")
	}
	if names["secret-ns"] {
		t.Error("dev should not see denied secret-ns")
	}

	_, adminBody := get(t, srv, ctxPath + "/namespaces", "admin")
	if !strings.Contains(string(adminBody), "secret-ns") {
		t.Error("admin should see secret-ns")
	}
}

func TestGetGraph(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath + "/namespaces/shop/graph", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var g graph.Graph
	if err := json.Unmarshal(body, &g); err != nil {
		t.Fatalf("unmarshal graph: %v\n%s", err, body)
	}
	var kinds []string
	for _, n := range g.Nodes {
		kinds = append(kinds, n.Kind)
	}
	if !contains(kinds, "Deployment") || !contains(kinds, "Pod") {
		t.Errorf("graph kinds = %v, want Deployment and Pod", kinds)
	}
}

func TestGetGraphForbidden(t *testing.T) {
	srv := newServer(t, "p, dev, secret-ns, *, *, deny", fixtureObjs...)
	resp, _ := get(t, srv, ctxPath + "/namespaces/secret-ns/graph", "dev")
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

func TestResourceDetailRedactsSecret(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath + "/namespaces/shop/resources/Secret/creds", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	if strings.Contains(string(body), "hunter2") {
		t.Errorf("secret value leaked in detail response:\n%s", body)
	}
	// Encoded form of "hunter2" must not leak either.
	if strings.Contains(string(body), "aHVudGVyMg") {
		t.Errorf("base64 secret value leaked:\n%s", body)
	}
}

func TestUnauthenticatedRejected(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, _ := get(t, srv, ctxPath + "/namespaces", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

// TestResourceEventsHandler exercises the events endpoint through HTTP, including the controller-subtree
// aggregation: a Deployment's events include its pod's event.
func TestResourceEventsHandler(t *testing.T) {
	objs := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&appsv1.Deployment{ObjectMeta: meta("shop", "web", "dep-uid")},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{
			Namespace: "shop", Name: "web-rs", UID: "rs-uid",
			OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "web", UID: "dep-uid", Controller: ptr(true)}},
		}, Spec: appsv1.ReplicaSetSpec{Replicas: ptr(int32(1))}, Status: appsv1.ReplicaSetStatus{Replicas: 1}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Namespace: "shop", Name: "web-a", UID: "pa",
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-rs", UID: "rs-uid", Controller: ptr(true)}},
		}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
		&corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Namespace: "shop", Name: "evt-1"},
			InvolvedObject: corev1.ObjectReference{Kind: "Pod", Name: "web-a", UID: "pa"},
			Reason:         "FailedScheduling", Type: corev1.EventTypeWarning, Message: "no nodes", Count: 1,
			LastTimestamp: metav1.Now(),
		},
	}
	srv := newServer(t, "", objs...)

	resp, body := get(t, srv, ctxPath + "/namespaces/shop/resources/Deployment/web/events", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Events []struct{ Reason string }
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	reasons := make([]string, len(got.Events))
	for i, e := range got.Events {
		reasons[i] = e.Reason
	}
	if !contains(reasons, "FailedScheduling") {
		t.Errorf("Deployment events = %v, want the pod's FailedScheduling (subtree aggregation)", reasons)
	}

	if resp, _ := get(t, srv, ctxPath + "/namespaces/shop/resources/Pod/nope/events", "alice"); resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing resource events status = %d, want 404", resp.StatusCode)
	}
}

func TestGraphStreamSendsSnapshot(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+ctxPath + "/namespaces/shop/graph/stream", nil)
	req.Header.Set("X-Forwarded-User", "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type = %q, want text/event-stream", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	sawSnapshot := false
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: snapshot") {
			sawSnapshot = true
			break
		}
	}
	if !sawSnapshot {
		t.Error("expected an initial 'snapshot' event on the graph stream")
	}
}

func TestLogStream(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	url := srv.URL + ctxPath + "/namespaces/shop/resources/Pod/web-1/log/stream?follow=false"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("X-Forwarded-User", "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("log stream request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	sawLog := false
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: log") {
			sawLog = true
			break
		}
	}
	if !sawLog {
		t.Error("expected a 'log' event on the pod log stream")
	}
}

// TestAggregatedLogStream verifies a workload's log stream merges its descendant pods, tagging
// each line with the source pod so the client can label them.
func TestAggregatedLogStream(t *testing.T) {
	owner := func(uid string) []metav1.OwnerReference {
		return []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-rs", UID: types.UID(uid), Controller: ptr(true)}}
	}
	objs := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&appsv1.Deployment{ObjectMeta: meta("shop", "web", "dep-uid")},
		&appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{
			Namespace: "shop", Name: "web-rs", UID: "rs-uid",
			OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "web", UID: "dep-uid", Controller: ptr(true)}},
		}, Spec: appsv1.ReplicaSetSpec{Replicas: ptr(int32(2))}, Status: appsv1.ReplicaSetStatus{Replicas: 2}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-a", UID: "pa", OwnerReferences: owner("rs-uid")}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-b", UID: "pb", OwnerReferences: owner("rs-uid")}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	}
	srv := newServer(t, "", objs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	url := srv.URL + ctxPath + "/namespaces/shop/resources/Deployment/web/log/stream?follow=false"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("X-Forwarded-User", "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("log stream request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	seenPods := map[string]bool{}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ll struct{ Pod string }
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ll) == nil && ll.Pod != "" {
			seenPods[ll.Pod] = true
		}
	}
	// The fake clientset returns a canned log line per GetLogs call, so each descendant pod
	// contributes at least one tagged line.
	if !seenPods["web-a"] || !seenPods["web-b"] {
		t.Errorf("aggregated stream covered pods %v, want both web-a and web-b", seenPods)
	}
}

func ptr[T any](v T) *T { return &v }

func TestLogStreamForbidden(t *testing.T) {
	srv := newServer(t, "p, dev, shop, logs, get, deny", fixtureObjs...)
	resp, _ := get(t, srv, ctxPath + "/namespaces/shop/resources/Pod/web-1/log/stream", "dev")
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

// TestContextsHandlerInClusterMode covers the gating contract used by the client switcher:
// in-cluster mode reports enabled=false and a single ready context, so the UI knows to hide
// the switcher (FR-001 / FR-005).
func TestContextsHandlerInClusterMode(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, "/api/v1/contexts", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var out struct {
		Enabled  bool   `json:"enabled"`
		Default  string `json:"default"`
		Contexts []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"contexts"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if out.Enabled {
		t.Error("enabled = true, want false in in-cluster mode")
	}
	if out.Default != registry.InClusterContext {
		t.Errorf("default = %q, want %q", out.Default, registry.InClusterContext)
	}
	if len(out.Contexts) != 1 || out.Contexts[0].Name != registry.InClusterContext || out.Contexts[0].Status != "ready" {
		t.Errorf("contexts = %+v, want one ready %q entry", out.Contexts, registry.InClusterContext)
	}
}

// TestUnknownContext404 ensures path-level ctx mismatches surface as 404 rather than 500,
// so a stale ?ctx= bookmark doesn't crash the client.
func TestUnknownContext404(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, _ := get(t, srv, "/api/v1/contexts/missing/namespaces", "alice")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
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
