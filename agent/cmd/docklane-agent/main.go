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

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/dockerengine"
	"github.com/KimHG1995/Docklane/agent/internal/httpserver"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("load config", "error", err)
		os.Exit(1)
	}

	reader, err := dockerengine.NewReader()
	if err != nil {
		slog.Error("create docker reader", "error", err)
		os.Exit(1)
	}
	defer reader.Close()

	server := httpserver.New(cfg, reader)
	serverErr := make(chan error, 1)

	go func() {
		slog.Info(
			"starting docklane agent",
			"addr", cfg.Addr,
			"insecureDev", cfg.InsecureDev,
		)
		serverErr <- server.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-signals:
		slog.Info("shutdown signal received", "signal", sig.String())
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("agent server stopped", "error", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown", "error", err)
	}
}
