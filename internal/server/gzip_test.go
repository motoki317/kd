package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// readBody decodes a response body, transparently gunzipping when Content-Encoding says so.
func readBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	var r io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		gr, err := gzip.NewReader(resp.Body)
		if err != nil {
			t.Fatalf("gzip.NewReader: %v", err)
		}
		r = gr
	}
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

func TestGzipMiddleware(t *testing.T) {
	// A reasonably compressible JSON body, large enough that gzip is a clear win.
	jsonBody := `{"items":[` + strings.Repeat(`{"name":"pod","ns":"team-a"},`, 200) + `{}]}`

	cases := []struct {
		name           string
		acceptEncoding string
		contentType    string
		status         int
		body           string
		wantEncoding   string // "gzip" or ""
	}{
		{"compressible json gets gzipped", "gzip, deflate, br", "application/json", 200, jsonBody, "gzip"},
		{"no accept-encoding stays raw", "", "application/json", 200, jsonBody, ""},
		{"q=0 rejection stays raw", "gzip;q=0", "application/json", 200, jsonBody, ""},
		{"font passes through", "gzip", "font/woff2", 200, jsonBody, ""},
		{"svg is compressible", "gzip", "image/svg+xml", 200, jsonBody, "gzip"},
		{"non-200 stays raw", "gzip", "application/json", 206, jsonBody, ""},
		{"event-stream is compressible", "gzip", "text/event-stream", 200, jsonBody, "gzip"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tc.contentType)
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			req := httptest.NewRequest("GET", "/", nil)
			req.Header.Set("Accept-Encoding", tc.acceptEncoding)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			resp := rec.Result()

			if got := resp.Header.Get("Content-Encoding"); got != tc.wantEncoding {
				t.Errorf("Content-Encoding = %q, want %q", got, tc.wantEncoding)
			}
			if tc.wantEncoding == "gzip" {
				if !strings.Contains(resp.Header.Get("Vary"), "Accept-Encoding") {
					t.Errorf("Vary = %q, want it to include Accept-Encoding", resp.Header.Get("Vary"))
				}
				if resp.Header.Get("Content-Length") != "" {
					t.Errorf("Content-Length should be cleared for streamed gzip, got %q", resp.Header.Get("Content-Length"))
				}
				if n := rec.Body.Len(); n >= len(tc.body) {
					t.Errorf("gzipped body (%d) not smaller than raw (%d)", n, len(tc.body))
				}
			}
			// Round-trips to the original bytes regardless of encoding.
			if got := readBody(t, resp); got != tc.body {
				t.Errorf("decoded body mismatch: got %d bytes, want %d", len(got), len(tc.body))
			}
		})
	}
}

// TestGzipFlusher verifies the wrapper stays an http.Flusher (the SSE handler type-asserts it) and
// that flushing mid-stream produces decodable bytes — i.e. gzip.Flush is plumbed through.
func TestGzipFlusher(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f, ok := w.(http.Flusher)
		if !ok {
			t.Errorf("wrapped writer is not an http.Flusher")
			return
		}
		_, _ = io.WriteString(w, "event: a\ndata: 1\n\n")
		f.Flush()
		_, _ = io.WriteString(w, "event: b\ndata: 2\n\n")
		f.Flush()
	}))
	req := httptest.NewRequest("GET", "/stream", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("stream was not gzipped")
	}
	body := readBody(t, resp)
	if !strings.Contains(body, "event: a") || !strings.Contains(body, "event: b") {
		t.Errorf("decoded stream missing events: %q", body)
	}
}

// TestGzipFlushBeforeWrite covers the SSE-log regression: the log-stream handler flushes to commit
// the response head BEFORE its first body write (so the client gets 200 + headers even with no pods
// yet). If that early flush commits the head without negotiating gzip, the first real write then sets
// up the gzip writer and emits compressed bytes under a plain text/event-stream header — a body the
// browser can't decode, so the Logs tab silently never received an event. The flush must settle the
// header (Content-Encoding: gzip) so the body encoding and the header always agree.
func TestGzipFlushBeforeWrite(t *testing.T) {
	h := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		f.Flush() // commit head before any body write — the log handler's pattern
		_, _ = io.WriteString(w, "event: log\ndata: hello\n\n")
		f.Flush()
	}))
	req := httptest.NewRequest("GET", "/stream", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	resp := rec.Result()
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("flush-before-write did not negotiate gzip: Content-Encoding=%q", resp.Header.Get("Content-Encoding"))
	}
	// readBody gunzips per the header; if the header lied about the encoding this would yield garbage.
	if body := readBody(t, resp); !strings.Contains(body, "event: log") {
		t.Errorf("decoded stream missing event (header/body encoding mismatch?): %q", body)
	}
}
