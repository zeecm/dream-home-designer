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
	"strconv"
)

// ErrCommentsChanged is returned when the comments changed since they were read.
var ErrCommentsChanged = errors.New("comments changed since they were read")

// CommentsRec is a project's comments document as read. Version 0 and no Doc means the
// project has none yet. tag is the R2 ETag the next write is conditional on.
type CommentsRec struct {
	Doc     []byte
	Version int
	tag     string
}

// CommentStore keeps one comments document per project, versioned on its own: a comment
// never changes the project's version, and a save never changes the comments'.
type CommentStore interface {
	// GetComments returns the project's comments; ErrNotFound only if the project is
	// missing.
	GetComments(ctx context.Context, id string) (CommentsRec, error)
	// PutComments stores doc as version prev.Version+1 if the comments are still prev;
	// otherwise ErrCommentsChanged. A project deleted since prev was read gives
	// ErrNotFound (or ErrCommentsChanged, and then ErrNotFound on the next read).
	PutComments(ctx context.Context, id string, prev CommentsRec, doc []byte) error
	// DeleteComments removes them (no error if there are none).
	DeleteComments(ctx context.Context, id string) error
}

// ---------------------------------------------------------------- memory and file

type memoryComments struct {
	doc     []byte
	version int
}

func (m *Memory) GetComments(_ context.Context, id string) (CommentsRec, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.records[id]; !ok {
		return CommentsRec{}, ErrNotFound
	}
	c := m.comments[id]
	return CommentsRec{Doc: slices.Clone(c.doc), Version: c.version}, nil
}

func (m *Memory) PutComments(_ context.Context, id string, prev CommentsRec, doc []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.records[id]; !ok {
		return ErrNotFound
	}
	if m.comments[id].version != prev.Version {
		return ErrCommentsChanged
	}
	return m.putComments(id, &memoryComments{doc: slices.Clone(doc), version: prev.Version + 1})
}

func (m *Memory) DeleteComments(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.comments[id]; !ok {
		return nil
	}
	return m.putComments(id, nil)
}

// putComments must be called with the lock held; nil deletes.
func (m *Memory) putComments(id string, c *memoryComments) error {
	if m.onComments != nil {
		if err := m.onComments(id, c); err != nil {
			return err
		}
	}
	if c == nil {
		delete(m.comments, id)
	} else {
		m.comments[id] = *c
	}
	return nil
}

type fileComments struct {
	Version int             `json:"version"`
	Doc     json.RawMessage `json:"doc"`
}

// fileCommentsHook loads dir/comments/<id>.json and returns the hook that keeps it in step.
func fileCommentsHook(dir string, into map[string]memoryComments) (func(id string, c *memoryComments) error, error) {
	cDir := filepath.Join(dir, "comments")
	if err := os.MkdirAll(cDir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(cDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(cDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var fc fileComments
		if err := json.Unmarshal(b, &fc); err != nil {
			return nil, err
		}
		into[e.Name()[:len(e.Name())-len(".json")]] = memoryComments{doc: fc.Doc, version: fc.Version}
	}
	return func(id string, c *memoryComments) error {
		path := filepath.Join(cDir, id+".json")
		if c == nil {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		}
		b, err := json.Marshal(fileComments{Version: c.version, Doc: c.doc})
		if err != nil {
			return err
		}
		return writeAtomic(cDir, path, b)
	}, nil
}

// ------------------------------------------------------------------------- R2

func commentsKey(id string) string        { return "comments/" + id + ".json" }
func deletedCommentsKey(id string) string { return "deleted/" + id + ".comments.json" }

func (s *R2) GetComments(ctx context.Context, id string) (CommentsRec, error) {
	res, err := s.do(ctx, http.MethodGet, commentsKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		// Most projects have no comments: check the project exists with a HEAD, not a GET.
		if _, err := s.head(ctx, id); err != nil {
			return CommentsRec{}, err
		}
		return CommentsRec{}, nil
	}
	if err != nil {
		return CommentsRec{}, err
	}
	defer res.Body.Close()
	v, err := strconv.Atoi(res.Header.Get(metaVersion))
	if err != nil {
		return CommentsRec{}, errors.New("comments object has no version metadata")
	}
	doc, err := io.ReadAll(res.Body)
	if err != nil {
		return CommentsRec{}, err
	}
	return CommentsRec{Doc: doc, Version: v, tag: res.Header.Get("ETag")}, nil
}

func (s *R2) PutComments(ctx context.Context, id string, prev CommentsRec, doc []byte) error {
	h := http.Header{
		"Content-Type": {"application/json"},
		metaVersion:    {strconv.Itoa(prev.Version + 1)},
	}
	if prev.tag == "" {
		// The first write: the project may have gone since the read (a later write is
		// safe, as a project's delete takes its comments and so fails the If-Match).
		if _, err := s.head(ctx, id); err != nil {
			return err
		}
		h.Set("If-None-Match", "*")
	} else {
		h.Set("If-Match", prev.tag)
	}
	res, err := s.do(ctx, http.MethodPut, commentsKey(id), nil, h, doc)
	if errors.Is(err, errPrecondition) {
		return ErrCommentsChanged
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) DeleteComments(ctx context.Context, id string) error {
	res, err := s.do(ctx, http.MethodDelete, commentsKey(id), nil, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// keepAndDeleteComments copies a deleted project's comments to the recovery prefix (they
// expire with its other copies) and deletes them. A failure stops the project's delete,
// so a project recreated with its id can't inherit them.
func (s *R2) keepAndDeleteComments(ctx context.Context, id string) error {
	err := s.copy(ctx, commentsKey(id), deletedCommentsKey(id), "")
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return s.DeleteComments(ctx, id)
}
