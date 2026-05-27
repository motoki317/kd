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

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/motoki317/kd/internal/api"
	"github.com/motoki317/kd/internal/auth"
	"github.com/motoki317/kd/internal/config"
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

	client, err := newKubeClient(cfg.Kubeconfig)
	if err != nil {
		return err
	}

	st := store.New(client, cfg.Resync)
	slog.Info("syncing informer cache")
	if err := st.Start(ctx); err != nil {
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
	handler := server.New(authCfg, api.New(st, enforcer).Routes())

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

// newKubeClient builds a clientset, preferring in-cluster config and falling back to the
// kubeconfig (explicit path, then the default loading rules).
func newKubeClient(kubeconfig string) (kubernetes.Interface, error) {
	cfg, err := restConfig(kubeconfig)
	if err != nil {
		return nil, err
	}
	return kubernetes.NewForConfig(cfg)
}

func restConfig(kubeconfig string) (*rest.Config, error) {
	if kubeconfig == "" {
		if cfg, err := rest.InClusterConfig(); err == nil {
			return cfg, nil
		}
	}
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfig != "" {
		rules.ExplicitPath = kubeconfig
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig()
}
