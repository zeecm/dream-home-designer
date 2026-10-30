package store

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// ErrNoModel is returned when a project has no model with that hash.
var ErrNoModel = errors.New("model not found")

// ModelStore keeps the furniture models people upload to a project: binary glTF files,
// any number per project, each named by the hex SHA-256 of its bytes, which the document
// refers to. Deleting a project deletes its models.
type ModelStore interface {
	PutModel(ctx context.Context, id, hash string, data []byte) error
	// OpenModel streams a model and gives its size; the caller closes the reader.
	OpenModel(ctx context.Context, id, hash string) (int64, io.ReadCloser, error)
	// Models lists the hashes the project holds.
	Models(ctx context.Context, id string) ([]string, error)
	// DeleteModel removes one model (no error if it is already gone).
	DeleteModel(ctx context.Context, id, hash string) error
	DeleteModels(ctx context.Context, id string) error
}

// ---------------------------------------------------------------- memory and file

func (m *Memory) PutModel(_ context.Context, id, hash string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.records[id]; !ok {
		return ErrNotFound
	}
	data = slices.Clone(data)
	if m.onModel != nil {
		if err := m.onModel(id, hash, data); err != nil {
			return err
		}
	}
	if m.models[id] == nil {
		m.models[id] = map[string][]byte{}
	}
	if m.modelFile != nil {
		data = nil // on disk; read when asked for
	}
	m.models[id][hash] = data
	return nil
}

// OpenModel reads the stored bytes in place: PutModel stores a private copy that is never
// modified.
func (m *Memory) OpenModel(_ context.Context, id, hash string) (int64, io.ReadCloser, error) {
	m.mu.RLock()
	data, ok := m.models[id][hash]
	m.mu.RUnlock()
	if !ok {
		return 0, nil, ErrNoModel
	}
	if m.modelFile != nil {
		f, err := os.Open(m.modelFile(id, hash))
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil, ErrNoModel
		}
		if err != nil {
			return 0, nil, err
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return 0, nil, err
		}
		return st.Size(), f, nil
	}
	return int64(len(data)), io.NopCloser(bytes.NewReader(data)), nil
}

func (m *Memory) DeleteModel(_ context.Context, id, hash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.models[id][hash]; !ok {
		return nil
	}
	if m.modelFile != nil {
		if err := os.Remove(m.modelFile(id, hash)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	delete(m.models[id], hash)
	return nil
}

func (m *Memory) Models(_ context.Context, id string) ([]string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]string, 0, len(m.models[id]))
	for h := range m.models[id] {
		out = append(out, h)
	}
	slices.Sort(out)
	return out, nil
}

func (m *Memory) DeleteModels(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deleteModels(id)
}

// deleteModels must be called with the lock held.
func (m *Memory) deleteModels(id string) error {
	if _, ok := m.models[id]; !ok {
		return nil
	}
	if m.onModel != nil {
		if err := m.onModel(id, "", nil); err != nil {
			return err
		}
	}
	delete(m.models, id)
	return nil
}

// fileModels lists dir/models/<id>/<hash>.glb (their bytes stay on disk until asked for)
// and returns the hook that keeps the folder in step with the store: (id, hash, data)
// writes one, (id, "", nil) removes the project's; and where each one lives.
func fileModels(dir string, into map[string]map[string][]byte) (func(id, hash string, data []byte) error, func(id, hash string) string, error) {
	root := filepath.Join(dir, "models")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, nil, err
	}
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil, nil, err
	}
	for _, p := range projects {
		if !p.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, p.Name()))
		if err != nil {
			return nil, nil, err
		}
		for _, f := range files {
			hash, ok := strings.CutSuffix(f.Name(), ".glb")
			if !ok {
				continue // a half-written temporary file
			}
			if into[p.Name()] == nil {
				into[p.Name()] = map[string][]byte{}
			}
			into[p.Name()][hash] = nil
		}
	}
	path := func(id, hash string) string { return filepath.Join(root, id, hash+".glb") }
	return func(id, hash string, data []byte) error {
		d := filepath.Join(root, id)
		if data == nil {
			return os.RemoveAll(d)
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
		return writeAtomic(d, path(id, hash), data)
	}, path, nil
}

// ------------------------------------------------------------------------- R2

func modelPrefix(id string) string    { return "models/" + id + "/" }
func modelKey(id, hash string) string { return modelPrefix(id) + hash }

func (s *R2) PutModel(ctx context.Context, id, hash string, data []byte) error {
	if _, err := s.head(ctx, id); err != nil {
		return err
	}
	h := http.Header{"Content-Type": {"model/gltf-binary"}}
	res, err := s.do(ctx, http.MethodPut, modelKey(id, hash), nil, h, data)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) OpenModel(ctx context.Context, id, hash string) (int64, io.ReadCloser, error) {
	res, err := s.do(ctx, http.MethodGet, modelKey(id, hash), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return 0, nil, ErrNoModel
	}
	if err != nil {
		return 0, nil, err
	}
	size, _ := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64)
	return size, res.Body, nil
}

func (s *R2) Models(ctx context.Context, id string) ([]string, error) {
	prefix := modelPrefix(id)
	q := url.Values{"list-type": {"2"}, "prefix": {prefix}, "max-keys": {"1000"}}
	res, err := s.do(ctx, http.MethodGet, "", q, nil, nil)
	if err != nil {
		return nil, err
	}
	var page struct {
		Contents []struct{ Key string }
	}
	err = xml.NewDecoder(res.Body).Decode(&page)
	res.Body.Close()
	if err != nil {
		return nil, fmt.Errorf("r2 list models: %w", err)
	}
	out := make([]string, 0, len(page.Contents))
	for _, c := range page.Contents {
		out = append(out, strings.TrimPrefix(c.Key, prefix))
	}
	slices.Sort(out)
	return out, nil
}

func (s *R2) DeleteModel(ctx context.Context, id, hash string) error {
	res, err := s.do(ctx, http.MethodDelete, modelKey(id, hash), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) DeleteModels(ctx context.Context, id string) error {
	hashes, err := s.Models(ctx, id)
	if err != nil {
		return err
	}
	for _, h := range hashes {
		res, err := s.do(ctx, http.MethodDelete, modelKey(id, h), nil, nil, nil)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		res.Body.Close()
	}
	return nil
}
