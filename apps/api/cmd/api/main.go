// Command api serves the Dream Home Designer REST API.
//
//	ADDR      listen address (default :8080)
//	DATA_DIR  directory for the file store (default ./data); set STORE=memory to skip disk
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

	"github.com/zeecm/dream-home-designer/apps/api/internal/httpapi"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	addr := envOr("ADDR", ":8080")

	var st store.Store
	if os.Getenv("STORE") == "memory" {
		st = store.NewMemory()
		log.Info("using in-memory store")
	} else {
		dir := envOr("DATA_DIR", "./data")
		fs, err := store.NewFile(dir)
		if err != nil {
			return err
		}
		st = fs
		log.Info("using file store", "dir", dir)
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, log),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", addr)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
