package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/motoki317/kd/internal/auth"
)

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
