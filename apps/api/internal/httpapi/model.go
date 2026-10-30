package httpapi

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"

	"github.com/zeecm/dream-home-designer/apps/api/internal/project"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

// MaxModelBytes caps an uploaded furniture model. The bundled ones are 50–600 KB; a
// scanned or high-detail piece from a maker's site can reach several MB.
const MaxModelBytes = 20 << 20

// MaxModelsPerProject caps how many models one project may hold.
const MaxModelsPerProject = 40

// modelUploads caps concurrent model uploads, each held whole in memory (up to 20 MB) on a
// small container; modelReads caps downloads, apart from plan images'.
var (
	modelUploads = make(chan struct{}, 2)
	modelReads   = make(chan struct{}, 8)
)

// referencedModels are the model hashes the project's document names now.
func (s *Server) referencedModels(r *http.Request, id string) (map[string]bool, error) {
	rec, err := s.store.Get(r.Context(), id)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Models map[string]struct {
			Hash string `json:"hash"`
		} `json:"models"`
	}
	if err := json.Unmarshal(rec.Doc, &doc); err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, m := range doc.Models {
		out[m.Hash] = true
	}
	return out, nil
}

// validGLB reports whether data is a binary glTF 2.0 file whose header length matches.
func validGLB(data []byte) bool {
	if len(data) < 20 || string(data[:4]) != "glTF" {
		return false
	}
	return binary.LittleEndian.Uint32(data[4:8]) == 2 &&
		int(binary.LittleEndian.Uint32(data[8:12])) == len(data)
}

// putModel stores a furniture model (binary glTF) for the project and returns its SHA-256,
// by which the document refers to it. Uploading the same file again changes nothing.
func (s *Server) putModel(w http.ResponseWriter, r *http.Request) {
	models, ok := s.store.(store.ModelStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store models")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	if !s.allow(w, r, id, Role.canEdit) {
		return
	}
	select {
	case modelUploads <- struct{}{}:
		defer func() { <-modelUploads }()
	case <-r.Context().Done():
		writeError(w, http.StatusServiceUnavailable, "busy, try again")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxModelBytes))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeError(w, http.StatusRequestEntityTooLarge, "model larger than 20 MB")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "the upload did not arrive in full")
		return
	}
	if !validGLB(data) {
		writeError(w, http.StatusUnsupportedMediaType, "upload a binary glTF (.glb) file")
		return
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	held, err := models.Models(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !slices.Contains(held, hash) {
		if len(held) >= MaxModelsPerProject {
			// Full: make room by dropping the models the plan no longer uses.
			used, err := s.referencedModels(r, id)
			if err != nil {
				s.fail(w, err)
				return
			}
			kept := 0
			for _, h := range held {
				if used[h] {
					kept++
				} else if err := models.DeleteModel(r.Context(), id, h); err != nil {
					s.fail(w, err)
					return
				}
			}
			if kept >= MaxModelsPerProject {
				writeError(w, http.StatusUnprocessableEntity, "this plan already has 40 models")
				return
			}
		}
		if err := models.PutModel(r.Context(), id, hash, data); err != nil {
			s.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"hash": hash})
}

// getModel serves a project's model. The hash in the URL names the content, so the
// response is immutable and cached; like plan images, it needs no key to read.
func (s *Server) getModel(w http.ResponseWriter, r *http.Request) {
	models, ok := s.store.(store.ModelStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store models")
		return
	}
	id := r.PathValue("id")
	hash := r.PathValue("hash")
	if !project.ValidID(id) || !hashPattern.MatchString(hash) {
		writeError(w, http.StatusBadRequest, "invalid project id or model hash")
		return
	}
	select {
	case modelReads <- struct{}{}:
		defer func() { <-modelReads }()
	case <-r.Context().Done():
		writeError(w, http.StatusServiceUnavailable, "busy, try again")
		return
	}
	size, body, err := models.OpenModel(r.Context(), id, hash)
	if errors.Is(err, store.ErrNoModel) {
		writeError(w, http.StatusNotFound, "model not found")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	defer body.Close()
	h := w.Header()
	h.Set("Content-Type", "model/gltf-binary")
	if size > 0 {
		h.Set("Content-Length", strconv.FormatInt(size, 10))
	}
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", `"`+hash+`"`)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, body)
	}
}

// listModels says which models the server holds for the project: {"hashes": [...]}, so a
// client uploads only what is missing. Like the image status, it needs no key.
func (s *Server) listModels(w http.ResponseWriter, r *http.Request) {
	models, ok := s.store.(store.ModelStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not store models")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	held, err := models.Models(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"hashes": held})
}
