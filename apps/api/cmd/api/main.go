// Command api serves the Dream Home Designer REST API.
//
//	ADDR           listen address (default :8080)
//	STORE          file (default), memory or r2
//	DATA_DIR       directory for the file store (default ./data)
//	R2_ENDPOINT    https://<account>.r2.cloudflarestorage.com (STORE=r2)
//	R2_BUCKET      bucket name (STORE=r2)
//	R2_ACCESS_KEY  R2 S3 access key id (STORE=r2)
//	R2_SECRET_KEY  R2 S3 secret (STORE=r2)
//	LIST_PROJECTS  set to "on" to enable GET /projects (off by default: no auth yet)
package main

import (
	"context"
	"errors"
	"fmt"
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
	switch os.Getenv("STORE") {
	case "memory":
		st = store.NewMemory()
		log.Info("using in-memory store")
	case "r2":
		cfg := map[string]string{}
		for _, k := range []string{"R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY", "R2_SECRET_KEY"} {
			if cfg[k] = os.Getenv(k); cfg[k] == "" {
				return fmt.Errorf("STORE=r2 needs %s", k)
			}
		}
		st = store.NewR2(cfg["R2_ENDPOINT"], cfg["R2_BUCKET"], cfg["R2_ACCESS_KEY"], cfg["R2_SECRET_KEY"])
		log.Info("using r2 store", "bucket", cfg["R2_BUCKET"])
	default:
		dir := envOr("DATA_DIR", "./data")
		fs, err := store.NewFile(dir)
		if err != nil {
			return err
		}
		st = fs
		log.Info("using file store", "dir", dir)
	}

	var opts []httpapi.Option
	if os.Getenv("LIST_PROJECTS") == "on" {
		opts = append(opts, httpapi.WithListing())
	}

	srv := &http.Server{
		Addr:              addr,
		Handler:           httpapi.New(st, log, opts...),
		ReadHeaderTimeout: 5 * time.Second,
		// Long enough for a 10 MB plan image on a slow uplink, and to stream it back.
		ReadTimeout:  2 * time.Minute,
		WriteTimeout: 2 * time.Minute,
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
