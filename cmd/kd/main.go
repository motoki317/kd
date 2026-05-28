// Command kd is a web-served Kubernetes dashboard.
//
// It connects to a Kubernetes cluster via client-go informers, builds a relationship
// graph of cluster resources, and serves an ArgoCD-style 2D topology UI over HTTP.
// See docs/ADR/ for the design decisions behind this tool.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/motoki317/kd/internal/api"
	"github.com/motoki317/kd/internal/auth"
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
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reg, err := newRegistry(cfg.Kubeconfig, cfg.Resync, store.Options{
		SkipKinds:  cfg.SkipKinds,
		EagerKinds: cfg.EagerKinds,
	})
	if err != nil {
		return err
	}
	slog.Info("syncing informer cache", "context", reg.Default())
	if err := reg.Prewarm(ctx, reg.Default()); err != nil {
		return err
	}

	policy, err := rbac.LoadFile(cfg.PolicyPath, cfg.DefaultRole)
	if err != nil {
		return err
	}
	enforcer := rbac.NewEnforcer(policy)
	if cfg.PolicyPath != "" {
		go rbac.WatchFile(ctx, enforcer, cfg.PolicyPath, cfg.DefaultRole, cfg.PolicyReloadInterval, func(err error) {
			if err != nil {
				slog.Error("policy reload failed", "err", err)
				return
			}
			slog.Info("policy reloaded", "path", cfg.PolicyPath)
		})
	}

	authCfg := auth.Config{
		UserHeader:      cfg.UserHeader,
		GroupsHeader:    cfg.GroupsHeader,
		GroupsDelimiter: cfg.GroupsDelimiter,
		TrustedProxies:  cfg.TrustedProxies,
		DevUser:         cfg.DevUser,
	}
	handler := server.New(authCfg, api.New(api.FromRegistry(reg), enforcer).Routes())

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: handler,
		// No WriteTimeout: SSE streams are long-lived. ReadHeaderTimeout guards slow-header DoS.
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	if cfg.DevUser != "" {
		slog.Warn("dev mode: trusting a fixed identity, authentication disabled", "user", cfg.DevUser)
	}
	slog.Info("kd listening", "addr", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// newRegistry chooses between in-cluster mode (single hidden context) and kubeconfig mode
// (UI-selectable contexts). In-cluster is preferred only when no explicit --kubeconfig was
// given AND rest.InClusterConfig() succeeds — matching the prior single-client behavior.
func newRegistry(kubeconfigPath string, resync time.Duration, storeOpts store.Options) (*registry.Registry, error) {
	if kubeconfigPath == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			typed, err := kubernetes.NewForConfig(cfg)
			if err != nil {
				return nil, err
			}
			dyn, err := dynamic.NewForConfig(cfg)
			if err != nil {
				return nil, err
			}
			return registry.NewInCluster(registry.Clients{Typed: typed, Dynamic: dyn}, resync, storeOpts), nil
		}
	}
	loader, err := kubeconfig.Load(kubeconfigPath)
	if err != nil {
		return nil, err
	}
	return registry.NewKubeconfig(loader, resync, storeOpts), nil
}
