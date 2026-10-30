package httpapi

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/zeecm/dream-home-designer/apps/api/internal/project"
	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

// Role is what a request may do with a project.
type Role string

const (
	RoleOwner  Role = "owner"  // edit, share and delete
	RoleEditor Role = "editor" // edit, through the project's edit link
	RoleViewer Role = "viewer" // look only: the plain link
	// RoleOpen is a project from before sharing existed: anyone with its link may edit
	// until a browser that knows it claims it.
	RoleOpen Role = "open"
)

func (r Role) canEdit() bool { return r == RoleOwner || r == RoleEditor || r == RoleOpen }

func newToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err) // the system's randomness is gone; nothing sensible to do
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

func same(a, b string) bool {
	return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// role works out what the request's bearer token allows on project id.
func (s *Server) role(r *http.Request, id string) (Role, store.Access, error) {
	acc, ok := s.store.(store.AccessStore)
	if !ok {
		return RoleOpen, store.Access{}, nil
	}
	a, err := acc.GetAccess(r.Context(), id)
	if errors.Is(err, store.ErrNoAccess) {
		return RoleOpen, a, nil
	}
	if err != nil {
		return "", a, err
	}
	t := bearer(r)
	switch {
	case t != "" && same(hashToken(t), a.OwnerHash):
		return RoleOwner, a, nil
	case same(t, a.EditToken):
		return RoleEditor, a, nil
	default:
		return RoleViewer, a, nil
	}
}

// allow answers for the caller and returns false unless the request's role passes ok.
func (s *Server) allow(w http.ResponseWriter, r *http.Request, id string, ok func(Role) bool) bool {
	role, _, err := s.role(r, id)
	if err != nil {
		s.fail(w, err)
		return false
	}
	if !ok(role) {
		writeError(w, http.StatusForbidden, "this link can only view the plan")
		return false
	}
	return true
}

type shareState struct {
	// Edit is the key for the project's edit link, or null when the link is view-only.
	Edit *string `json:"edit"`
}

func shareOf(a store.Access) shareState {
	if a.EditToken == "" {
		return shareState{}
	}
	t := a.EditToken
	return shareState{Edit: &t}
}

// getShare tells the owner how the project is shared.
func (s *Server) getShare(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	role, a, err := s.role(r, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if role != RoleOwner {
		writeError(w, http.StatusForbidden, "only the plan's owner can change how it is shared")
		return
	}
	writeJSON(w, http.StatusOK, shareOf(a))
}

// putShare turns the edit link on or off, or replaces its key so old edit links stop
// working: {"edit": true|false, "reset": true|false}.
func (s *Server) putShare(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	var body struct {
		Edit  bool `json:"edit"`
		Reset bool `json:"reset"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, `expected {"edit": true|false}`)
		return
	}
	role, a, err := s.role(r, id)
	if err != nil {
		s.fail(w, err)
		return
	}
	if role != RoleOwner {
		writeError(w, http.StatusForbidden, "only the plan's owner can change how it is shared")
		return
	}
	switch {
	case !body.Edit:
		a.EditToken = ""
	case a.EditToken == "" || body.Reset:
		a.EditToken = newToken()
	}
	if err := s.store.(store.AccessStore).PutAccess(r.Context(), id, a); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, shareOf(a))
}

// claim makes the caller the owner of a project from before sharing existed. It works
// once: a project that has an owner can't be claimed.
func (s *Server) claim(w http.ResponseWriter, r *http.Request) {
	acc, ok := s.store.(store.AccessStore)
	if !ok {
		writeError(w, http.StatusNotImplemented, "this server does not keep owners")
		return
	}
	id := r.PathValue("id")
	if !project.ValidID(id) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	if _, err := s.store.Get(r.Context(), id); err != nil {
		s.fail(w, err)
		return
	}
	owner := newToken()
	if err := acc.CreateAccess(r.Context(), id, store.Access{OwnerHash: hashToken(owner)}); err != nil {
		if errors.Is(err, store.ErrExists) {
			writeError(w, http.StatusConflict, "this plan already has an owner")
			return
		}
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"owner": owner})
}
