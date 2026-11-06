package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/rand/v2"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/zeecm/dream-home-designer/apps/api/internal/comments"
	"github.com/zeecm/dream-home-designer/apps/api/internal/project"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

// commentAttempts bounds the read-apply-write loop. The per-project lock serialises
// writers within this process (the Worker routes everything to one container), so a
// clash only happens while two instances overlap during a rollout.
const commentAttempts = 5

// authorPattern is the browser's random author key: 24 bytes as base64url.
var authorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32}$`)

// projectLocks serialises comment writes per project. An entry is removed once nobody
// holds or waits for it, so the map stays the size of the projects being written.
type projectLocks struct {
	mu    sync.Mutex
	locks map[string]*projectLock
}

type projectLock struct {
	// held is a one-place channel: full while someone holds the lock, so waiting for it can
	// give up when the request's context ends.
	held  chan struct{}
	users int
}

// lock waits for the project's lock and returns its unlock, or the context's error if the
// caller went away first.
func (p *projectLocks) lock(ctx context.Context, id string) (func(), error) {
	p.mu.Lock()
	if p.locks == nil {
		p.locks = map[string]*projectLock{}
	}
	l := p.locks[id]
	if l == nil {
		l = &projectLock{held: make(chan struct{}, 1)}
		p.locks[id] = l
	}
	l.users++
	p.mu.Unlock()
	leave := func() {
		p.mu.Lock()
		if l.users--; l.users == 0 {
			delete(p.locks, id)
		}
		p.mu.Unlock()
	}
	select {
	case l.held <- struct{}{}:
		return func() {
			<-l.held
			leave()
		}, nil
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
}

func (p *projectLocks) size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.locks)
}

func (s *Server) routeComments() {
	s.mux.HandleFunc("GET /projects/{id}/comments", s.getComments)
	s.mux.HandleFunc("POST /projects/{id}/comments", s.addThread)
	s.mux.HandleFunc("PATCH /projects/{id}/comments", s.setCommentSetting)
	s.mux.HandleFunc("DELETE /projects/{id}/comments", s.deleteResolved)
	s.mux.HandleFunc("POST /projects/{id}/comments/{thread}/replies", s.addReply)
	s.mux.HandleFunc("PATCH /projects/{id}/comments/{thread}", s.resolveThread)
	s.mux.HandleFunc("DELETE /projects/{id}/comments/{thread}", s.deleteThread)
	s.mux.HandleFunc("DELETE /projects/{id}/comments/{thread}/replies/{msg}", s.deleteReply)
}

// commentStore answers for a server without comments, or a bad project id.
func (s *Server) commentStore(w http.ResponseWriter, r *http.Request) (store.CommentStore, string, bool) {
	cs, ok := s.store.(store.CommentStore)
	if !ok {
		writeCode(w, http.StatusNotImplemented, "unsupported", "this server does not keep comments")
		return nil, "", false
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeCode(w, http.StatusBadRequest, "invalid", "invalid project id")
		return nil, "", false
	}
	return cs, id, true
}

func authorHash(id, key string) string {
	sum := sha256.Sum256([]byte(id + "|" + key))
	return hex.EncodeToString(sum[:])
}

// commentHeaders: the response depends on the caller's link key and author key.
func commentHeaders(w http.ResponseWriter, role Role, doc comments.Doc) {
	w.Header().Set("X-Role", string(role))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Authorization, X-Comment-Author")
	w.Header().Set("ETag", doc.ETag())
}

func (s *Server) getComments(w http.ResponseWriter, r *http.Request) {
	cs, id, ok := s.commentStore(w, r)
	if !ok {
		return
	}
	rec, err := cs.GetComments(r.Context(), id)
	if err != nil {
		s.fail(w, err)
		return
	}
	role, _, err := s.role(r, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	doc, err := comments.Decode(rec.Doc)
	if err != nil {
		s.fail(w, err)
		return
	}
	doc.Version = rec.Version
	commentHeaders(w, role, doc)
	if noneMatch(r.Header.Get("If-None-Match"), doc.ETag()) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	hash := ""
	if key := r.Header.Get("X-Comment-Author"); authorPattern.MatchString(key) {
		hash = authorHash(id, key)
	}
	writeJSON(w, http.StatusOK, comments.ViewFor(doc, hash))
}

// noneMatch reports whether an If-None-Match header names tag: a list, weak tags and *
// are all allowed.
func noneMatch(h, tag string) bool {
	for _, part := range strings.Split(h, ",") {
		part = strings.TrimSpace(part)
		if part == "*" {
			return true
		}
		if part != "" && strings.TrimPrefix(part, "W/") == tag {
			return true
		}
	}
	return false
}

// parseOp decodes the request body into o and validates it.
func parseOp[T interface {
	comments.Op
	Validate() error
}](r *http.Request, o T) (comments.Op, error) {
	if err := comments.DecodeBody(r.Body, o); err != nil {
		return nil, err
	}
	if err := o.Validate(); err != nil {
		return nil, err
	}
	return o, nil
}

// commentWrite builds the operation from the request, then applies it under the project's
// lock, retrying when the stored comments changed underneath. created is the status for a
// write that changed something (201 for posts); an operation that changes nothing answers
// 200 without writing.
func (s *Server) commentWrite(w http.ResponseWriter, r *http.Request, created int, build func() (comments.Op, error)) {
	cs, id, ok := s.commentStore(w, r)
	if !ok {
		return
	}
	// A JSON content type and the author header: a cross-site form can send neither.
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		writeCode(w, http.StatusUnsupportedMediaType, "invalid", "send Content-Type: application/json")
		return
	}
	key := r.Header.Get("X-Comment-Author")
	if !authorPattern.MatchString(key) {
		writeCode(w, http.StatusBadRequest, "invalid", "X-Comment-Author must be 32 base64url characters")
		return
	}
	op, err := build()
	if err != nil {
		s.commentFail(w, err)
		return
	}
	role, _, err := s.role(r, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	actor := comments.Actor{Role: string(role), AuthHash: authorHash(id, key)}

	// The caller may go while it waits for the lock: then there is nothing to answer.
	unlock, err := s.commentLocks.lock(r.Context(), id)
	if err != nil {
		return
	}
	defer unlock()
	for attempt := 0; attempt < commentAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(time.Duration(20+rand.IntN(81)) * time.Millisecond):
			}
		}
		rec, err := cs.GetComments(r.Context(), id)
		if err != nil {
			s.fail(w, err)
			return
		}
		doc, err := comments.Decode(rec.Doc)
		if err != nil {
			s.fail(w, err)
			return
		}
		doc.Version = rec.Version
		changed, err := op.Apply(&doc, actor, s.now())
		if err != nil {
			s.commentFail(w, err)
			return
		}
		if !changed {
			commentHeaders(w, role, doc)
			writeJSON(w, http.StatusOK, comments.ViewFor(doc, actor.AuthHash))
			return
		}
		doc.Version = rec.Version + 1
		if doc.Epoch == "" {
			doc.Epoch = comments.NewEpoch()
		}
		b, err := comments.Encode(doc)
		if err != nil {
			s.commentFail(w, err)
			return
		}
		err = cs.PutComments(r.Context(), id, rec, b)
		if errors.Is(err, store.ErrCommentsChanged) {
			continue
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		commentHeaders(w, role, doc)
		writeJSON(w, created, comments.ViewFor(doc, actor.AuthHash))
		return
	}
	if r.Context().Err() != nil {
		return
	}
	w.Header().Set("Retry-After", "1")
	writeCode(w, http.StatusServiceUnavailable, "busy", "Comments are busy. Try again in a moment.")
}

var errBadCommentID = &comments.Error{Status: http.StatusBadRequest, Code: "invalid", Msg: "invalid comment id"}

// pathIDs checks the comment ids in the path.
func pathIDs(r *http.Request, names ...string) error {
	for _, n := range names {
		if !comments.ValidID(r.PathValue(n)) {
			return errBadCommentID
		}
	}
	return nil
}

func (s *Server) addThread(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusCreated, func() (comments.Op, error) {
		return parseOp(r, &comments.AddThread{})
	})
}

func (s *Server) addReply(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusCreated, func() (comments.Op, error) {
		if err := pathIDs(r, "thread"); err != nil {
			return nil, err
		}
		return parseOp(r, &comments.AddReply{Thread: r.PathValue("thread")})
	})
}

func (s *Server) resolveThread(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusOK, func() (comments.Op, error) {
		if err := pathIDs(r, "thread"); err != nil {
			return nil, err
		}
		return parseOp(r, &comments.Resolve{Thread: r.PathValue("thread")})
	})
}

func (s *Server) setCommentSetting(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusOK, func() (comments.Op, error) {
		return parseOp(r, &comments.SetSetting{})
	})
}

func (s *Server) deleteThread(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusOK, func() (comments.Op, error) {
		return comments.DeleteThread{Thread: r.PathValue("thread")}, pathIDs(r, "thread")
	})
}

func (s *Server) deleteReply(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusOK, func() (comments.Op, error) {
		return comments.DeleteReply{Thread: r.PathValue("thread"), Message: r.PathValue("msg")}, pathIDs(r, "thread", "msg")
	})
}

func (s *Server) deleteResolved(w http.ResponseWriter, r *http.Request) {
	s.commentWrite(w, r, http.StatusOK, func() (comments.Op, error) {
		if r.URL.Query().Get("resolved") != "true" {
			return nil, &comments.Error{Status: http.StatusBadRequest, Code: "invalid", Msg: "only resolved comments can be deleted together: ?resolved=true"}
		}
		return comments.DeleteResolved{}, nil
	})
}

func (s *Server) commentFail(w http.ResponseWriter, err error) {
	if e, ok := comments.AsError(err); ok {
		writeCode(w, e.Status, e.Code, e.Msg)
		return
	}
	s.fail(w, err)
}

// clearComments drops comments left behind under a new project's id (a delete that
// failed half way, or a comment write racing the delete).
func (s *Server) clearComments(ctx context.Context, id string) {
	if cs, ok := s.store.(store.CommentStore); ok {
		// Not while a comment write is between its read and its write.
		unlock, err := s.commentLocks.lock(ctx, id)
		if err != nil {
			return
		}
		defer unlock()
		if err := cs.DeleteComments(ctx, id); err != nil {
			s.log.Error("clear leftover comments", "id", id, "err", err)
		}
	}
}

func writeCode(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": msg, "code": code})
}
