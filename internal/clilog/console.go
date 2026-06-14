package clilog

import (
	"context"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
)

// consoleHandler renders one slog record per line as
//
//	15:04:05 INFO  message key=value …
//
// with a dimmed time, a color-coded fixed-width level, and dimmed attr keys. It is deliberately
// not a general-purpose handler: kd logs flat records, so group/attr handling is correct but
// kept simple, and color is decided once at construction rather than per-record.
type consoleHandler struct {
	mu    *sync.Mutex // shared across WithAttrs/WithGroup clones so writes stay serialized
	w     io.Writer
	level slog.Level
	color bool
	attrs string // pre-rendered " key=value" prefix accumulated via WithAttrs
	group string // dotted prefix accumulated via WithGroup
}

func (h *consoleHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level }

func (h *consoleHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(h.paint(ansiGray, r.Time.Format("15:04:05")))
	b.WriteByte(' ')
	label, color := levelStyle(r.Level)
	b.WriteString(h.paint(color, label))
	b.WriteByte(' ')
	b.WriteString(r.Message)
	b.WriteString(h.attrs)
	r.Attrs(func(a slog.Attr) bool {
		h.appendAttr(&b, h.group, a)
		return true
	})
	b.WriteByte('\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

func (h *consoleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	var b strings.Builder
	for _, a := range attrs {
		h.appendAttr(&b, h.group, a)
	}
	nh := *h
	nh.attrs = h.attrs + b.String()
	return &nh
}

func (h *consoleHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	nh := *h
	nh.group = h.group + name + "."
	return &nh
}

func (h *consoleHandler) appendAttr(b *strings.Builder, prefix string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}
	if a.Value.Kind() == slog.KindGroup {
		group := a.Value.Group()
		if len(group) == 0 {
			return
		}
		p := prefix
		if a.Key != "" {
			p = prefix + a.Key + "."
		}
		for _, ga := range group {
			h.appendAttr(b, p, ga)
		}
		return
	}
	b.WriteByte(' ')
	b.WriteString(h.paint(ansiGray, prefix+a.Key+"="))
	b.WriteString(quoteIfNeeded(a.Value.String()))
}

func (h *consoleHandler) paint(code, s string) string {
	if !h.color {
		return s
	}
	return code + s + ansiReset
}

// levelStyle returns a fixed-width (5-char) label and its color, so messages align in a column.
func levelStyle(l slog.Level) (label, color string) {
	switch {
	case l >= slog.LevelError:
		return "ERROR", ansiBold + ansiRed
	case l >= slog.LevelWarn:
		return "WARN ", ansiYellow
	case l >= slog.LevelInfo:
		return "INFO ", ansiGreen
	default:
		return "DEBUG", ansiDim
	}
}

func quoteIfNeeded(s string) string {
	if s == "" {
		return `""`
	}
	if strings.ContainsAny(s, " \t\"") {
		return strconv.Quote(s)
	}
	return s
}
