// Command kd is a web-served Kubernetes dashboard.
//
// It connects to a Kubernetes cluster via client-go informers, builds a relationship
// graph of cluster resources, and serves an ArgoCD-style 2D topology UI over HTTP.
// See docs/ADR/ for the design decisions behind this tool.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/* on http.DefaultServeMux; only served when --pprof-addr is set
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	metricsversioned "k8s.io/metrics/pkg/client/clientset/versioned"

	"github.com/motoki317/kd/internal/api"
	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/clilog"
	"github.com/motoki317/kd/internal/config"
	"github.com/motoki317/kd/internal/kube/kubeconfig"
	"github.com/motoki317/kd/internal/kube/registry"
	"github.com/motoki317/kd/internal/kube/store"
	"github.com/motoki317/kd/internal/rbac"
	"github.com/motoki317/kd/internal/server"
)

func main() {
	if err := run(); err != nil {
		slog.Error("kd exited with error", "err", err)
		os.Exit(1)
	}
}

func run() error {
	// kd is a read-mostly informer-cache server whose heap is dominated by a long-lived working
	// set, so the default GOGC=100 (collect when the heap doubles) leaves ~2x the live set
	// committed as headroom kd never uses. A tighter target trades a little GC CPU — kd idles near
	// zero — for a materially smaller resident set: measured ~12% lower peak RSS on a medium
	// cluster. An operator who sets GOGC explicitly keeps full control; the runtime already applied
	// their value, so we only install kd's default when the env is absent.
	if _, ok := os.LookupEnv("GOGC"); !ok {
		debug.SetGCPercent(50)
	}

	cfg, err := config.Load(os.Args[1:])
	if errors.Is(err, flag.ErrHelp) {
		// -h is a requested exit, not a failure — flag already printed the usage; an ERROR log
		// here would make a new operator's first command look like a crash.
		os.Exit(2)
	}
	if err != nil {
		return err
	}

	started := time.Now()
	console := clilog.Setup(os.Stderr, os.Stderr.Fd(), cfg.LogLevel, cfg.LogFormat)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if cfg.PprofAddr != "" {
		// Separate listener bound to the default mux (where net/http/pprof registers in init),
		// so the profiler is never reachable from the authenticated UI port.
		go func() {
			slog.Warn("pprof listener enabled", "addr", cfg.PprofAddr)
			pprofSrv := &http.Server{Addr: cfg.PprofAddr, Handler: http.DefaultServeMux, ReadHeaderTimeout: 10 * time.Second}
			if err := pprofSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("pprof listener failed", "err", err)
			}
		}()
	}

	reg, inCluster, err := newRegistry(cfg.Kubeconfig, cfg.Resync, store.Options{
		SkipKinds:  cfg.SkipKinds,
		EagerKinds: cfg.EagerKinds,
	})
	if err != nil {
		return err
	}
	slog.Info("loading cluster", "context", reg.Default())
	if err := reg.Prewarm(ctx, reg.Default()); err != nil {
		return err
	}

	policy, err := rbac.LoadFile(cfg.PolicyPath)
	if err != nil {
		return err
	}
	enforcer := rbac.NewEnforcer(policy)
	if cfg.PolicyPath != "" {
		go rbac.WatchFile(ctx, enforcer, cfg.PolicyPath, cfg.PolicyReloadInterval, func(err error) {
			if err != nil {
				slog.Error("policy reload failed", "err", err)
				return
			}
			slog.Info("policy reloaded", "path", cfg.PolicyPath)
		})
	}

	devUser, _ := cfg.EffectiveDevUser(inCluster)
	authCfg := auth.Config{
		UserHeader:      cfg.UserHeader,
		GroupsHeader:    cfg.GroupsHeader,
		GroupsDelimiter: cfg.GroupsDelimiter,
		TrustedProxies:  cfg.TrustedProxies,
		DevUser:         devUser,
	}
	handler := server.New(authCfg, api.New(api.FromRegistry(reg), enforcer).Routes())

	srv := &http.Server{
		Handler: handler,
		// No WriteTimeout: SSE streams are long-lived. ReadHeaderTimeout guards slow-header DoS.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Bind before announcing so the banner's URLs are reachable the instant they're printed (and
	// so a port conflict fails loudly here rather than after a misleading "ready").
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	// Both auto- and explicit -dev-user collapse to the same fact for an operator: auth is off and
	// this is a local run. Kept at INFO (not WARN) and jargon-free so a normal local startup reads
	// as calm status, not something demanding action — auto dev mode is already gated to non-cluster,
	// no-proxy-auth hosts (see EffectiveDevUser), so the alarming wording was misplaced there.
	if devUser != "" {
		slog.Info("running in local mode, authentication disabled", "user", devUser)
	}
	console.Ready(ln.Addr().String(), time.Since(started))
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// newRegistry chooses between in-cluster mode (single hidden context) and kubeconfig mode
// (UI-selectable contexts). In-cluster is preferred only when no explicit --kubeconfig was
// given AND rest.InClusterConfig() succeeds — matching the prior single-client behavior. The
// returned bool reports which branch was taken; callers use it to gate auto dev mode (off
// in-cluster, candidate when local).
func newRegistry(kubeconfigPath string, resync time.Duration, storeOpts store.Options) (*registry.Registry, bool, error) {
	if kubeconfigPath == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			typed, err := kubernetes.NewForConfig(cfg)
			if err != nil {
				return nil, false, err
			}
			dyn, err := dynamic.NewForConfig(cfg)
			if err != nil {
				return nil, false, err
			}
			// Tolerate a missing metrics client (metrics-server may be absent): a nil Metrics
			// degrades the usage feed to a no-op rather than failing startup.
			metricsClient, _ := metricsversioned.NewForConfig(cfg)
			return registry.NewInCluster(registry.Clients{Typed: typed, Dynamic: dyn, Metrics: metricsClient}, resync, storeOpts), true, nil
		}
	}
	loader, err := kubeconfig.Load(kubeconfigPath)
	if err != nil {
		return nil, false, err
	}
	return registry.NewKubeconfig(loader, resync, storeOpts), false, nil
}
