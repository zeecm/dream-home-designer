package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"

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
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "image larger than 10 MB")
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

// getImage serves the plan image if it is still the one the caller's document names.
// The hash in the URL makes the response immutable, so browsers and the CDN cache it.
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
	img, err := imgs.GetImage(r.Context(), id)
	if errors.Is(err, store.ErrNoImage) || (err == nil && img.Hash != hash) {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", img.ContentType)
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", `"`+img.Hash+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(img.Data)
}
