package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/motoki317/kd/internal/auth"
)

// spaHandler serves real files but falls back to index.html for any unknown path, so a deep-linked
// client route (e.g. /contexts/x?ns=y) loads the SPA instead of 404ing. A real asset must still be
// served as itself (a missing asset must NOT masquerade as index.html, or a broken bundle reference
// silently returns HTML).
func TestSPAHandler(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html>INDEX")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	h := spaHandler(fsys)
	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	if rec := get("/"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "INDEX") {
		t.Errorf("root: status=%d body=%q, want index.html", rec.Code, rec.Body.String())
	}
	if rec := get("/assets/app.js"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "console.log") {
		t.Errorf("asset: status=%d body=%q, want the real file", rec.Code, rec.Body.String())
	}
	// An unknown path (a client-side route) falls back to index.html with a 200, not a 404.
	if rec := get("/contexts/prod/namespaces/shop"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "INDEX") {
		t.Errorf("client route: status=%d body=%q, want index.html fallback", rec.Code, rec.Body.String())
	}
}

// recoverer turns a downstream panic into a 500 instead of crashing the process.
func TestRecoverer(t *testing.T) {
	h := recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 after a handler panic", rec.Code)
	}
}

func TestServerRouting(t *testing.T) {
	apiStub := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("api reached"))
	})
	h := New(auth.Config{UserHeader: "X-Forwarded-User"}, apiStub)

	t.Run("healthz needs no auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		if rec.Code != http.StatusOK {
			t.Errorf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("api is gated by auth", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/namespaces", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401 (no identity header)", rec.Code)
		}
	})

	t.Run("api reached with identity", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces", nil)
		req.Header.Set("X-Forwarded-User", "alice")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "api reached") {
			t.Errorf("status = %d body = %q, want 200 'api reached'", rec.Code, rec.Body.String())
		}
	})

	t.Run("root serves the client placeholder when not embedded", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<h1>kd</h1>") {
			t.Errorf("status = %d, want placeholder HTML", rec.Code)
		}
	})
}
