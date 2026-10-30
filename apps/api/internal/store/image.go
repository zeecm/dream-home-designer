package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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

// ImageInfo describes a stored image without its bytes.
type ImageInfo struct {
	Hash        string
	ContentType string
	Size        int64
}

// ImageStore keeps one plan image per project. Deleting a project deletes its image.
// Reads come in two steps, so a request for a stale hash, or a HEAD, never pulls the bytes.
type ImageStore interface {
	PutImage(ctx context.Context, id string, img Image) error
	ImageInfo(ctx context.Context, id string) (ImageInfo, error)
	// OpenImage streams the image; the caller closes the reader.
	OpenImage(ctx context.Context, id string) (ImageInfo, io.ReadCloser, error)
	DeleteImage(ctx context.Context, id string) error
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

func (m *Memory) ImageInfo(_ context.Context, id string) (ImageInfo, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	img, ok := m.images[id]
	if !ok {
		return ImageInfo{}, ErrNoImage
	}
	return ImageInfo{Hash: img.Hash, ContentType: img.ContentType, Size: int64(len(img.Data))}, nil
}

// OpenImage reads the stored bytes in place: PutImage stores a private copy that is never
// modified, only replaced.
func (m *Memory) OpenImage(ctx context.Context, id string) (ImageInfo, io.ReadCloser, error) {
	m.mu.RLock()
	img, ok := m.images[id]
	m.mu.RUnlock()
	if !ok {
		return ImageInfo{}, nil, ErrNoImage
	}
	info := ImageInfo{Hash: img.Hash, ContentType: img.ContentType, Size: int64(len(img.Data))}
	return info, io.NopCloser(bytes.NewReader(img.Data)), nil
}

func (m *Memory) DeleteImage(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.deleteImage(id)
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

// fileImages loads dir/images and returns the hook that keeps it in step with the store.
// Each image is <id>.<hash>.bin, named by <id>.meta.json. The bytes are written before the
// meta that points at them, so a crash in between leaves the previous image whole.
func fileImages(dir string, into map[string]Image) (func(id string, img *Image) error, error) {
	imgDir := filepath.Join(dir, "images")
	if err := os.MkdirAll(imgDir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(imgDir)
	if err != nil {
		return nil, err
	}
	binOf := func(id, hash string) string { return filepath.Join(imgDir, id+"."+hash+".bin") }
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
		data, err := os.ReadFile(binOf(id, meta.Hash))
		if errors.Is(err, os.ErrNotExist) {
			continue // a half-written image: as if there were none
		}
		if err != nil {
			return nil, err
		}
		into[id] = Image{Hash: meta.Hash, ContentType: meta.ContentType, Data: data}
	}
	// removeOthers deletes every <id>.*.bin except keep.
	removeOthers := func(id, keep string) error {
		olds, err := filepath.Glob(filepath.Join(imgDir, id+".*.bin"))
		if err != nil {
			return err
		}
		for _, p := range olds {
			if p == keep {
				continue
			}
			if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		return nil
	}
	return func(id string, img *Image) error {
		meta := filepath.Join(imgDir, id+".meta.json")
		if img == nil {
			if err := os.Remove(meta); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return removeOthers(id, "")
		}
		bin := binOf(id, img.Hash)
		if err := writeAtomic(imgDir, bin, img.Data); err != nil {
			return err
		}
		b, err := json.Marshal(imageMeta{Hash: img.Hash, ContentType: img.ContentType})
		if err != nil {
			return err
		}
		if err := writeAtomic(imgDir, meta, b); err != nil {
			return err
		}
		return removeOthers(id, bin)
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

func imageInfoFrom(h http.Header) ImageInfo {
	size, _ := strconv.ParseInt(h.Get("Content-Length"), 10, 64)
	return ImageInfo{Hash: h.Get(metaHash), ContentType: h.Get(metaType), Size: size}
}

func (s *R2) ImageInfo(ctx context.Context, id string) (ImageInfo, error) {
	res, err := s.do(ctx, http.MethodHead, imageKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return ImageInfo{}, ErrNoImage
	}
	if err != nil {
		return ImageInfo{}, err
	}
	res.Body.Close()
	return imageInfoFrom(res.Header), nil
}

func (s *R2) OpenImage(ctx context.Context, id string) (ImageInfo, io.ReadCloser, error) {
	res, err := s.do(ctx, http.MethodGet, imageKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return ImageInfo{}, nil, ErrNoImage
	}
	if err != nil {
		return ImageInfo{}, nil, err
	}
	return imageInfoFrom(res.Header), res.Body, nil
}

func (s *R2) DeleteImage(ctx context.Context, id string) error {
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
