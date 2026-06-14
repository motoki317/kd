package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"sync"
)

// gzipMiddleware compresses text responses on the fly when the client accepts gzip. The embedded
// client ships ~260 KB of JS + ~74 KB of CSS uncompressed; on a throttled mobile link that
// render-blocking transfer dominated first paint (measured LCP 3.5 s → the single largest lever).
// It also compresses the SSE graph stream and JSON API responses, cutting per-navigation bandwidth.
//
// Decisions are made at WriteHeader from the already-set Content-Type — every handler that emits a
// compressible body (FileServer, the SSE stream, JSON/YAML API) sets Content-Type before the first
// write, so no body sniffing is needed. Only 200 responses are touched, leaving FileServer's
// conditional (304) and range (206) paths byte-exact.
func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

// compressibleType reports whether a Content-Type is worth gzipping. Fonts (woff2) and images are
// already compressed, so re-compressing them only burns CPU (and can grow them).
func compressibleType(contentType string) bool {
	ct := contentType
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = ct[:i]
	}
	switch strings.TrimSpace(ct) {
	case "text/html", "text/css", "text/plain", "text/javascript",
		"application/javascript", "application/json", "application/yaml",
		"image/svg+xml", "text/event-stream":
		return true
	}
	return false
}

// acceptsGzip reports whether the Accept-Encoding header opts into gzip (and not via an explicit
// q=0 rejection). Browsers always send "gzip, deflate, br".
func acceptsGzip(header string) bool {
	for part := range strings.SplitSeq(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			for _, p := range fields[1:] {
				if strings.EqualFold(strings.TrimSpace(p), "q=0") {
					return false
				}
			}
			return true
		}
	}
	return false
}

var gzipPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
		return w
	},
}

// gzipResponseWriter compresses the body when the response turns out to be a compressible 200. It
// implements http.Flusher so the SSE stream (which type-asserts the writer and flushes per event)
// keeps delivering promptly: each Flush drains the gzip writer before the underlying flush.
type gzipResponseWriter struct {
	http.ResponseWriter
	gw          *gzip.Writer
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	h := g.Header()
	if status == http.StatusOK && h.Get("Content-Encoding") == "" && compressibleType(h.Get("Content-Type")) {
		h.Del("Content-Length") // gzip changes the length; let it stream
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		g.gw = gzipPool.Get().(*gzip.Writer)
		g.gw.Reset(g.ResponseWriter)
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.gw != nil {
		return g.gw.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipResponseWriter) Flush() {
	// An SSE handler flushes to commit headers BEFORE its first body write (logstream.go: "commit
	// 200 + headers even before the first line"). Without this, that early flush would send the
	// response head with no Content-Encoding, yet the first Write then sets up the gzip writer and
	// emits compressed bytes — gzip body under a plain text/event-stream header, which the browser
	// can't decode (the Logs tab silently never received an event). Settle the header here first so
	// gzip negotiation and the body encoding always agree.
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.gw != nil {
		_ = g.gw.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponseWriter) close() {
	if g.gw != nil {
		_ = g.gw.Close()
		gzipPool.Put(g.gw)
		g.gw = nil
	}
}
