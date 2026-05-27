// Package server wires the auth middleware, the API, and the embedded client into one HTTP
// handler. See docs/ADR/20260527-architecture-overview.md.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"

	"github.com/motoki317/kd/internal/auth"
)

// New builds the top-level handler: unauthenticated health checks, the auth-gated API under
// /api/, and the client SPA at the root. The whole tree is wrapped in panic recovery.
func New(authCfg auth.Config, apiHandler http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.Handle("/api/", authCfg.Middleware(apiHandler))
	mux.Handle("/", clientHandler())
	return recoverer(mux)
}

// clientHandler serves the embedded client as a single-page app, or a placeholder when the
// client was not embedded (default build; use `just build` or the Vite dev server).
func clientHandler() http.Handler {
	fsys, ok := clientAssets()
	if !ok {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(placeholderHTML))
		})
	}
	return spaHandler(fsys)
}

// spaHandler serves static files, falling back to index.html for unknown paths so client-side
// routes resolve.
func spaHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if _, err := fs.Stat(fsys, p); err != nil {
			http.ServeFileFS(w, r, fsys, "index.html")
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}

// recoverer turns a handler panic into a 500 instead of crashing the process.
func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic serving request", "path", r.URL.Path, "recover", rec, "stack", string(debug.Stack()))
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

const placeholderHTML = `<!doctype html><html><head><meta charset="utf-8"><title>kd</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
<h1>kd</h1>
<p>The API is running. The web client was not embedded in this build.</p>
<p>Run <code>just dev</code> for local development, or <code>just build</code> to embed the client.</p>
</body></html>`
