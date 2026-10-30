package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

// ErrNoAccess is returned for a project that has no access record: one created before
// sharing existed, open to anyone with its link until someone claims it.
var ErrNoAccess = errors.New("no access record")

// Access says who may change a project. The owner proves ownership with a secret whose
// SHA-256 is OwnerHash. EditToken is the key in the project's edit link; empty means the
// link is view-only. Access records are never served to clients.
type Access struct {
	OwnerHash string `json:"ownerHash"`
	EditToken string `json:"editToken,omitempty"`
}

// AccessStore keeps one access record per project. Deleting a project deletes it.
type AccessStore interface {
	GetAccess(ctx context.Context, id string) (Access, error)
	// CreateAccess stores a project's first access record; ErrExists if it has one.
	CreateAccess(ctx context.Context, id string, a Access) error
	PutAccess(ctx context.Context, id string, a Access) error
	DeleteAccess(ctx context.Context, id string) error
}

// ---------------------------------------------------------------- memory and file

func (m *Memory) GetAccess(_ context.Context, id string) (Access, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.access[id]
	if !ok {
		return Access{}, ErrNoAccess
	}
	return a, nil
}

func (m *Memory) CreateAccess(_ context.Context, id string, a Access) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.access[id]; ok {
		return ErrExists
	}
	return m.putAccess(id, &a)
}

func (m *Memory) PutAccess(_ context.Context, id string, a Access) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.putAccess(id, &a)
}

func (m *Memory) DeleteAccess(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.putAccess(id, nil)
}

// putAccess must be called with the lock held; nil deletes.
func (m *Memory) putAccess(id string, a *Access) error {
	if m.onAccess != nil {
		if err := m.onAccess(id, a); err != nil {
			return err
		}
	}
	if a == nil {
		delete(m.access, id)
	} else {
		m.access[id] = *a
	}
	return nil
}

// fileAccess loads dir/access/<id>.json and returns the hook that keeps it in step.
func fileAccess(dir string, into map[string]Access) (func(id string, a *Access) error, error) {
	accDir := filepath.Join(dir, "access")
	if err := os.MkdirAll(accDir, 0o700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(accDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(accDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var a Access
		if err := json.Unmarshal(b, &a); err != nil {
			return nil, err
		}
		into[e.Name()[:len(e.Name())-len(".json")]] = a
	}
	return func(id string, a *Access) error {
		path := filepath.Join(accDir, id+".json")
		if a == nil {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		}
		b, err := json.Marshal(a)
		if err != nil {
			return err
		}
		return writeAtomic(accDir, path, b)
	}, nil
}

// ------------------------------------------------------------------------- R2

func accessKey(id string) string { return "access/" + id + ".json" }

func (s *R2) GetAccess(ctx context.Context, id string) (Access, error) {
	res, err := s.do(ctx, http.MethodGet, accessKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return Access{}, ErrNoAccess
	}
	if err != nil {
		return Access{}, err
	}
	defer res.Body.Close()
	var a Access
	if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
		return Access{}, err
	}
	return a, nil
}

func (s *R2) putAccess(ctx context.Context, id string, a Access, cond http.Header) error {
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	h := http.Header{"Content-Type": {"application/json"}}
	for k, v := range cond {
		h[k] = v
	}
	res, err := s.do(ctx, http.MethodPut, accessKey(id), nil, h, b)
	if errors.Is(err, errPrecondition) {
		return ErrExists
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) CreateAccess(ctx context.Context, id string, a Access) error {
	return s.putAccess(ctx, id, a, http.Header{"If-None-Match": {"*"}})
}

func (s *R2) PutAccess(ctx context.Context, id string, a Access) error {
	return s.putAccess(ctx, id, a, nil)
}

func (s *R2) DeleteAccess(ctx context.Context, id string) error {
	res, err := s.do(ctx, http.MethodDelete, accessKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}
