package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// fileRecord is the on-disk form: metadata plus the raw document.
type fileRecord struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Version   int             `json:"version"`
	UpdatedAt time.Time       `json:"updatedAt"`
	Doc       json.RawMessage `json:"doc"`
}

// NewFile returns a Store that keeps everything in memory and writes each project to
// dir/<id>.json atomically. It is for local development; production uses Postgres.
func NewFile(dir string) (*Memory, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	m := NewMemory()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		var fr fileRecord
		if err := json.Unmarshal(b, &fr); err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		m.records[fr.ID] = Record{ID: fr.ID, Name: fr.Name, Version: fr.Version, Doc: fr.Doc, UpdatedAt: fr.UpdatedAt}
	}
	if m.onImage, err = fileImages(dir, m.images); err != nil {
		return nil, err
	}
	if m.onModel, m.modelFile, err = fileModels(dir, m.models); err != nil {
		return nil, err
	}
	if m.onAccess, err = fileAccess(dir, m.access); err != nil {
		return nil, err
	}
	m.onWrite = func(rec Record, deleted bool) error {
		path := filepath.Join(dir, rec.ID+".json")
		if deleted {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		}
		b, err := json.Marshal(fileRecord{ID: rec.ID, Name: rec.Name, Version: rec.Version, UpdatedAt: rec.UpdatedAt, Doc: rec.Doc})
		if err != nil {
			return err
		}
		return writeAtomic(dir, path, b)
	}
	return m, nil
}
