// Package comments is the format of a project's comments document and the operations on
// it: adding a thread or a reply, resolving, deleting and the owner's setting. Unlike a
// project, the server understands this document: it enforces authorship, rights and
// limits. The operations are pure functions on a Doc; the HTTP layer loads, applies and
// stores them.
//
// The zod mirror in packages/core/src/comments.ts parses testdata/comments.json, so the
// two can't drift apart.
package comments

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Limits.
const (
	MaxText           = 1000 // runes, after trimming
	MaxName           = 40
	MaxLabel          = 80
	MaxCoord          = 1000.0 // metres, either way
	MaxOffset         = 10.0   // a wall pin's distance across the wall, metres
	MaxRel            = 100.0  // a pin's offset in an item's frame, metres
	MaxThreadMessages = 50
	MaxMessages       = 300     // per project, resolved threads included
	MaxDocBytes       = 1 << 20 // the stored document
	MaxBodyBytes      = 16 << 10
)

// Settings: who may add comments, besides the owner.
const (
	SettingAll  = "all"  // anyone with a link
	SettingEdit = "edit" // the edit link only
	SettingOff  = "off"  // no one
)

// Roles, as the HTTP layer names them (stamped on each message).
const (
	RoleOwner  = "owner"
	RoleEditor = "editor"
	RoleViewer = "viewer"
	RoleOpen   = "open" // a project nobody has claimed yet
)

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)
	elementPattern = regexp.MustCompile(`^[a-z0-9_~-]{1,64}$`)
)

// ValidID reports whether id can be a thread or message id.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// Doc is the stored comments document of one project.
type Doc struct {
	Version int      `json:"version"`
	Setting string   `json:"setting"`
	Threads []Thread `json:"threads"`
}

type Thread struct {
	ID       string    `json:"id"`
	Anchor   Anchor    `json:"anchor"`
	Resolved *Resolved `json:"resolved"`
	Messages []Message `json:"messages"`
}

type Anchor struct {
	LevelID string  `json:"levelId"`
	Variant string  `json:"variant"`
	At      Point   `json:"at"`
	Target  *Target `json:"target,omitempty"`
	Label   string  `json:"label"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Target is what a pin is attached to. Kinds: item {id, rel}, opening {id}, point {id},
// wall {id, t, off} and room {id}.
type Target struct {
	Kind string   `json:"kind"`
	ID   string   `json:"id"`
	T    *float64 `json:"t,omitempty"`
	Off  *float64 `json:"off,omitempty"`
	Rel  *Point   `json:"rel,omitempty"`
}

type Resolved struct {
	Name string    `json:"name"`
	At   time.Time `json:"at"`
}

type Message struct {
	ID   string    `json:"id"`
	Name string    `json:"name"`
	Role string    `json:"role"`
	Text string    `json:"text"`
	At   time.Time `json:"at"`
	// AuthHash is sha256(projectId|author key): who may delete the message. Never served.
	AuthHash string `json:"authHash"`
}

// Decode reads a stored document; empty input is a project with no comments yet.
func Decode(b []byte) (Doc, error) {
	d := Doc{Setting: SettingAll, Threads: []Thread{}}
	if len(b) == 0 {
		return d, nil
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return Doc{}, fmt.Errorf("comments document: %w", err)
	}
	if d.Setting == "" {
		d.Setting = SettingAll
	}
	if d.Threads == nil {
		d.Threads = []Thread{}
	}
	return d, nil
}

// Encode returns the stored form, or comments_full once it is over MaxDocBytes.
func Encode(d Doc) ([]byte, error) {
	b, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxDocBytes {
		return nil, errFull
	}
	return b, nil
}

func (d *Doc) messageCount() int {
	n := 0
	for _, t := range d.Threads {
		n += len(t.Messages)
	}
	return n
}

func (d *Doc) thread(id string) (int, *Thread) {
	for i := range d.Threads {
		if d.Threads[i].ID == id {
			return i, &d.Threads[i]
		}
	}
	return -1, nil
}

// ---------------------------------------------------------------------- errors

// Error is an operation refused, with the HTTP status and a code the web maps to copy.
type Error struct {
	Status int
	Code   string
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &Error{http.StatusBadRequest, "invalid", fmt.Sprintf(format, a...)}
}

var (
	errOff       = &Error{http.StatusForbidden, "comments_off", "The owner has closed comments on this plan."}
	errEditOnly  = &Error{http.StatusForbidden, "comments_edit_only", "Only people with the edit link can comment on this plan."}
	errNotYours  = &Error{http.StatusForbidden, "not_yours", "You can only delete your own comments."}
	errOwnerOnly = &Error{http.StatusForbidden, "owner_only", "Only the plan's owner can do this."}
	errGone      = &Error{http.StatusNotFound, "gone", "That comment was deleted."}
	errTaken     = &Error{http.StatusConflict, "id_taken", "That id is already used by another comment."}
	errThread    = &Error{http.StatusConflict, "thread_full", fmt.Sprintf("This thread has %d replies. Start a new comment.", MaxThreadMessages)}
	errFull      = &Error{http.StatusConflict, "comments_full", fmt.Sprintf("This plan has %d comments, the most it can hold. The owner can delete resolved ones.", MaxMessages)}
)

// AsError returns err as an *Error when it is one.
func AsError(err error) (*Error, bool) {
	var e *Error
	ok := errors.As(err, &e)
	return e, ok
}

// ---------------------------------------------------------------------- actors

// Actor is who asks: their role on the project and their author hash ("" for none).
type Actor struct {
	Role     string
	AuthHash string
}

// canAdd says whether the actor may add, reply, resolve and reopen under setting.
func canAdd(a Actor, setting string) error {
	if a.Role == RoleOwner {
		return nil
	}
	switch setting {
	case SettingOff:
		return errOff
	case SettingEdit:
		if a.Role == RoleViewer {
			return errEditOnly
		}
	}
	return nil
}

func (a Actor) owns(m Message) bool { return a.AuthHash != "" && m.AuthHash == a.AuthHash }

// ---------------------------------------------------------------------- operations

// Op is one operation on a comments document. Apply changes d in place and reports
// whether anything changed (an identical retry, or resolving twice, changes nothing).
type Op interface {
	Apply(d *Doc, a Actor, now time.Time) (changed bool, err error)
}

// AddThread is POST /projects/{id}/comments.
type AddThread struct {
	ID        string `json:"id"`
	Anchor    Anchor `json:"anchor"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	MessageID string `json:"messageId"`
}

// AddReply is POST …/comments/{thread}/replies; Thread comes from the path.
type AddReply struct {
	Thread string `json:"-"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Text   string `json:"text"`
}

// Resolve is PATCH …/comments/{thread}: {resolved: true, name} or {resolved: false}.
type Resolve struct {
	Thread   string `json:"-"`
	Resolved *bool  `json:"resolved"`
	Name     string `json:"name"`
}

// DeleteThread is DELETE …/comments/{thread}.
type DeleteThread struct{ Thread string }

// DeleteReply is DELETE …/comments/{thread}/replies/{msg}.
type DeleteReply struct{ Thread, Message string }

// DeleteResolved is DELETE /projects/{id}/comments?resolved=true.
type DeleteResolved struct{}

// SetSetting is PATCH /projects/{id}/comments: {setting}.
type SetSetting struct {
	Setting string `json:"setting"`
}

func ms(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

func (o AddThread) Apply(d *Doc, a Actor, now time.Time) (bool, error) {
	if _, t := d.thread(o.ID); t != nil {
		// A retry of the same post is a success that changes nothing.
		if len(t.Messages) > 0 && t.Messages[0].ID == o.MessageID && t.Messages[0].Text == o.Text &&
			t.Messages[0].Name == o.Name && a.owns(t.Messages[0]) && sameAnchor(t.Anchor, o.Anchor) {
			return false, nil
		}
		return false, errTaken
	}
	if err := canAdd(a, d.Setting); err != nil {
		return false, err
	}
	if d.messageCount() >= MaxMessages {
		return false, errFull
	}
	d.Threads = append(d.Threads, Thread{
		ID:     o.ID,
		Anchor: o.Anchor,
		Messages: []Message{{
			ID: o.MessageID, Name: o.Name, Role: a.Role, Text: o.Text, At: ms(now), AuthHash: a.AuthHash,
		}},
	})
	return true, nil
}

func sameAnchor(x, y Anchor) bool {
	bx, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	return bytes.Equal(bx, by)
}

func (o AddReply) Apply(d *Doc, a Actor, now time.Time) (bool, error) {
	_, t := d.thread(o.Thread)
	if t == nil {
		return false, errGone
	}
	for _, m := range t.Messages {
		if m.ID == o.ID {
			if m.Text == o.Text && m.Name == o.Name && a.owns(m) {
				return false, nil
			}
			return false, errTaken
		}
	}
	if err := canAdd(a, d.Setting); err != nil {
		return false, err
	}
	if len(t.Messages) >= MaxThreadMessages {
		return false, errThread
	}
	if d.messageCount() >= MaxMessages {
		return false, errFull
	}
	t.Messages = append(t.Messages, Message{
		ID: o.ID, Name: o.Name, Role: a.Role, Text: o.Text, At: ms(now), AuthHash: a.AuthHash,
	})
	return true, nil
}

func (o Resolve) Apply(d *Doc, a Actor, now time.Time) (bool, error) {
	_, t := d.thread(o.Thread)
	if t == nil {
		return false, errGone
	}
	if err := canAdd(a, d.Setting); err != nil {
		return false, err
	}
	switch {
	case *o.Resolved && t.Resolved == nil:
		t.Resolved = &Resolved{Name: o.Name, At: ms(now)}
	case !*o.Resolved && t.Resolved != nil:
		t.Resolved = nil
	default:
		return false, nil
	}
	return true, nil
}

func (o DeleteThread) Apply(d *Doc, a Actor, _ time.Time) (bool, error) {
	i, t := d.thread(o.Thread)
	if t == nil {
		return false, errGone
	}
	if a.Role != RoleOwner {
		for _, m := range t.Messages {
			if !a.owns(m) {
				return false, errNotYours
			}
		}
	}
	d.Threads = append(d.Threads[:i], d.Threads[i+1:]...)
	return true, nil
}

func (o DeleteReply) Apply(d *Doc, a Actor, _ time.Time) (bool, error) {
	_, t := d.thread(o.Thread)
	if t == nil {
		return false, errGone
	}
	for i, m := range t.Messages {
		if m.ID != o.Message {
			continue
		}
		if i == 0 {
			return false, invalid("the first message is the comment itself: delete the comment")
		}
		if a.Role != RoleOwner && !a.owns(m) {
			return false, errNotYours
		}
		t.Messages = append(t.Messages[:i], t.Messages[i+1:]...)
		return true, nil
	}
	return false, errGone
}

func (DeleteResolved) Apply(d *Doc, a Actor, _ time.Time) (bool, error) {
	if a.Role != RoleOwner {
		return false, errOwnerOnly
	}
	kept := d.Threads[:0]
	for _, t := range d.Threads {
		if t.Resolved == nil {
			kept = append(kept, t)
		}
	}
	changed := len(kept) != len(d.Threads)
	d.Threads = kept
	return changed, nil
}

func (o SetSetting) Apply(d *Doc, a Actor, _ time.Time) (bool, error) {
	if a.Role != RoleOwner {
		return false, errOwnerOnly
	}
	if d.Setting == o.Setting {
		return false, nil
	}
	d.Setting = o.Setting
	return true, nil
}

// ---------------------------------------------------------------------- decoding

// DecodeBody reads a request body into v strictly: at most MaxBodyBytes (413 beyond),
// no unknown fields and a single JSON value.
func DecodeBody(r io.Reader, v any) error {
	b, err := io.ReadAll(io.LimitReader(r, MaxBodyBytes+1))
	if err != nil {
		return invalid("could not read the request")
	}
	if len(b) > MaxBodyBytes {
		return &Error{http.StatusRequestEntityTooLarge, "too_large", "That comment is too long."}
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return invalid("bad request body: %v", err)
	}
	if dec.More() {
		return invalid("bad request body: trailing data")
	}
	return nil
}

// ---------------------------------------------------------------------- validation

// Validate checks a decoded operation and normalises its text (trimmed, \r\n as \n).
func (o *AddThread) Validate() error {
	if !ValidID(o.ID) || !ValidID(o.MessageID) {
		return invalid("ids must match %s", idPattern)
	}
	var err error
	if o.Name, err = cleanName(o.Name); err != nil {
		return err
	}
	if o.Text, err = cleanText(o.Text); err != nil {
		return err
	}
	return o.Anchor.validate()
}

func (o *AddReply) Validate() error {
	if !ValidID(o.ID) || !ValidID(o.Thread) {
		return invalid("ids must match %s", idPattern)
	}
	var err error
	if o.Name, err = cleanName(o.Name); err != nil {
		return err
	}
	o.Text, err = cleanText(o.Text)
	return err
}

func (o *Resolve) Validate() error {
	if o.Resolved == nil {
		return invalid(`expected {"resolved": true|false, "name": "…"}`)
	}
	if !*o.Resolved {
		o.Name = ""
		return nil
	}
	var err error
	o.Name, err = cleanName(o.Name)
	return err
}

func (o *SetSetting) Validate() error {
	switch o.Setting {
	case SettingAll, SettingEdit, SettingOff:
		return nil
	}
	return invalid(`setting must be "all", "edit" or "off"`)
}

func (a *Anchor) validate() error {
	if !elementPattern.MatchString(a.LevelID) {
		return invalid("anchor.levelId must match %s", elementPattern)
	}
	if a.Variant != "before" && a.Variant != "after" {
		return invalid(`anchor.variant must be "before" or "after"`)
	}
	if !coord(a.At.X, MaxCoord) || !coord(a.At.Y, MaxCoord) {
		return invalid("anchor.at must be within ±%g m", MaxCoord)
	}
	label, err := cleanLine(a.Label, MaxLabel, "anchor.label")
	if err != nil {
		return err
	}
	a.Label = label
	if a.Target == nil {
		return nil
	}
	t := a.Target
	if !elementPattern.MatchString(t.ID) {
		return invalid("anchor.target.id must match %s", elementPattern)
	}
	switch t.Kind {
	case "item":
		if t.Rel == nil || t.T != nil || t.Off != nil {
			return invalid("an item target has {id, rel}")
		}
		if !coord(t.Rel.X, MaxRel) || !coord(t.Rel.Y, MaxRel) {
			return invalid("anchor.target.rel must be within ±%g m", MaxRel)
		}
	case "wall":
		if t.T == nil || t.Off == nil || t.Rel != nil {
			return invalid("a wall target has {id, t, off}")
		}
		if !coord(*t.T, 1) || *t.T < 0 {
			return invalid("anchor.target.t must be in [0, 1]")
		}
		if !coord(*t.Off, MaxOffset) {
			return invalid("anchor.target.off must be within ±%g m", MaxOffset)
		}
	case "opening", "point", "room":
		if t.T != nil || t.Off != nil || t.Rel != nil {
			return invalid("a %s target has only {id}", t.Kind)
		}
	default:
		return invalid("unknown anchor.target.kind %q", t.Kind)
	}
	return nil
}

func coord(v, limit float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && math.Abs(v) <= limit
}

func cleanName(s string) (string, error) { return cleanLine(s, MaxName, "name") }

// cleanLine is a single line of 1–max runes.
func cleanLine(s string, max int, field string) (string, error) {
	s = strings.TrimSpace(s)
	if strings.ContainsAny(s, "\r\n") {
		return "", invalid("%s must be one line", field)
	}
	if err := checkRunes(s, field); err != nil {
		return "", err
	}
	if n := utf8.RuneCountInString(s); n == 0 || n > max {
		return "", invalid("%s must be 1-%d characters", field, max)
	}
	return s, nil
}

// cleanText is a message: 1–MaxText runes after trimming, newlines kept.
func cleanText(s string) (string, error) {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.TrimSpace(s)
	if err := checkRunes(s, "text"); err != nil {
		return "", err
	}
	if n := utf8.RuneCountInString(s); n == 0 || n > MaxText {
		return "", invalid("text must be 1-%d characters", MaxText)
	}
	return s, nil
}

// checkRunes refuses invalid UTF-8, control characters other than \n, and format
// characters (bidi overrides could make a name read as someone else's), except the
// zero-width joiner and tag characters emoji sequences are made of.
func checkRunes(s, field string) error {
	if !utf8.ValidString(s) {
		return invalid("%s is not valid UTF-8", field)
	}
	for _, r := range s {
		switch {
		case r == '\n':
		case r == '‍', r >= 0xe0020 && r <= 0xe007f:
		case unicode.Is(unicode.Cc, r), unicode.Is(unicode.Cf, r):
			return invalid("%s has a control character (U+%04X)", field, r)
		}
	}
	return nil
}

// ---------------------------------------------------------------------- view

// View is what GET and every write return: the document without author hashes, with
// `mine` for the caller's own messages. Rights are worked out by the client from the
// X-Role header and the setting, so a 304 can't carry stale rights.
type View struct {
	Version int          `json:"version"`
	Setting string       `json:"setting"`
	Threads []ViewThread `json:"threads"`
}

type ViewThread struct {
	ID       string        `json:"id"`
	Anchor   Anchor        `json:"anchor"`
	Resolved *Resolved     `json:"resolved"`
	Messages []ViewMessage `json:"messages"`
}

type ViewMessage struct {
	ID   string    `json:"id"`
	Name string    `json:"name"`
	Role string    `json:"role"`
	Text string    `json:"text"`
	At   time.Time `json:"at"`
	Mine bool      `json:"mine"`
}

// ViewFor returns d as the caller with authHash sees it.
func ViewFor(d Doc, authHash string) View {
	a := Actor{AuthHash: authHash}
	v := View{Version: d.Version, Setting: d.Setting, Threads: make([]ViewThread, 0, len(d.Threads))}
	for _, t := range d.Threads {
		vt := ViewThread{ID: t.ID, Anchor: t.Anchor, Resolved: t.Resolved, Messages: make([]ViewMessage, 0, len(t.Messages))}
		for _, m := range t.Messages {
			vt.Messages = append(vt.Messages, ViewMessage{ID: m.ID, Name: m.Name, Role: m.Role, Text: m.Text, At: m.At, Mine: a.owns(m)})
		}
		v.Threads = append(v.Threads, vt)
	}
	return v
}
