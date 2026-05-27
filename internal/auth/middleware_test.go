package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMiddleware(t *testing.T) {
	cfg := Config{UserHeader: "X-Forwarded-User"}

	t.Run("authenticated request reaches the handler with identity in context", func(t *testing.T) {
		var got Identity
		var ok bool
		next := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			got, ok = FromContext(r.Context())
		})

		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("X-Forwarded-User", "alice")
		cfg.Middleware(next).ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if !ok {
			t.Fatal("identity not found in context")
		}
		if got.User != "alice" {
			t.Errorf("user = %q, want alice", got.User)
		}
	})

	t.Run("unauthenticated request is rejected with 401 and handler is not called", func(t *testing.T) {
		called := false
		next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })

		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		cfg.Middleware(next).ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want 401", rec.Code)
		}
		if called {
			t.Error("handler should not be called for unauthenticated request")
		}
	})
}

func TestFromContextMissing(t *testing.T) {
	if _, ok := FromContext(httptest.NewRequest(http.MethodGet, "/", nil).Context()); ok {
		t.Error("expected no identity in a bare context")
	}
}
