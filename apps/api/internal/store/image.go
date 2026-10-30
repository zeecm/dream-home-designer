package store

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// ErrNoImage is returned when a project has no plan image.
var ErrNoImage = errors.New("image not found")

// Image is a project's plan image (the picture traced under the walls). A project has at
// most one; uploading another replaces it. Hash is the hex SHA-256 of Data, which the
// document refers to, so a stale reference never shows the wrong picture.
type Image struct {
	Hash        string
	ContentType string
	Data        []byte
}

// ImageStore keeps one plan image per project. Deleting a project deletes its image.
type ImageStore interface {
	PutImage(ctx context.Context, id string, img Image) error
	GetImage(ctx context.Context, id string) (Image, error)
}

// ---------------------------------------------------------------- memory and file

func (m *Memory) PutImage(_ context.Context, id string, img Image) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.records[id]; !ok {
		return ErrNotFound
	}
	img.Data = slices.Clone(img.Data)
	if m.onImage != nil {
		if err := m.onImage(id, &img); err != nil {
			return err
		}
	}
	m.images[id] = img
	return nil
}

func (m *Memory) GetImage(_ context.Context, id string) (Image, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	img, ok := m.images[id]
	if !ok {
		return Image{}, ErrNoImage
	}
	img.Data = slices.Clone(img.Data)
	return img, nil
}

// deleteImage must be called with the lock held.
func (m *Memory) deleteImage(id string) error {
	if _, ok := m.images[id]; !ok {
		return nil
	}
	if m.onImage != nil {
		if err := m.onImage(id, nil); err != nil {
			return err
		}
	}
	delete(m.images, id)
	return nil
}

type imageMeta struct {
	Hash        string `json:"hash"`
	ContentType string `json:"contentType"`
}

// fileImages loads dir/images and returns the hook that keeps it in step with the store:
// each image is <id>.bin with its hash and type in <id>.meta.json.
func fileImages(dir string, into map[string]Image) (func(id string, img *Image) error, error) {
	imgDir := filepath.Join(dir, "images")
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(imgDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".meta.json")
		if !ok {
			continue
		}
		b, err := os.ReadFile(filepath.Join(imgDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var meta imageMeta
		if err := json.Unmarshal(b, &meta); err != nil {
			return nil, err
		}
		data, err := os.ReadFile(filepath.Join(imgDir, id+".bin"))
		if err != nil {
			return nil, err
		}
		into[id] = Image{Hash: meta.Hash, ContentType: meta.ContentType, Data: data}
	}
	return func(id string, img *Image) error {
		bin := filepath.Join(imgDir, id+".bin")
		meta := filepath.Join(imgDir, id+".meta.json")
		if img == nil {
			for _, p := range []string{meta, bin} {
				if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
			return nil
		}
		if err := writeAtomic(imgDir, bin, img.Data); err != nil {
			return err
		}
		b, err := json.Marshal(imageMeta{Hash: img.Hash, ContentType: img.ContentType})
		if err != nil {
			return err
		}
		return writeAtomic(imgDir, meta, b)
	}, nil
}

func writeAtomic(dir, path string, b []byte) error {
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// ------------------------------------------------------------------------- R2

const (
	imagePrefix = "images/"
	metaHash    = "X-Amz-Meta-Hash"
	metaType    = "X-Amz-Meta-Type"
)

func imageKey(id string) string { return imagePrefix + id }

func (s *R2) PutImage(ctx context.Context, id string, img Image) error {
	if _, err := s.head(ctx, id); err != nil {
		return err
	}
	h := http.Header{
		"Content-Type": {img.ContentType},
		metaHash:       {img.Hash},
		metaType:       {img.ContentType},
	}
	res, err := s.do(ctx, http.MethodPut, imageKey(id), nil, h, img.Data)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) GetImage(ctx context.Context, id string) (Image, error) {
	res, err := s.do(ctx, http.MethodGet, imageKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return Image{}, ErrNoImage
	}
	if err != nil {
		return Image{}, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return Image{}, err
	}
	return Image{Hash: res.Header.Get(metaHash), ContentType: res.Header.Get(metaType), Data: data}, nil
}

func (s *R2) deleteImage(ctx context.Context, id string) error {
	res, err := s.do(ctx, http.MethodDelete, imageKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}
