package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

// Author keys: 32 base64url characters, one per browser.
var (
	keyMum   = strings.Repeat("m", 32)
	keyDad   = strings.Repeat("d", 32)
	keyJun   = strings.Repeat("j", 32)
	keyOwner = strings.Repeat("o", 32)
)

func viewer(author string) map[string]string {
	return map[string]string{"Authorization": "", "X-Comment-Author": author, "Content-Type": "application/json"}
}

func asOwner() map[string]string {
	return map[string]string{"X-Comment-Author": keyOwner, "Content-Type": "application/json"}
}

func editor(token, author string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token, "X-Comment-Author": author, "Content-Type": "application/json"}
}

func threadBody(id, msg, text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"id": id, "messageId": msg, "name": "Mum", "text": text,
		"anchor": map[string]any{
			"levelId": "lvl_ground", "variant": "after", "at": map[string]any{"x": 3.2, "y": 4},
			"target": map[string]any{"kind": "item", "id": "it_fridge", "rel": map[string]any{"x": 0, "y": 0}},
			"label":  "Fridge",
		},
	})
	return b
}

func replyBody(id, name, text string) []byte {
	b, _ := json.Marshal(map[string]any{"id": id, "name": name, "text": text})
	return b
}

func threads(body map[string]any) []map[string]any {
	ts, _ := body["threads"].([]any)
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.(map[string]any))
	}
	return out
}

func messages(t map[string]any) []map[string]any {
	ms, _ := t["messages"].([]any)
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.(map[string]any))
	}
	return out
}

func newProject(t *testing.T, ts *httptest.Server, id string) {
	t.Helper()
	if res, body := do(t, "POST", ts.URL+"/projects", doc(id, "Flat", 0), nil); res.StatusCode != http.StatusCreated {
		t.Fatalf("create %s: %d %v", id, res.StatusCode, body)
	}
}

func shareEdit(t *testing.T, ts *httptest.Server, id string) string {
	t.Helper()
	_, share := do(t, "PUT", ts.URL+"/projects/"+id+"/share", []byte(`{"edit":true}`), nil)
	token, _ := share["edit"].(string)
	if token == "" {
		t.Fatalf("share: %v", share)
	}
	return token
}

func TestCommentsGetAndPost(t *testing.T) {
	ts := newTestServer(t)
	url := ts.URL + "/projects/prj_c/comments"

	if res, _ := do(t, "GET", url, nil, viewer(keyMum)); res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing project: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", ts.URL+"/projects/BAD!/comments", nil, nil); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad id: %d", res.StatusCode)
	}
	newProject(t, ts, "prj_c")
	res, body := do(t, "GET", url, nil, viewer(keyMum))
	if res.StatusCode != 200 || res.Header.Get("ETag") != `"0"` || body["version"] != float64(0) ||
		body["setting"] != "all" || len(threads(body)) != 0 || body["threads"] == nil {
		t.Fatalf("empty: %d %s %v", res.StatusCode, res.Header.Get("ETag"), body)
	}
	if res.Header.Get("X-Role") != "viewer" || res.Header.Get("Cache-Control") != "private, no-store" ||
		res.Header.Get("Vary") != "Authorization, X-Comment-Author" {
		t.Fatalf("headers: %v", res.Header)
	}

	// A view link posts a thread.
	res, body = do(t, "POST", url, threadBody("t_1", "m_1", "Open kitchen, the wok smell?"), viewer(keyMum))
	if res.StatusCode != http.StatusCreated || ver(res) != "1" {
		t.Fatalf("post: %d %v", res.StatusCode, body)
	}
	m := messages(threads(body)[0])[0]
	if m["role"] != "viewer" || m["mine"] != true || m["at"] == "" || m["name"] != "Mum" {
		t.Fatalf("message: %v", m)
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "authHash") {
		t.Fatalf("response leaks authHash: %s", raw)
	}
	_, body = do(t, "GET", url, nil, viewer(keyDad))
	if messages(threads(body)[0])[0]["mine"] != false {
		t.Fatal("another author's message is mine")
	}
	_, body = do(t, "GET", url, nil, map[string]string{"Authorization": ""})
	if messages(threads(body)[0])[0]["mine"] != false {
		t.Fatal("no author key, still mine")
	}

	// An identical retry gives 200 and one thread; the same id with other content 409.
	res, body = do(t, "POST", url, threadBody("t_1", "m_1", "Open kitchen, the wok smell?"), viewer(keyMum))
	if res.StatusCode != 200 || len(threads(body)) != 1 || ver(res) != "1" {
		t.Fatalf("retry: %d %v", res.StatusCode, body)
	}
	if res, body := do(t, "POST", url, threadBody("t_1", "m_1", "Different"), viewer(keyMum)); res.StatusCode != http.StatusConflict || body["code"] != "id_taken" {
		t.Fatalf("same id, other content: %d %v", res.StatusCode, body)
	}

	// Writes need an author key and a valid body.
	hdr := viewer("")
	delete(hdr, "X-Comment-Author")
	if res, _ := do(t, "POST", url, threadBody("t_2", "m_2", "x"), hdr); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("no author key: %d", res.StatusCode)
	}
	for name, b := range map[string][]byte{
		"empty text":   threadBody("t_2", "m_2", "   "),
		"1001 runes":   threadBody("t_2", "m_2", strings.Repeat("a", 1001)),
		"control char": threadBody("t_2", "m_2", "a\u0007"),
		"bad variant":  []byte(strings.Replace(string(threadBody("t_2", "m_2", "x")), `"after"`, `"x"`, 1)),
		"far away":     []byte(strings.Replace(string(threadBody("t_2", "m_2", "x")), `"x":3.2`, `"x":1000.5`, 1)),
		"unknown kind": []byte(strings.Replace(string(threadBody("t_2", "m_2", "x")), `"item"`, `"stair"`, 1)),
		"long name":    []byte(strings.Replace(string(threadBody("t_2", "m_2", "x")), `"Mum"`, `"`+strings.Repeat("n", 41)+`"`, 1)),
		"unknown key":  []byte(strings.Replace(string(threadBody("t_2", "m_2", "x")), `{"anchor"`, `{"admin":true,"anchor"`, 1)),
		"not json":     []byte(`{`),
	} {
		if res, body := do(t, "POST", url, b, viewer(keyMum)); res.StatusCode != http.StatusBadRequest || body["code"] != "invalid" {
			t.Errorf("%s: %d %v", name, res.StatusCode, body)
		}
	}
	if res, _ := do(t, "POST", url, threadBody("t_2", "m_2", strings.Repeat("厨", 1000)), viewer(keyMum)); res.StatusCode != http.StatusCreated {
		t.Fatalf("1000 CJK runes: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", url, threadBody("t_3", "m_3", strings.Repeat("a", 17<<10)), viewer(keyMum)); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("17 KB body: %d", res.StatusCode)
	}
}

func TestCommentRepliesResolveAndDelete(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_r")
	token := shareEdit(t, ts, "prj_r")
	url := ts.URL + "/projects/prj_r/comments"
	do(t, "POST", url, threadBody("t_1", "m_1", "Wardrobe?"), viewer(keyMum))

	if res, body := do(t, "POST", url+"/t_1/replies", replyBody("m_2", "Jun Hao", "Glass door"), editor(token, keyJun)); res.StatusCode != http.StatusCreated || len(messages(threads(body)[0])) != 2 {
		t.Fatalf("editor reply: %d %v", res.StatusCode, body)
	}
	res, body := do(t, "POST", url+"/t_1/replies", replyBody("m_3", "Wei Ling", "OK"), asOwner())
	ms := messages(threads(body)[0])
	if res.StatusCode != http.StatusCreated || len(ms) != 3 || ms[1]["role"] != "editor" || ms[2]["role"] != "owner" || ms[2]["mine"] != true {
		t.Fatalf("owner reply: %d %v", res.StatusCode, ms)
	}
	if res, body := do(t, "POST", url+"/t_1/replies", replyBody("m_3", "Wei Ling", "OK"), asOwner()); res.StatusCode != 200 || len(messages(threads(body)[0])) != 3 {
		t.Fatalf("reply retry: %d", res.StatusCode)
	}
	if res, body := do(t, "POST", url+"/t_nope/replies", replyBody("m_9", "Mum", "x"), viewer(keyMum)); res.StatusCode != http.StatusNotFound || body["code"] != "gone" {
		t.Fatalf("reply to unknown thread: %d %v", res.StatusCode, body)
	}

	// A viewer resolves; resolving twice changes nothing; reopening clears it.
	res, body = do(t, "PATCH", url+"/t_1", []byte(`{"resolved":true,"name":"Mum"}`), viewer(keyDad))
	resolved, _ := threads(body)[0]["resolved"].(map[string]any)
	if res.StatusCode != 200 || resolved["name"] != "Mum" || resolved["at"] == "" {
		t.Fatalf("resolve: %d %v", res.StatusCode, body)
	}
	v := res.Header.Get("ETag")
	if res, _ := do(t, "PATCH", url+"/t_1", []byte(`{"resolved":true,"name":"Dad"}`), viewer(keyDad)); res.Header.Get("ETag") != v {
		t.Fatal("resolving twice bumped the version")
	}
	if _, body := do(t, "PATCH", url+"/t_1", []byte(`{"resolved":false}`), viewer(keyDad)); threads(body)[0]["resolved"] != nil {
		t.Fatalf("reopen: %v", body)
	}

	// Deleting replies: another viewer and a non-author editor can't; the author and the
	// owner can.
	if res, body := do(t, "DELETE", url+"/t_1/replies/m_2", nil, viewer(keyDad)); res.StatusCode != http.StatusForbidden || body["code"] != "not_yours" {
		t.Fatalf("viewer deletes someone's reply: %d %v", res.StatusCode, body)
	}
	if res, _ := do(t, "DELETE", url+"/t_1/replies/m_3", nil, editor(token, keyJun)); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor deletes the owner's reply: %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", url+"/t_1/replies/m_2", nil, editor(token, keyJun)); res.StatusCode != 200 {
		t.Fatalf("author deletes: %d", res.StatusCode)
	}
	// The thread has the owner's reply: its author can't delete it, the owner can.
	if res, _ := do(t, "DELETE", url+"/t_1", nil, viewer(keyMum)); res.StatusCode != http.StatusForbidden {
		t.Fatalf("author deletes a thread with others' replies: %d", res.StatusCode)
	}
	if res, body := do(t, "DELETE", url+"/t_1", nil, asOwner()); res.StatusCode != 200 || len(threads(body)) != 0 {
		t.Fatalf("owner deletes: %d %v", res.StatusCode, body)
	}
	if res, _ := do(t, "DELETE", url+"/t_1", nil, asOwner()); res.StatusCode != http.StatusNotFound {
		t.Fatalf("delete twice: %d", res.StatusCode)
	}

	// Deleting resolved comments: owner only, and only the resolved ones.
	do(t, "POST", url, threadBody("t_a", "m_a", "a"), viewer(keyMum))
	do(t, "POST", url, threadBody("t_b", "m_b", "b"), viewer(keyMum))
	do(t, "PATCH", url+"/t_a", []byte(`{"resolved":true,"name":"Mum"}`), viewer(keyMum))
	for _, h := range []map[string]string{viewer(keyMum), editor(token, keyJun)} {
		if res, body := do(t, "DELETE", url+"?resolved=true", nil, h); res.StatusCode != http.StatusForbidden || body["code"] != "owner_only" {
			t.Fatalf("non-owner deletes resolved: %d %v", res.StatusCode, body)
		}
	}
	if res, _ := do(t, "DELETE", url, nil, asOwner()); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("delete all without ?resolved=true: %d", res.StatusCode)
	}
	res, body = do(t, "DELETE", url+"?resolved=true", nil, asOwner())
	if ts := threads(body); res.StatusCode != 200 || len(ts) != 1 || ts[0]["id"] != "t_b" {
		t.Fatalf("delete resolved: %d %v", res.StatusCode, body)
	}
}

func TestCommentLimitsOverHTTP(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_l")
	url := ts.URL + "/projects/prj_l/comments"
	do(t, "POST", url, threadBody("t_0", "m_0", "first"), viewer(keyMum))
	for i := 1; i < 50; i++ {
		if res, _ := do(t, "POST", url+"/t_0/replies", replyBody("m_r"+itoa(i), "Mum", "x"), viewer(keyMum)); res.StatusCode != http.StatusCreated {
			t.Fatalf("reply %d: %d", i, res.StatusCode)
		}
	}
	if res, body := do(t, "POST", url+"/t_0/replies", replyBody("m_full", "Mum", "x"), viewer(keyMum)); res.StatusCode != http.StatusConflict || body["code"] != "thread_full" {
		t.Fatalf("51st in a thread: %d %v", res.StatusCode, body)
	}
	for i := 1; i <= 250; i++ {
		if res, _ := do(t, "POST", url, threadBody("t_"+itoa(i), "m_"+itoa(i), "x"), viewer(keyMum)); res.StatusCode != http.StatusCreated {
			t.Fatalf("thread %d: %d", i, res.StatusCode)
		}
	}
	if res, body := do(t, "POST", url, threadBody("t_last", "m_last", "x"), viewer(keyMum)); res.StatusCode != http.StatusConflict || body["code"] != "comments_full" {
		t.Fatalf("301st in a project: %d %v", res.StatusCode, body)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestCommentSetting(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_s")
	token := shareEdit(t, ts, "prj_s")
	url := ts.URL + "/projects/prj_s/comments"

	if res, body := do(t, "PATCH", url, []byte(`{"setting":"edit"}`), editor(token, keyJun)); res.StatusCode != http.StatusForbidden || body["code"] != "owner_only" {
		t.Fatalf("editor changes the setting: %d %v", res.StatusCode, body)
	}
	if res, _ := do(t, "PATCH", url, []byte(`{"setting":"maybe"}`), asOwner()); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad setting: %d", res.StatusCode)
	}
	res, body := do(t, "PATCH", url, []byte(`{"setting":"edit"}`), asOwner())
	if res.StatusCode != 200 || body["setting"] != "edit" || ver(res) != "1" {
		t.Fatalf("set edit: %d %v", res.StatusCode, body)
	}
	if res, body := do(t, "POST", url, threadBody("t_v", "m_v", "x"), viewer(keyMum)); res.StatusCode != http.StatusForbidden || body["code"] != "comments_edit_only" {
		t.Fatalf("viewer under edit: %d %v", res.StatusCode, body)
	}
	if res, _ := do(t, "POST", url, threadBody("t_e", "m_e", "x"), editor(token, keyJun)); res.StatusCode != http.StatusCreated {
		t.Fatalf("editor under edit: %d", res.StatusCode)
	}
	do(t, "PATCH", url, []byte(`{"setting":"off"}`), asOwner())
	if res, body := do(t, "POST", url, threadBody("t_e2", "m_e2", "x"), editor(token, keyJun)); res.StatusCode != http.StatusForbidden || body["code"] != "comments_off" {
		t.Fatalf("editor under off: %d %v", res.StatusCode, body)
	}
	if res, _ := do(t, "POST", url, threadBody("t_o", "m_o", "x"), asOwner()); res.StatusCode != http.StatusCreated {
		t.Fatalf("owner under off: %d", res.StatusCode)
	}
	// Everyone can still read, and the GET says the setting.
	for _, h := range []map[string]string{viewer(keyMum), editor(token, keyJun), asOwner()} {
		res, body := do(t, "GET", url, nil, h)
		if res.StatusCode != 200 || body["setting"] != "off" || len(threads(body)) != 2 {
			t.Fatalf("read under off: %d %v", res.StatusCode, body)
		}
	}
}

func TestCommentsNotModified(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_n")
	url := ts.URL + "/projects/prj_n/comments"
	posted, _ := do(t, "POST", url, threadBody("t_1", "m_1", "x"), viewer(keyMum))
	tag := posted.Header.Get("ETag")
	if !regexp.MustCompile(`^"[0-9a-f]{12}\.1"$`).MatchString(tag) {
		t.Fatalf("ETag %q is not \"<epoch>.<version>\"", tag)
	}

	for _, inm := range []string{tag, "W/" + tag, `"0", ` + tag, `*`} {
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("If-None-Match", inm)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusNotModified || len(b) != 0 || res.Header.Get("ETag") != tag || res.Header.Get("X-Role") != "viewer" {
			t.Fatalf("If-None-Match %s: %d %q %v", inm, res.StatusCode, b, res.Header)
		}
	}
	if res, _ := do(t, "GET", url, nil, map[string]string{"If-None-Match": `"0"`}); res.StatusCode != 200 {
		t.Fatalf("stale If-None-Match: %d", res.StatusCode)
	}
	// The owner's setting is in the document, so a change shows to pollers.
	do(t, "PATCH", url, []byte(`{"setting":"off"}`), asOwner())
	if res, body := do(t, "GET", url, nil, map[string]string{"If-None-Match": tag}); res.StatusCode != 200 || body["setting"] != "off" {
		t.Fatalf("after a setting change: %d %v", res.StatusCode, body)
	}
}

// A project deleted and made again restarts its comments at version 0: their epoch keeps
// the old tags from matching the new comments.
func TestCommentEpochsSurviveRecreate(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_e")
	url := ts.URL + "/projects/prj_e/comments"
	first, body := do(t, "POST", url, threadBody("t_1", "m_1", "old"), viewer(keyMum))
	oldTag, oldEpoch := first.Header.Get("ETag"), body["epoch"]
	if oldEpoch == nil || oldEpoch == "" {
		t.Fatalf("no epoch in the view: %v", body)
	}
	do(t, "DELETE", ts.URL+"/projects/prj_e", nil, nil)
	newProject(t, ts, "prj_e")
	again, body := do(t, "POST", url, threadBody("t_2", "m_2", "new"), viewer(keyMum))
	if ver(again) != "1" || again.Header.Get("ETag") == oldTag || body["epoch"] == oldEpoch {
		t.Fatalf("recreated: %s (was %s), epoch %v", again.Header.Get("ETag"), oldTag, body["epoch"])
	}
	if res, _ := do(t, "GET", url, nil, map[string]string{"If-None-Match": oldTag}); res.StatusCode != 200 {
		t.Fatalf("the old tag matched the new comments: %d", res.StatusCode)
	}
}

func TestCommentWritesNeedJSON(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_j")
	h := viewer(keyMum)
	h["Content-Type"] = "application/x-www-form-urlencoded"
	if res, _ := do(t, "POST", ts.URL+"/projects/prj_j/comments", threadBody("t_1", "m_1", "x"), h); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("form post: %d", res.StatusCode)
	}
	h["Content-Type"] = "application/json; charset=utf-8"
	if res, _ := do(t, "POST", ts.URL+"/projects/prj_j/comments", threadBody("t_1", "m_1", "x"), h); res.StatusCode != http.StatusCreated {
		t.Fatalf("JSON with a charset: %d", res.StatusCode)
	}
}

// ver is the version in a comments ETag ("<epoch>.<version>", or "0").
func ver(res *http.Response) string {
	tag := strings.Trim(res.Header.Get("ETag"), `"`)
	if i := strings.LastIndexByte(tag, '.'); i >= 0 {
		return tag[i+1:]
	}
	return tag
}

func TestCommentsAndTheProjectLifecycle(t *testing.T) {
	ts := newTestServer(t)
	newProject(t, ts, "prj_d")
	url := ts.URL + "/projects/prj_d/comments"
	do(t, "POST", url, threadBody("t_1", "m_1", "x"), viewer(keyMum))

	// A comment write leaves the project's version; a project save leaves the comments'.
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_d", nil, nil); res.Header.Get("ETag") != `"1"` {
		t.Fatalf("project version after a comment: %s", res.Header.Get("ETag"))
	}
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_d", doc("prj_d", "Saved", 1), map[string]string{"If-Match": `"1"`}); res.StatusCode != 200 {
		t.Fatalf("save: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", url, nil, nil); ver(res) != "1" {
		t.Fatalf("comments version after a save: %s", res.Header.Get("ETag"))
	}

	// Deleting the project deletes them; every route then 404s; a new project with the id
	// starts empty.
	if res, _ := do(t, "DELETE", ts.URL+"/projects/prj_d", nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", url, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("comments of a deleted project: %d", res.StatusCode)
	}
	if res, _ := do(t, "POST", url, threadBody("t_2", "m_2", "x"), viewer(keyMum)); res.StatusCode != http.StatusNotFound {
		t.Fatalf("post to a deleted project: %d", res.StatusCode)
	}
	if res, _ := do(t, "PATCH", url+"/t_1", []byte(`{"resolved":true,"name":"A"}`), viewer(keyMum)); res.StatusCode != http.StatusNotFound {
		t.Fatalf("resolve on a deleted project: %d", res.StatusCode)
	}
	newProject(t, ts, "prj_d")
	if res, body := do(t, "GET", url, nil, nil); res.StatusCode != 200 || len(threads(body)) != 0 || body["version"] != float64(0) {
		t.Fatalf("recreated: %d %v", res.StatusCode, body)
	}
}

// Leftover comments under a new project's id (a delete half done) are cleared on create.
func TestCreateClearsLeftoverComments(t *testing.T) {
	st := &clearCounter{Memory: store.NewMemory()}
	ts := httptest.NewServer(New(st, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(ts.Close)
	newProject(t, ts, "prj_y")
	if st.cleared != "prj_y" {
		t.Fatalf("create cleared %q", st.cleared)
	}
	// A create that fails (the id is taken) leaves the existing project's comments alone.
	st.cleared = ""
	if res, _ := do(t, "POST", ts.URL+"/projects", doc("prj_y", "Again", 0), nil); res.StatusCode != http.StatusConflict || st.cleared != "" {
		t.Fatalf("failed create: %d, cleared %q", res.StatusCode, st.cleared)
	}
}

type clearCounter struct {
	*store.Memory
	cleared string
}

func (c *clearCounter) DeleteComments(ctx context.Context, id string) error {
	c.cleared = id
	return c.Memory.DeleteComments(ctx, id)
}

func TestConcurrentCommentsAllLand(t *testing.T) {
	st := store.NewMemory()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Two servers on one store, as two containers would be during a rollout: the lock
	// serialises each, and the retry covers the overlap between them.
	a, b := New(st, log), New(st, log)
	tsA, tsB := httptest.NewServer(a), httptest.NewServer(b)
	t.Cleanup(tsA.Close)
	t.Cleanup(tsB.Close)
	newProject(t, tsA, "prj_race")

	const n = 20
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			base := tsA.URL
			if i%2 == 1 {
				base = tsB.URL
			}
			res, _ := do(t, "POST", base+"/projects/prj_race/comments", threadBody("t_"+itoa(i), "m_"+itoa(i), "x"), viewer(keyMum))
			codes[i] = res.StatusCode
		}()
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusCreated {
			t.Fatalf("post %d: %d", i, c)
		}
	}
	res, body := do(t, "GET", tsA.URL+"/projects/prj_race/comments", nil, nil)
	if ver(res) != "20" || len(threads(body)) != n {
		t.Fatalf("after %d posts: %s, %d threads", n, res.Header.Get("ETag"), len(threads(body)))
	}
	if a.commentLocks.size() != 0 || b.commentLocks.size() != 0 {
		t.Fatal("project locks outlived their writers")
	}
}

// alwaysChanged is a store whose comments always changed since they were read.
type alwaysChanged struct{ *store.Memory }

func (alwaysChanged) PutComments(context.Context, string, store.CommentsRec, []byte) error {
	return store.ErrCommentsChanged
}

func TestCommentsBusyAfterRetries(t *testing.T) {
	st := alwaysChanged{store.NewMemory()}
	ts := httptest.NewServer(New(st, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(ts.Close)
	newProject(t, ts, "prj_busy")
	res, body := do(t, "POST", ts.URL+"/projects/prj_busy/comments", threadBody("t_1", "m_1", "x"), viewer(keyMum))
	if res.StatusCode != http.StatusServiceUnavailable || body["code"] != "busy" || res.Header.Get("Retry-After") != "1" {
		t.Fatalf("busy: %d %v %v", res.StatusCode, body, res.Header)
	}
}

func TestOpenProjectComments(t *testing.T) {
	st := store.NewMemory()
	ts := httptest.NewServer(New(st, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(ts.Close)
	_ = st.Create(t.Context(), store.Record{ID: "prj_open", Name: "Old", Doc: doc("prj_open", "Old", 1)})
	url := ts.URL + "/projects/prj_open/comments"
	res, body := do(t, "POST", url, threadBody("t_1", "m_1", "x"), viewer(keyMum))
	if res.StatusCode != http.StatusCreated || messages(threads(body)[0])[0]["role"] != "open" || res.Header.Get("X-Role") != "open" {
		t.Fatalf("open post: %d %v", res.StatusCode, body)
	}
	// Nobody can moderate an unclaimed project.
	if res, _ := do(t, "PATCH", url, []byte(`{"setting":"off"}`), viewer(keyMum)); res.StatusCode != http.StatusForbidden {
		t.Fatalf("open project setting: %d", res.StatusCode)
	}
}

// A request that goes while it waits for a project's lock stops waiting, and leaves no
// entry behind.
func TestProjectLockGivesUpWithItsRequest(t *testing.T) {
	var p projectLocks
	unlock, err := p.lock(context.Background(), "prj_a")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := p.lock(ctx, "prj_a")
		done <- err
	}()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting lock: %v", err)
	}
	unlock()
	if p.size() != 0 {
		t.Fatalf("%d entries left", p.size())
	}
	again, err := p.lock(context.Background(), "prj_a")
	if err != nil {
		t.Fatal(err)
	}
	again()
}
