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
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/motoki317/kd/internal/api"
	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/kube/discovery"
	"github.com/motoki317/kd/internal/kube/graph"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/kube/store"
	"github.com/motoki317/kd/internal/rbac"
)

// ctxPath is the context segment used in every test URL below — newServer always builds an
// in-cluster registry, which serves a single cache under this sentinel name.
const ctxPath = "/api/v1/contexts/" + registry.InClusterContext

func meta(ns, name, uid string) metav1.ObjectMeta {
	return metav1.ObjectMeta{Namespace: ns, Name: name, UID: types.UID(uid)}
}

// fixtureResources is the closed GVR set the api tests inject through a static discoverer,
// covering every kind referenced by fixtureObjs and the events/logs endpoints.
var fixtureResources = []discovery.Resource{
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}, Kind: "Namespace", Namespaced: false},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "nodes"}, Kind: "Node", Namespaced: false},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}, Kind: "Pod", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "services"}, Kind: "Service", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"}, Kind: "ConfigMap", Namespaced: true, ShortNames: []string{"cm"}},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}, Kind: "Secret", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "", Version: "v1", Resource: "events"}, Kind: "Event", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, Kind: "Deployment", Namespaced: true},
	{GVR: schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}, Kind: "ReplicaSet", Namespaced: true},
}

// newServer builds an in-cluster registry over a fake typed clientset (for log streaming)
// and a fake dynamic clientset (for cached reads), then prewarms it and wires the API. The
// static discoverer is required because the fake typed clientset's discovery returns nil
// for ServerPreferredResources — we have to inject the GVR set explicitly. policy is a
// policy.yaml document; empty means the built-in default (every user is a viewer).
func newServer(t *testing.T, policy string, objs ...runtime.Object) *httptest.Server {
	t.Helper()
	typed := fake.NewSimpleClientset(objs...)
	dyn := dynamicfake.NewSimpleDynamicClient(scheme.Scheme, objs...)
	// Events are deliberately NOT eager-loaded (DefaultSkipKinds); the events handler queries them
	// live from the API server, so the events-tab test reads them straight from the typed fake — no
	// EagerKinds workaround needed (its absence here is what proves the live-query path works in
	// production, where events are skipped). Discoverer overrides the fake clientset's empty discovery.
	opts := store.Options{
		Discoverer: discovery.Static(fixtureResources),
	}
	reg := registry.NewInCluster(registry.Clients{Typed: typed, Dynamic: dyn}, 0, opts)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := reg.Prewarm(ctx, registry.InClusterContext); err != nil {
		t.Fatalf("prewarm registry: %v", err)
	}
	p, err := rbac.Parse([]byte(policy))
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
	srv := newServer(t, `
roles:
  no-secret-ns:
    deny:
      - namespaces: [secret-ns]
users:
  dev: [no-secret-ns]
  admin: [admin]
`, fixtureObjs...)

	resp, body := get(t, srv, ctxPath+"/namespaces", "dev")
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

	_, adminBody := get(t, srv, ctxPath+"/namespaces", "admin")
	if !strings.Contains(string(adminBody), "secret-ns") {
		t.Error("admin should see secret-ns")
	}
}

func TestGetGraph(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/namespaces/shop/graph", "alice")
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
	srv := newServer(t, `
roles:
  no-secret-ns:
    deny:
      - namespaces: [secret-ns]
users:
  dev: [no-secret-ns]
`, fixtureObjs...)
	resp, _ := get(t, srv, ctxPath+"/namespaces/secret-ns/graph", "dev")
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

func TestResourceDetailRedactsSecret(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/namespaces/shop/resources/Secret/creds", "alice")
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
	resp, _ := get(t, srv, ctxPath+"/namespaces", "")
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

	resp, body := get(t, srv, ctxPath+"/namespaces/shop/resources/Deployment/web/events", "alice")
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

	if resp, _ := get(t, srv, ctxPath+"/namespaces/shop/resources/Pod/nope/events", "alice"); resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing resource events status = %d, want 404", resp.StatusCode)
	}
}

// TestEventStreamSendsEvents verifies the SSE events feed sends an initial `events` frame carrying
// the subtree-aggregated list (the Deployment's stream includes its pod's FailedScheduling), so the
// drawer holds one connection instead of polling the REST endpoint.
func TestEventStreamSendsEvents(t *testing.T) {
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
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+ctxPath+"/namespaces/shop/resources/Deployment/web/events/stream", nil)
	req.Header.Set("X-Forwarded-User", "alice")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("event stream request: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type = %q, want text/event-stream", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	sawEvents, sawReason := false, false
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "event: events") {
			sawEvents = true
		}
		if strings.HasPrefix(line, "data: ") && strings.Contains(line, "FailedScheduling") {
			sawReason = true
		}
		if sawEvents && sawReason {
			break
		}
	}
	if !sawEvents {
		t.Error("expected an initial 'events' event on the event stream")
	}
	if !sawReason {
		t.Error("expected the subtree-aggregated FailedScheduling event in the stream payload")
	}
}

// TestNamespacesStreamSendsSnapshot verifies the namespaces SSE feed sends an initial `namespaces`
// frame with the RBAC-filtered list, so the sidebar holds one connection instead of polling /namespaces.
func TestNamespacesStreamSendsSnapshot(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+ctxPath+"/namespaces/stream", nil)
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
	sawEvent, sawShop := false, false
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "event: namespaces") {
			sawEvent = true
		}
		if strings.HasPrefix(line, "data: ") && strings.Contains(line, "\"shop\"") {
			sawShop = true
		}
		if sawEvent && sawShop {
			break
		}
	}
	if !sawEvent {
		t.Error("expected an initial 'namespaces' event on the namespaces stream")
	}
	if !sawShop {
		t.Error("expected the visible namespace 'shop' in the stream payload")
	}
}

func TestGraphStreamSendsSnapshot(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+ctxPath+"/namespaces/shop/graph/stream", nil)
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
	sawSnapshot, sawSummary := false, false
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: snapshot") {
			sawSnapshot = true
		}
		// The summary event lets the sidebar override the streamed /namespaces health from the
		// UNFILTERED graph — so the sidebar can't disagree with /namespaces just because the
		// current view filtered out a degraded resource.
		if strings.HasPrefix(sc.Text(), "event: summary") {
			sawSummary = true
		}
		if sawSnapshot && sawSummary {
			break
		}
	}
	if !sawSnapshot {
		t.Error("expected an initial 'snapshot' event on the graph stream")
	}
	if !sawSummary {
		t.Error("expected a 'summary' event on the graph stream")
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

// TestClusterScopedLogStream verifies a cluster-scoped resource's logs resolve through the cluster
// sentinel: a control-plane Node owns its static pods (mirror-pod ownerReferences), and those pods
// are namespaced — absent from the cluster-scope snapshot — so the handler must merge cluster-wide
// pods in or the Node's Logs tab waits on "no pods" forever.
func TestClusterScopedLogStream(t *testing.T) {
	objs := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system"}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "cp-1", UID: "node-uid"}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Namespace: "kube-system", Name: "etcd-cp-1", UID: "etcd-uid",
			OwnerReferences: []metav1.OwnerReference{{Kind: "Node", Name: "cp-1", UID: "node-uid", Controller: ptr(true)}},
		}, Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	}
	srv := newServer(t, "", objs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	url := srv.URL + ctxPath + "/namespaces/" + api.ClusterScopeNamespace + "/resources/Node/cp-1/log/stream?follow=false"
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
		t.Error("expected a 'log' event for the Node's static pod via the cluster scope")
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

// TestAllContainersLogStream verifies a single multi-container pod's __all__ stream fans out one
// streamer per app container, tagging each line with its source container so the client can label and
// timestamp-order the merged view.
func TestAllContainersLogStream(t *testing.T) {
	objs := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Namespace: "shop", Name: "web-1", UID: "p1"},
			Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}, {Name: "sidecar"}}},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning},
		},
	}
	srv := newServer(t, "", objs...)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	url := srv.URL + ctxPath + "/namespaces/shop/resources/Pod/web-1/log/stream?follow=false&container=__all__"
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
	seen := map[string]bool{}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var ll struct{ Container string }
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ll) == nil && ll.Container != "" {
			seen[ll.Container] = true
		}
		if seen["app"] && seen["sidecar"] {
			break
		}
	}
	if !seen["app"] || !seen["sidecar"] {
		t.Errorf("all-containers stream tagged containers %v, want both app and sidecar", seen)
	}
}

func ptr[T any](v T) *T { return &v }

// denyShopLogsYAML denies the `logs` resource in the shop namespace to user dev, on top of
// the viewer default — the namespace-scoped log-deny shape both log tests below need.
const denyShopLogsYAML = `
roles:
  no-shop-logs:
    deny:
      - namespaces: [shop]
        resources: [logs]
users:
  dev: [no-shop-logs]
`

func TestLogStreamForbidden(t *testing.T) {
	srv := newServer(t, denyShopLogsYAML, fixtureObjs...)
	resp, _ := get(t, srv, ctxPath+"/namespaces/shop/resources/Pod/web-1/log/stream", "dev")
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

// TestClusterScopeLogStreamRespectsNamespaceDeny guards the cluster-scope log path against an RBAC
// bypass: the path merges pods from every namespace (a Node's static pods ride along), but the
// request is authorized only against the cluster scope. A pod whose namespace the caller is denied
// `logs` on must NOT stream just because it was addressed through `__cluster__`. dev is allowed the
// cluster scope (viewer default) but denied shop logs, so the cluster-scope request returns 200
// (cluster logs are permitted) yet yields NO log event for the shop pod web-1.
func TestClusterScopeLogStreamRespectsNamespaceDeny(t *testing.T) {
	srv := newServer(t, denyShopLogsYAML, fixtureObjs...)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	url := srv.URL + ctxPath + "/namespaces/" + api.ClusterScopeNamespace + "/resources/Pod/web-1/log/stream?follow=false"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("X-Forwarded-User", "dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("log stream request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (cluster-scope logs are allowed)", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: log") {
			t.Fatal("streamed a shop pod's logs via the cluster scope despite a shop logs deny — RBAC bypass")
		}
		if strings.HasPrefix(sc.Text(), "event: done") {
			break // one-shot dump finished with no pods, as expected
		}
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

// TestKindsHandler covers the /kinds discovery endpoint the client uses to label cards with the
// cluster's own abbreviations: kinds the API gives a short name appear, kinds without are absent.
func TestKindsHandler(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/kinds", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var out struct {
		ShortNames map[string]string `json:"shortNames"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if out.ShortNames["ConfigMap"] != "cm" {
		t.Errorf("ConfigMap short = %q, want %q", out.ShortNames["ConfigMap"], "cm")
	}
	if _, ok := out.ShortNames["Secret"]; ok {
		t.Errorf("Secret should be absent (no API short name), got %q", out.ShortNames["Secret"])
	}
}

// TestUnknownContext404 ensures path-level ctx mismatches surface as 404 rather than 500,
// so a stale ?ctx= bookmark doesn't crash the client.
// TestNamespacesIncludesClusterPseudoEntry covers FR-004: the [cluster] pseudo-namespace
// is listed alongside real namespaces (pinned first by handleNamespaces) so the client can
// surface it in the sidebar without the operator having to know the sentinel name.
func TestNamespacesIncludesClusterPseudoEntry(t *testing.T) {
	srv := newServer(t, "", fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/namespaces", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var out struct {
		Namespaces []struct{ Name string } `json:"namespaces"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if len(out.Namespaces) == 0 || out.Namespaces[0].Name != api.ClusterScopeNamespace {
		t.Errorf("namespaces[0] = %+v, want pinned %q first", out.Namespaces, api.ClusterScopeNamespace)
	}
}

// TestNamespacesHidesClusterPseudoEntryWhenDenied covers the RBAC gate on the cluster
// pseudo-namespace: a user with only namespaced grants (no cluster-scoped read like nodes)
// gets the namespace list without a [cluster] entry, so the sidebar doesn't surface a row
// that 403s on every drill-in. The policy locks down the defaults and grants alice every
// action in `shop` only.
func TestNamespacesHidesClusterPseudoEntryWhenDenied(t *testing.T) {
	srv := newServer(t, `
defaultRoles: []
roles:
  shop-only:
    allow:
      - namespaces: [shop]
users:
  alice: [shop-only]
`, fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/namespaces", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var out struct {
		Namespaces []struct{ Name string } `json:"namespaces"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	for _, ns := range out.Namespaces {
		if ns.Name == api.ClusterScopeNamespace {
			t.Errorf("namespaces should NOT include %q for a user without cluster-scope read", api.ClusterScopeNamespace)
		}
	}
}

// TestNamespacesShowsClusterEntryForClusterScopedGrant is the positive half of the gate:
// a `clusterScoped: true` allow rule must surface the [cluster] sidebar entry, and the
// entry must agree with the drill-in (the cluster graph request succeeds for the same user).
func TestNamespacesShowsClusterEntryForClusterScopedGrant(t *testing.T) {
	srv := newServer(t, `
defaultRoles: []
roles:
  cluster-viewer:
    allow:
      - clusterScoped: true
users:
  carol: [cluster-viewer]
`, fixtureObjs...)
	resp, body := get(t, srv, ctxPath+"/namespaces", "carol")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var out struct {
		Namespaces []struct{ Name string } `json:"namespaces"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	if len(out.Namespaces) != 1 || out.Namespaces[0].Name != api.ClusterScopeNamespace {
		t.Errorf("namespaces = %v, want exactly the %q entry", out.Namespaces, api.ClusterScopeNamespace)
	}
	if resp, _ := get(t, srv, ctxPath+"/namespaces/"+api.ClusterScopeNamespace+"/graph", "carol"); resp.StatusCode != http.StatusOK {
		t.Errorf("cluster graph status = %d, want 200 (sidebar entry must not 403 on drill-in)", resp.StatusCode)
	}
}

// TestClusterScopeGraph covers the routing contract: GET /namespaces/__cluster__/graph
// serves the cluster snapshot (cluster-scoped objects, no namespaced ones) via the same
// handler path as a real namespace.
func TestClusterScopeGraph(t *testing.T) {
	objs := []runtime.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "shop"}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "node-1", UID: "n1"}},
		&corev1.Pod{ObjectMeta: meta("shop", "web-1", "p1"), Status: corev1.PodStatus{Phase: corev1.PodRunning}},
	}
	srv := newServer(t, "", objs...)
	resp, body := get(t, srv, ctxPath+"/namespaces/"+api.ClusterScopeNamespace+"/graph?view=all", "alice")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200\n%s", resp.StatusCode, body)
	}
	var g graph.Graph
	if err := json.Unmarshal(body, &g); err != nil {
		t.Fatalf("unmarshal: %v\n%s", err, body)
	}
	var hasNode, hasPod bool
	for _, n := range g.Nodes {
		switch n.Kind {
		case "Node":
			hasNode = true
		case "Pod":
			hasPod = true
		}
	}
	if !hasNode {
		t.Error("cluster snapshot should include the Node")
	}
	if hasPod {
		t.Error("cluster snapshot should NOT include namespaced Pods")
	}
}

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
