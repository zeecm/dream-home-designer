package store

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"
)

// Memory is a goroutine-safe in-memory Store. An optional onWrite hook lets the file
// store persist each change while the lock is still held.
type Memory struct {
	mu      sync.RWMutex
	records map[string]Record
	now     func() time.Time
	onWrite func(rec Record, deleted bool) error
}

func NewMemory() *Memory {
	return &Memory{records: map[string]Record{}, now: time.Now}
}

func (m *Memory) List(_ context.Context) ([]Summary, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Summary, 0, len(m.records))
	for _, r := range m.records {
		out = append(out, Summary{ID: r.ID, Name: r.Name, Version: r.Version, UpdatedAt: r.UpdatedAt})
	}
	slices.SortFunc(out, func(a, b Summary) int {
		if c := b.UpdatedAt.Compare(a.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

func (m *Memory) Get(_ context.Context, id string) (Record, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.records[id]
	if !ok {
		return Record{}, ErrNotFound
	}
	r.Doc = slices.Clone(r.Doc)
	return r, nil
}

func (m *Memory) Create(_ context.Context, rec Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.records[rec.ID]; ok {
		return ErrExists
	}
	rec.Version = 1
	rec.Doc = slices.Clone(rec.Doc)
	rec.UpdatedAt = m.now()
	return m.put(rec)
}

func (m *Memory) Update(_ context.Context, id string, expected int, name string, build func(int) ([]byte, error)) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.records[id]
	if !ok {
		return 0, ErrNotFound
	}
	if cur.Version != expected {
		return 0, &ConflictError{Current: cur.Version}
	}
	next := expected + 1
	doc, err := build(next)
	if err != nil {
		return 0, err
	}
	if err := m.put(Record{ID: id, Name: name, Version: next, Doc: doc, UpdatedAt: m.now()}); err != nil {
		return 0, err
	}
	return next, nil
}

func (m *Memory) Delete(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.records[id]
	if !ok {
		return ErrNotFound
	}
	if m.onWrite != nil {
		if err := m.onWrite(rec, true); err != nil {
			return err
		}
	}
	delete(m.records, id)
	return nil
}

// put must be called with the lock held. It persists before updating memory, so a
// failed write leaves the store unchanged.
func (m *Memory) put(rec Record) error {
	if m.onWrite != nil {
		if err := m.onWrite(rec, false); err != nil {
			return err
		}
	}
	m.records[rec.ID] = rec
	return nil
}
