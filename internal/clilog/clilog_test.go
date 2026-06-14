package clilog

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

func newMutex() *sync.Mutex { return &sync.Mutex{} }

func TestParseLevel(t *testing.T) {
	cases := map[string]slog.Level{
		"":      slog.LevelInfo,
		"info":  slog.LevelInfo,
		"DEBUG": slog.LevelDebug,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
	}
	for in, want := range cases {
		got, err := ParseLevel(in)
		if err != nil || got != want {
			t.Errorf("ParseLevel(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseLevel("loud"); err == nil {
		t.Error("ParseLevel(loud) should error")
	}
}

func TestParseFormat(t *testing.T) {
	cases := map[string]Format{
		"":        FormatAuto,
		"auto":    FormatAuto,
		"console": FormatConsole,
		"text":    FormatText,
		"json":    FormatJSON,
	}
	for in, want := range cases {
		got, err := ParseFormat(in)
		if err != nil || got != want {
			t.Errorf("ParseFormat(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseFormat("yaml"); err == nil {
		t.Error("ParseFormat(yaml) should error")
	}
}

func TestResolveURLs(t *testing.T) {
	// Documentation-range IPs (RFC 5737) stand in for real LAN addresses.
	lan := []string{"192.0.2.5", "198.51.100.10"}
	tests := []struct {
		addr        string
		wantLocal   string
		wantNetwork []string
	}{
		{":9123", "http://localhost:9123/", []string{"http://192.0.2.5:9123/", "http://198.51.100.10:9123/"}},
		{"0.0.0.0:8080", "http://localhost:8080/", []string{"http://192.0.2.5:8080/", "http://198.51.100.10:8080/"}},
		{"[::]:9123", "http://localhost:9123/", []string{"http://192.0.2.5:9123/", "http://198.51.100.10:9123/"}},
		{"127.0.0.1:9123", "http://127.0.0.1:9123/", nil}, // explicit host: no network advertising
		{"192.0.2.50:9123", "http://192.0.2.50:9123/", nil},
	}
	for _, tt := range tests {
		local, network := resolveURLs(tt.addr, lan)
		if local != tt.wantLocal {
			t.Errorf("resolveURLs(%q) local = %q, want %q", tt.addr, local, tt.wantLocal)
		}
		if strings.Join(network, ",") != strings.Join(tt.wantNetwork, ",") {
			t.Errorf("resolveURLs(%q) network = %v, want %v", tt.addr, network, tt.wantNetwork)
		}
	}
}

func TestFmtDuration(t *testing.T) {
	cases := map[time.Duration]string{
		250 * time.Millisecond:  "250ms",
		1500 * time.Millisecond: "1.5s",
		3 * time.Second:         "3.0s",
	}
	for d, want := range cases {
		if got := fmtDuration(d); got != want {
			t.Errorf("fmtDuration(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestReadyBannerPretty(t *testing.T) {
	var buf bytes.Buffer
	c := &Console{w: &buf, pretty: true, color: false}
	c.Ready("0.0.0.0:9123", 1500*time.Millisecond)
	out := buf.String()
	for _, want := range []string{"kd ready in 1.5s", "➜", "Local:", "http://localhost:9123/"} {
		if !strings.Contains(out, want) {
			t.Errorf("banner missing %q\n%s", want, out)
		}
	}
}

func TestReadyNonPrettyLogsStructured(t *testing.T) {
	// Non-pretty Ready must not draw box-art; it logs a single record instead.
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	c := &Console{w: &bytes.Buffer{}, pretty: false}
	c.Ready("0.0.0.0:9123", time.Second)
	out := buf.String()
	if !strings.Contains(out, "dashboard ready") || !strings.Contains(out, "http://localhost:9123/") {
		t.Errorf("structured ready line missing fields:\n%s", out)
	}
}

func TestSetupInstallsHandler(t *testing.T) {
	var buf bytes.Buffer
	c := Setup(&buf, ^uintptr(0), slog.LevelInfo, FormatText)
	if c.pretty {
		t.Error("FormatText must not be pretty")
	}
	slog.Info("hi", "k", "v")
	if !strings.Contains(buf.String(), "hi") {
		t.Errorf("Setup did not install handler: %q", buf.String())
	}
}

func TestSetupConsoleColorRespectsNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	var buf bytes.Buffer
	c := Setup(&buf, ^uintptr(0), slog.LevelInfo, FormatConsole)
	if !c.pretty || c.color {
		t.Errorf("FormatConsole with NO_COLOR: pretty=%v color=%v, want true/false", c.pretty, c.color)
	}
	slog.Info("hi")
	if strings.Contains(buf.String(), "\x1b[") {
		t.Errorf("NO_COLOR output must carry no ANSI codes: %q", buf.String())
	}
}

func newRecord(level slog.Level, msg string, attrs ...slog.Attr) slog.Record {
	r := slog.NewRecord(time.Date(2026, 6, 14, 9, 8, 7, 0, time.UTC), level, msg, 0)
	r.AddAttrs(attrs...)
	return r
}

func TestConsoleHandlerPlain(t *testing.T) {
	var buf bytes.Buffer
	h := &consoleHandler{mu: newMutex(), w: &buf, level: slog.LevelInfo, color: false}
	if err := h.Handle(context.Background(), newRecord(slog.LevelInfo, "hello", slog.String("ctx", "abc"))); err != nil {
		t.Fatal(err)
	}
	if got, want := buf.String(), "09:08:07 INFO  hello ctx=abc\n"; got != want {
		t.Errorf("plain line = %q, want %q", got, want)
	}
}

func TestConsoleHandlerQuotesSpaces(t *testing.T) {
	var buf bytes.Buffer
	h := &consoleHandler{mu: newMutex(), w: &buf, level: slog.LevelInfo, color: false}
	_ = h.Handle(context.Background(), newRecord(slog.LevelWarn, "watch", slog.String("err", "a b")))
	if got, want := buf.String(), "09:08:07 WARN  watch err=\"a b\"\n"; got != want {
		t.Errorf("quoted line = %q, want %q", got, want)
	}
}

func TestConsoleHandlerColor(t *testing.T) {
	var buf bytes.Buffer
	h := &consoleHandler{mu: newMutex(), w: &buf, level: slog.LevelInfo, color: true}
	_ = h.Handle(context.Background(), newRecord(slog.LevelError, "boom"))
	out := buf.String()
	if !strings.Contains(out, "\x1b[") || !strings.Contains(out, ansiReset) || !strings.Contains(out, "ERROR") {
		t.Errorf("colored line lacks ANSI/level: %q", out)
	}
}

func TestConsoleHandlerEnabled(t *testing.T) {
	h := &consoleHandler{mu: newMutex(), level: slog.LevelInfo}
	if h.Enabled(context.Background(), slog.LevelDebug) {
		t.Error("debug must be filtered at info level")
	}
	if !h.Enabled(context.Background(), slog.LevelWarn) {
		t.Error("warn must pass at info level")
	}
}

func TestConsoleHandlerWithAttrsAndGroup(t *testing.T) {
	var buf bytes.Buffer
	base := &consoleHandler{mu: newMutex(), w: &buf, level: slog.LevelInfo, color: false}
	h := base.WithAttrs([]slog.Attr{slog.String("ctx", "prod")}).WithGroup("store")
	_ = h.Handle(context.Background(), newRecord(slog.LevelInfo, "watch", slog.String("gvr", "v1/pods")))
	if got, want := buf.String(), "09:08:07 INFO  watch ctx=prod store.gvr=v1/pods\n"; got != want {
		t.Errorf("with-attrs/group line = %q, want %q", got, want)
	}
}
