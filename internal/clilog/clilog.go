// Package clilog renders kd's logs and startup banner for humans at a terminal.
//
// The default slog text handler stamps every line with a full date and prints the level
// inline, which reads as undifferentiated noise to an operator running kd interactively. This
// package installs a colorized console handler when stderr is a TTY (short time, color-coded
// level, dimmed key=value attrs) and prints a Vite-style "ready" banner with the dashboard's
// clickable Local/Network URLs. Piped or in-cluster (non-TTY) output falls back to the standard
// text handler so log collectors keep a stable, structured format; --log-format forces a choice.
package clilog

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

// ANSI styling. Kept minimal: a handful of SGR codes, never combined into a theme — the goal is
// to make the level and structure pop, not to paint the terminal.
const (
	ansiReset  = "\x1b[0m"
	ansiDim    = "\x1b[2m"
	ansiBold   = "\x1b[1m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiCyan   = "\x1b[36m"
	ansiGray   = "\x1b[90m"
)

// Format selects how log records are rendered.
type Format int

const (
	// FormatAuto picks the console handler when stderr is a terminal, else the text handler.
	FormatAuto Format = iota
	FormatConsole
	FormatText
	FormatJSON
)

// ParseFormat maps a flag/env string to a Format.
func ParseFormat(s string) (Format, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "auto":
		return FormatAuto, nil
	case "console", "pretty":
		return FormatConsole, nil
	case "text":
		return FormatText, nil
	case "json":
		return FormatJSON, nil
	}
	return FormatAuto, fmt.Errorf("clilog: invalid log format %q (want auto, console, text, or json)", s)
}

// ParseLevel maps a flag/env string to an slog.Level.
func ParseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return slog.LevelInfo, fmt.Errorf("clilog: invalid log level %q (want debug, info, warn, or error)", s)
}

// Console renders the startup banner in the same visual style as the installed log handler.
type Console struct {
	w      io.Writer
	pretty bool // console (TTY-style) rendering is active
	color  bool
}

// Setup installs slog's default logger writing to w and returns a Console for the startup
// banner. fd is the descriptor backing w, used for TTY detection when format is FormatAuto;
// pass an invalid fd (e.g. ^uintptr(0)) when w is not a terminal-backed file.
func Setup(w io.Writer, fd uintptr, level slog.Level, format Format) *Console {
	pretty := format == FormatConsole || (format == FormatAuto && term.IsTerminal(int(fd)))
	color := pretty && colorEnabled()

	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	switch {
	case format == FormatJSON:
		h = slog.NewJSONHandler(w, opts)
	case format == FormatText:
		h = slog.NewTextHandler(w, opts)
	case pretty:
		h = &consoleHandler{mu: &sync.Mutex{}, w: w, level: level, color: color}
	default: // FormatAuto on a non-terminal: keep the structured text format collectors expect.
		h = slog.NewTextHandler(w, opts)
	}
	slog.SetDefault(slog.New(h))
	return &Console{w: w, pretty: pretty, color: color}
}

// colorEnabled honors the NO_COLOR convention (https://no-color.org/) and dumb terminals.
func colorEnabled() bool {
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	return os.Getenv("TERM") != "dumb"
}

// Ready announces the reachable dashboard URLs once the listener is bound. addr is the
// listener's resolved address (e.g. "[::]:9123"); a wildcard host expands to localhost plus
// each non-loopback LAN address, mirroring Vite's dev banner. took is the time since startup.
//
// Non-pretty output emits a single structured log line instead, so piped/in-cluster collectors
// get a stable record rather than box-art.
func (c *Console) Ready(addr string, took time.Duration) {
	local, network := resolveURLs(addr, lanIPs())
	if !c.pretty {
		slog.Info("dashboard ready", "url", local, "addr", addr, "took", took.Round(time.Millisecond))
		return
	}
	var b strings.Builder
	b.WriteString("\n  ")
	b.WriteString(c.style(ansiBold, "kd"))
	b.WriteString(c.style(ansiDim, " ready in "+fmtDuration(took)))
	b.WriteString("\n\n")
	b.WriteString(c.urlLine("Local", local))
	for _, n := range network {
		b.WriteString(c.urlLine("Network", n))
	}
	b.WriteByte('\n')
	_, _ = io.WriteString(c.w, b.String())
}

func (c *Console) urlLine(label, url string) string {
	arrow := c.style(ansiGreen, "➜")
	// Pad the plain label before styling so the URL column aligns ("Network:" is the widest).
	padded := fmt.Sprintf("%-9s", label+":")
	return "  " + arrow + "  " + c.style(ansiBold, padded) + c.style(ansiCyan, url) + "\n"
}

func (c *Console) style(code, s string) string {
	if !c.color {
		return s
	}
	return code + s + ansiReset
}

// resolveURLs derives the Local URL and any Network URLs from a listener address. lan is the
// set of non-loopback IPv4 addresses to advertise when the listener binds a wildcard host.
func resolveURLs(addr string, lan []string) (local string, network []string) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr + "/", nil
	}
	switch host {
	case "", "0.0.0.0", "::":
		local = makeURL("localhost", port)
		for _, ip := range lan {
			network = append(network, makeURL(ip, port))
		}
	default:
		local = makeURL(host, port)
	}
	return local, network
}

func makeURL(host, port string) string {
	return "http://" + net.JoinHostPort(host, port) + "/"
}

// lanIPs returns the host's non-loopback IPv4 addresses. IPv6 is skipped: link-local addresses
// are noise in a dev banner and rarely the way an operator reaches a local port.
func lanIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil || ip.IsLoopback() {
			continue
		}
		if ip4 := ip.To4(); ip4 != nil {
			out = append(out, ip4.String())
		}
	}
	return out
}

func fmtDuration(d time.Duration) string {
	if d < time.Second {
		return strconv.FormatInt(d.Milliseconds(), 10) + "ms"
	}
	return strconv.FormatFloat(d.Seconds(), 'f', 1, 64) + "s"
}
