package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"

	"github.com/zeecm/dream-home-designer/apps/api/internal/project"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

// MaxImageBytes caps a plan image. A PDF page rendered at 3000 px is about 1–3 MB as PNG.
const MaxImageBytes = 10 << 20

// imageTypes are the formats accepted, by sniffed content rather than the declared type.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true}

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// putImage stores the project's plan image, replacing any previous one, and returns its
// SHA-256 so the document can refer to it.
func (s *Server) putImage(w http.ResponseWriter, r *http.Request) {
	imgs, ok := s.store.(store.ImageStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store plan images")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxImageBytes))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeError(w, http.StatusRequestEntityTooLarge, "image larger than 10 MB")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "the upload did not arrive in full")
		return
	}
	kind := http.DetectContentType(data)
	if !imageTypes[kind] {
		writeError(w, http.StatusUnsupportedMediaType, "upload a PNG, JPEG or WebP image")
		return
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	if err := imgs.PutImage(r.Context(), id, store.Image{Hash: hash, ContentType: kind, Data: data}); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"hash": hash})
}

// imageReads caps concurrent image downloads, so a burst of requests can't hold many
// 10 MB bodies at once on a small container.
var imageReads = make(chan struct{}, 4)

// getImage serves the plan image if it is still the one the caller's document names.
// The hash is checked against stored metadata first, so a stale hash or a HEAD never
// reads the bytes; a GET streams them. The hash in the URL makes the response immutable,
// so browsers and the CDN cache it.
func (s *Server) getImage(w http.ResponseWriter, r *http.Request) {
	imgs, ok := s.store.(store.ImageStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store plan images")
		return
	}
	id := r.PathValue("id")
	hash := r.PathValue("hash")
	if !project.ValidID(id) || !hashPattern.MatchString(hash) {
		writeError(w, http.StatusBadRequest, "invalid project id or image hash")
		return
	}
	info, err := imgs.ImageInfo(r.Context(), id)
	if errors.Is(err, store.ErrNoImage) || (err == nil && info.Hash != hash) {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	if r.Method == http.MethodHead {
		imageHeaders(w, info)
		w.WriteHeader(http.StatusOK)
		return
	}
	select {
	case imageReads <- struct{}{}:
		defer func() { <-imageReads }()
	case <-r.Context().Done():
		return
	}
	info, body, err := imgs.OpenImage(r.Context(), id)
	if errors.Is(err, store.ErrNoImage) || (err == nil && info.Hash != hash) {
		if body != nil {
			body.Close()
		}
		writeError(w, http.StatusNotFound, "image not found") // replaced since the check
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	defer body.Close()
	imageHeaders(w, info)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, body)
}

func imageHeaders(w http.ResponseWriter, info store.ImageInfo) {
	h := w.Header()
	h.Set("Content-Type", info.ContentType)
	if info.Size > 0 {
		h.Set("Content-Length", strconv.FormatInt(info.Size, 10))
	}
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", `"`+info.Hash+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
}

// imageStatus says which image the server holds for the project: {"hash": "<hex>"}, or
// {"hash": null} with none. Always 200, so a client checking before an upload doesn't log
// a failed request.
func (s *Server) imageStatus(w http.ResponseWriter, r *http.Request) {
	imgs, ok := s.store.(store.ImageStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store plan images")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	info, err := imgs.ImageInfo(r.Context(), id)
	if errors.Is(err, store.ErrNoImage) {
		writeJSON(w, http.StatusOK, map[string]any{"hash": nil})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"hash": info.Hash})
}

// deleteImage removes the project's plan image (the plan's image was removed).
func (s *Server) deleteImage(w http.ResponseWriter, r *http.Request) {
	imgs, ok := s.store.(store.ImageStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store plan images")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	if err := imgs.DeleteImage(r.Context(), id); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
