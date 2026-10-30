// Package httpapi exposes the project store over REST.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/zeecm/dream-home-designer/apps/api/internal/project"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

type Server struct {
	store store.Store
	log   *slog.Logger
	mux   *http.ServeMux
}

// Option configures a Server.
type Option func(*options)

type options struct{ noList bool }

// WithoutListing disables GET /projects. Until there is auth, a public deployment uses
// this so a project is reachable only by its unguessable id.
func WithoutListing() Option { return func(o *options) { o.noList = true } }

// WithListing enables GET /projects (off by default; for local development).
func WithListing() Option { return func(o *options) { o.noList = false } }

func New(s store.Store, log *slog.Logger, opts ...Option) *Server {
	o := options{noList: true}
	for _, opt := range opts {
		opt(&o)
	}
	srv := &Server{store: s, log: log, mux: http.NewServeMux()}
	srv.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	if !o.noList {
		srv.mux.HandleFunc("GET /projects", srv.list)
	}
	srv.mux.HandleFunc("POST /projects", srv.create)
	srv.mux.HandleFunc("GET /projects/{id}", srv.get)
	srv.mux.HandleFunc("PUT /projects/{id}", srv.update)
	srv.mux.HandleFunc("DELETE /projects/{id}", srv.remove)
	srv.mux.HandleFunc("PUT /projects/{id}/image", srv.putImage)
	srv.mux.HandleFunc("GET /projects/{id}/image/{hash}", srv.getImage)
	return srv
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
	s.mux.ServeHTTP(rw, r)
	s.log.Info("request", "method", r.Method, "path", r.URL.Path, "status", rw.status, "dur", time.Since(start))
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	out, err := s.store.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	rec, err := s.store.Get(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("ETag", etag(rec.Version))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rec.Doc)
}

func (s *Server) create(w http.ResponseWriter, r *http.Request) {
	raw, env, ok := s.readDoc(w, r)
	if !ok {
		return
	}
	doc, err := project.WithVersion(raw, 1)
	if err != nil {
		s.fail(w, err)
		return
	}
	if err := s.store.Create(r.Context(), store.Record{ID: env.ID, Name: env.Name, Doc: doc}); err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("ETag", etag(1))
	w.Header().Set("Location", "/projects/"+env.ID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write(doc)
}

func (s *Server) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	expected, ok := parseIfMatch(r.Header.Get("If-Match"))
	if !ok {
		writeError(w, http.StatusPreconditionRequired, `If-Match: "<version>" header is required`)
		return
	}
	raw, env, ok := s.readDoc(w, r)
	if !ok {
		return
	}
	if env.ID != id {
		writeError(w, http.StatusBadRequest, "document id does not match the URL")
		return
	}
	version, err := s.store.Update(r.Context(), id, expected, env.Name, func(v int) ([]byte, error) {
		return project.WithVersion(raw, v)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("ETag", etag(version))
	writeJSON(w, http.StatusOK, map[string]int{"version": version})
}

func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	if err := s.store.Delete(r.Context(), id); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) readDoc(w http.ResponseWriter, r *http.Request) ([]byte, project.Envelope, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, project.MaxDocBytes+1))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "document too large")
		return nil, project.Envelope{}, false
	}
	env, err := project.Parse(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return nil, project.Envelope{}, false
	}
	return raw, env, true
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	var conflict *store.ConflictError
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrNoImage):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.As(err, &conflict):
		w.Header().Set("ETag", etag(conflict.Current))
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "version": conflict.Current})
	default:
		s.log.Error("internal error", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

func etag(v int) string { return `"` + strconv.Itoa(v) + `"` }

// parseIfMatch accepts `"3"`, `W/"3"` or a bare `3`.
func parseIfMatch(h string) (int, bool) {
	h = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(h), "W/"))
	h = strings.Trim(h, `"`)
	v, err := strconv.Atoi(h)
	return v, err == nil && v >= 0
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
