package httpapi

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/zeecm/dream-home-designer/apps/api/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(New(store.NewMemory(), slog.New(slog.NewTextHandler(io.Discard, nil)), WithListing()))
	t.Cleanup(ts.Close)
	return ts
}

func doc(id, name string, version int) []byte {
	b, _ := json.Marshal(map[string]any{
		"schemaVersion": 1, "id": id, "version": version, "name": name, "units": "m",
		"underlay": nil, "levels": []any{map[string]any{"id": "lvl_ground", "walls": map[string]any{}}},
	})
	return b
}

// ownerKeys holds the owner key each create returned, by project id, so later requests
// in a test act as the owner unless they set their own Authorization ("" for none).
var (
	ownerKeysMu sync.Mutex
	ownerKeys   = map[string]string{}
)

var projectInURL = regexp.MustCompile(`/projects/([a-z0-9_-]+)`)

func do(t *testing.T, method, url string, body []byte, hdr map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if m := projectInURL.FindStringSubmatch(url); m != nil {
		ownerKeysMu.Lock()
		if k := ownerKeys[m[1]]; k != "" {
			req.Header.Set("Authorization", "Bearer "+k)
		}
		ownerKeysMu.Unlock()
	}
	for k, v := range hdr {
		if k == "Authorization" && v == "" {
			req.Header.Del(k)
			continue
		}
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if k := res.Header.Get("X-Owner-Token"); k != "" && method == "POST" {
		var env struct{ ID string }
		_ = json.Unmarshal(body, &env)
		ownerKeysMu.Lock()
		ownerKeys[env.ID] = k
		ownerKeysMu.Unlock()
	}
	defer res.Body.Close()
	var out map[string]any
	b, _ := io.ReadAll(res.Body)
	_ = json.Unmarshal(b, &out)
	return res, out
}

func TestRoundTrip(t *testing.T) {
	ts := newTestServer(t)

	res, body := do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %v", res.StatusCode, body)
	}
	if body["version"] != float64(1) {
		t.Fatalf("created doc should carry version 1, got %v", body["version"])
	}

	res, body = do(t, "GET", ts.URL+"/projects/prj_a", nil, nil)
	if res.StatusCode != 200 || res.Header.Get("ETag") != `"1"` || body["name"] != "Flat" {
		t.Fatalf("get: %d etag=%s %v", res.StatusCode, res.Header.Get("ETag"), body)
	}

	res, body = do(t, "PUT", ts.URL+"/projects/prj_a", doc("prj_a", "Renamed", 1), map[string]string{"If-Match": `"1"`})
	if res.StatusCode != 200 || body["version"] != float64(2) {
		t.Fatalf("put: %d %v", res.StatusCode, body)
	}

	_, body = do(t, "GET", ts.URL+"/projects/prj_a", nil, nil)
	if body["name"] != "Renamed" || body["version"] != float64(2) {
		t.Fatalf("stored doc not updated: %v", body)
	}

	res, err := http.Get(ts.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var list []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&list); err != nil || len(list) != 1 || list[0]["version"] != float64(2) {
		t.Fatalf("list: %v %v", err, list)
	}
}

func TestStaleVersionConflicts(t *testing.T) {
	ts := newTestServer(t)
	do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)
	do(t, "PUT", ts.URL+"/projects/prj_a", doc("prj_a", "v2", 1), map[string]string{"If-Match": `"1"`})

	res, body := do(t, "PUT", ts.URL+"/projects/prj_a", doc("prj_a", "stale", 1), map[string]string{"If-Match": `"1"`})
	if res.StatusCode != http.StatusConflict || body["version"] != float64(2) {
		t.Fatalf("want 409 with current version 2, got %d %v", res.StatusCode, body)
	}
}

func TestConcurrentWritersOnlyOneWins(t *testing.T) {
	ts := newTestServer(t)
	do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)

	const n = 20
	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, _ := do(t, "PUT", ts.URL+"/projects/prj_a", doc("prj_a", "w", 1), map[string]string{"If-Match": `"1"`})
			codes[i] = res.StatusCode
		}()
	}
	wg.Wait()
	ok := 0
	for _, c := range codes {
		if c == 200 {
			ok++
		} else if c != http.StatusConflict {
			t.Fatalf("unexpected status %d", c)
		}
	}
	if ok != 1 {
		t.Fatalf("want exactly one successful write, got %d", ok)
	}
}

func TestPutValidation(t *testing.T) {
	ts := newTestServer(t)
	do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)

	cases := []struct {
		name string
		body []byte
		hdr  map[string]string
		want int
	}{
		{"missing If-Match", doc("prj_a", "x", 1), nil, http.StatusPreconditionRequired},
		{"garbage If-Match", doc("prj_a", "x", 1), map[string]string{"If-Match": "abc"}, http.StatusPreconditionRequired},
		{"id mismatch", doc("prj_b", "x", 1), map[string]string{"If-Match": `"1"`}, http.StatusBadRequest},
		{"not json", []byte("nope"), map[string]string{"If-Match": `"1"`}, http.StatusBadRequest},
		{"empty name", doc("prj_a", "", 1), map[string]string{"If-Match": `"1"`}, http.StatusBadRequest},
		{"weak etag accepted", doc("prj_a", "x", 1), map[string]string{"If-Match": `W/"1"`}, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, body := do(t, "PUT", ts.URL+"/projects/prj_a", c.body, c.hdr)
			if res.StatusCode != c.want {
				t.Fatalf("want %d, got %d %v", c.want, res.StatusCode, body)
			}
		})
	}
}

func TestNotFoundAndDuplicate(t *testing.T) {
	ts := newTestServer(t)
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_missing", nil, nil); res.StatusCode != 404 {
		t.Fatalf("want 404, got %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", ts.URL+"/projects/..%2Fetc", nil, nil); res.StatusCode != 400 {
		t.Fatalf("want 400 for unsafe id, got %d", res.StatusCode)
	}
	do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)
	if res, _ := do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil); res.StatusCode != 409 {
		t.Fatalf("want 409 on duplicate create, got %d", res.StatusCode)
	}
	if res, _ := do(t, "DELETE", ts.URL+"/projects/prj_a", nil, nil); res.StatusCode != 204 {
		t.Fatalf("want 204 on delete, got %d", res.StatusCode)
	}
}

func TestWithoutListingHidesTheProjectList(t *testing.T) {
	ts := httptest.NewServer(New(store.NewMemory(), slog.New(slog.NewTextHandler(io.Discard, nil)), WithoutListing()))
	t.Cleanup(ts.Close)
	res, err := http.Get(ts.URL + "/projects")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed && res.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /projects = %d, want 404 or 405", res.StatusCode)
	}
}

func TestDeleteRejectsUnsafeIDs(t *testing.T) {
	ts := newTestServer(t)
	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/projects/..%2F..%2Fassets%2Fx", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("DELETE with a traversal id = %d, want 400", res.StatusCode)
	}
}

// A 1×1 PNG.
var tinyPNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7V\xbd\xfa\x00\x00\x00\x00IEND\xaeB`\x82")

func TestPlanImage(t *testing.T) {
	ts := newTestServer(t)
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_a/image", tinyPNG, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("image for a missing project: %d", res.StatusCode)
	}
	do(t, "POST", ts.URL+"/projects", doc("prj_a", "Flat", 0), nil)

	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_a/image", []byte("<svg onload=alert(1)>"), nil); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("non-image upload: %d", res.StatusCode)
	}
	res, body := do(t, "PUT", ts.URL+"/projects/prj_a/image", tinyPNG, map[string]string{"Content-Type": "image/png"})
	hash, _ := body["hash"].(string)
	if res.StatusCode != http.StatusOK || len(hash) != 64 {
		t.Fatalf("upload: %d %v", res.StatusCode, body)
	}

	get, err := http.Get(ts.URL + "/projects/prj_a/image/" + hash)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(get.Body)
	get.Body.Close()
	if get.StatusCode != http.StatusOK || !bytes.Equal(got, tinyPNG) ||
		get.Header.Get("Content-Type") != "image/png" ||
		get.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("get: %d %q %v", get.StatusCode, get.Header.Get("Content-Type"), get.Header)
	}

	stale := "0000000000000000000000000000000000000000000000000000000000000000"
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_a/image/"+stale, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("stale hash: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_a/image/nothex", nil, nil); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad hash: %d", res.StatusCode)
	}

	big := append(append([]byte{}, tinyPNG...), make([]byte, MaxImageBytes)...)
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_a/image", big, nil); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d", res.StatusCode)
	}

	if res, body := do(t, "GET", ts.URL+"/projects/prj_a/image", nil, nil); res.StatusCode != http.StatusOK || body["hash"] != hash {
		t.Fatalf("image status: %d %v", res.StatusCode, body)
	}
	head, _ := do(t, "HEAD", ts.URL+"/projects/prj_a/image/"+hash, nil, nil)
	if head.StatusCode != http.StatusOK || head.Header.Get("Content-Length") != strconv.Itoa(len(tinyPNG)) {
		t.Fatalf("head: %d %v", head.StatusCode, head.Header)
	}
	if res, _ := do(t, "DELETE", ts.URL+"/projects/prj_a/image", nil, nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("delete image: %d", res.StatusCode)
	}
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_a/image/"+hash, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("image after its delete: %d", res.StatusCode)
	}
	if res, body := do(t, "GET", ts.URL+"/projects/prj_a/image", nil, nil); res.StatusCode != http.StatusOK || body["hash"] != nil {
		t.Fatalf("image status after delete: %d %v", res.StatusCode, body)
	}
	do(t, "PUT", ts.URL+"/projects/prj_a/image", tinyPNG, nil)
	do(t, "DELETE", ts.URL+"/projects/prj_a", nil, nil)
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_a/image/"+hash, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("image after delete: %d", res.StatusCode)
	}
}

// tinyGLB is a binary glTF 2.0 with only a JSON chunk: enough for the header check.
func tinyGLB(extra string) []byte {
	js := []byte(`{"asset":{"version":"2.0"}` + extra + `}`)
	for len(js)%4 != 0 {
		js = append(js, ' ')
	}
	out := make([]byte, 20, 20+len(js))
	copy(out, "glTF")
	binary.LittleEndian.PutUint32(out[4:], 2)
	binary.LittleEndian.PutUint32(out[8:], uint32(20+len(js)))
	binary.LittleEndian.PutUint32(out[12:], uint32(len(js)))
	copy(out[16:], "JSON")
	return append(out, js...)
}

func TestModels(t *testing.T) {
	ts := newTestServer(t)
	glb := tinyGLB("")
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m/models", glb, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("model for a missing project: %d", res.StatusCode)
	}
	do(t, "POST", ts.URL+"/projects", doc("prj_m", "Flat", 0), nil)

	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m/models", tinyPNG, nil); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("non-glb upload: %d", res.StatusCode)
	}
	short := glb[:len(glb)-4] // its header says longer than it is
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m/models", short, nil); res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("truncated glb: %d", res.StatusCode)
	}
	res, body := do(t, "PUT", ts.URL+"/projects/prj_m/models", glb, nil)
	hash, _ := body["hash"].(string)
	if res.StatusCode != http.StatusOK || len(hash) != 64 {
		t.Fatalf("upload: %d %v", res.StatusCode, body)
	}
	// The same file again is the same model.
	if _, body := do(t, "PUT", ts.URL+"/projects/prj_m/models", glb, nil); body["hash"] != hash {
		t.Fatalf("re-upload: %v", body)
	}

	get, err := http.Get(ts.URL + "/projects/prj_m/models/" + hash)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(get.Body)
	get.Body.Close()
	if get.StatusCode != http.StatusOK || !bytes.Equal(got, glb) ||
		get.Header.Get("Content-Type") != "model/gltf-binary" ||
		get.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("get: %d %v", get.StatusCode, get.Header)
	}
	stale := strings.Repeat("0", 64)
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_m/models/"+stale, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown hash: %d", res.StatusCode)
	}

	// A project holds at most MaxModelsPerProject models that its plan uses.
	save := func(version int, hashes []string) {
		models := map[string]any{}
		for i, h := range hashes {
			models[fmt.Sprintf("mdl_%d", i)] = map[string]any{"hash": h}
		}
		b, _ := json.Marshal(map[string]any{
			"schemaVersion": 6, "id": "prj_m", "version": version, "name": "Flat", "units": "m",
			"underlay": nil, "levels": []any{map[string]any{}}, "models": models,
		})
		if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m", b, map[string]string{"If-Match": fmt.Sprintf(`"%d"`, version)}); res.StatusCode != http.StatusOK {
			t.Fatalf("save v%d: %d", version, res.StatusCode)
		}
	}
	all := []string{hash}
	for i := 1; i < MaxModelsPerProject; i++ {
		res, body := do(t, "PUT", ts.URL+"/projects/prj_m/models", tinyGLB(fmt.Sprintf(`,"n":%d`, i)), nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("model %d: %d", i, res.StatusCode)
		}
		all = append(all, body["hash"].(string))
	}
	save(1, all)
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m/models", tinyGLB(`,"n":-1`), nil); res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("one too many: %d", res.StatusCode)
	}
	if res, body := do(t, "GET", ts.URL+"/projects/prj_m/models", nil, nil); res.StatusCode != http.StatusOK || len(body["hashes"].([]any)) != MaxModelsPerProject {
		t.Fatalf("list: %d %v", res.StatusCode, body)
	}
	// The plan names only the first model now: the rest make room for a new one.
	save(2, all[:1])
	if res, _ := do(t, "PUT", ts.URL+"/projects/prj_m/models", tinyGLB(`,"n":-1`), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("upload once unused ones go: %d", res.StatusCode)
	}
	if _, body := do(t, "GET", ts.URL+"/projects/prj_m/models", nil, nil); len(body["hashes"].([]any)) != 2 {
		t.Fatalf("after making room: %v", body)
	}

	do(t, "DELETE", ts.URL+"/projects/prj_m", nil, nil)
	if res, _ := do(t, "GET", ts.URL+"/projects/prj_m/models/"+hash, nil, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("model after delete: %d", res.StatusCode)
	}
}

func TestSharing(t *testing.T) {
	ts := newTestServer(t)
	res, _ := do(t, "POST", ts.URL+"/projects", doc("prj_s", "Flat", 0), nil)
	if res.Header.Get("X-Owner-Token") == "" || res.Header.Get("X-Role") != "owner" {
		t.Fatalf("create should return an owner key: %v", res.Header)
	}
	anon := map[string]string{"Authorization": ""}

	// The plain link views.
	got, _ := do(t, "GET", ts.URL+"/projects/prj_s", nil, anon)
	if got.StatusCode != http.StatusOK || got.Header.Get("X-Role") != "viewer" {
		t.Fatalf("viewer get: %d %q", got.StatusCode, got.Header.Get("X-Role"))
	}
	if r, _ := do(t, "PUT", ts.URL+"/projects/prj_s", doc("prj_s", "Hacked", 1), map[string]string{"If-Match": `"1"`, "Authorization": ""}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer put: %d", r.StatusCode)
	}
	if r, _ := do(t, "DELETE", ts.URL+"/projects/prj_s", nil, anon); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer delete: %d", r.StatusCode)
	}
	if r, _ := do(t, "PUT", ts.URL+"/projects/prj_s/image", tinyPNG, anon); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer image: %d", r.StatusCode)
	}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_s/share", nil, anon); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer share: %d", r.StatusCode)
	}

	// The owner turns the edit link on; its key edits but can't share or delete.
	_, share := do(t, "PUT", ts.URL+"/projects/prj_s/share", []byte(`{"edit":true}`), nil)
	key, _ := share["edit"].(string)
	if key == "" {
		t.Fatalf("share: %v", share)
	}
	asEditor := map[string]string{"Authorization": "Bearer " + key}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_s", nil, asEditor); r.Header.Get("X-Role") != "editor" {
		t.Fatalf("editor role: %q", r.Header.Get("X-Role"))
	}
	if r, _ := do(t, "PUT", ts.URL+"/projects/prj_s", doc("prj_s", "Edited", 1), map[string]string{"If-Match": `"1"`, "Authorization": "Bearer " + key}); r.StatusCode != http.StatusOK {
		t.Fatalf("editor put: %d", r.StatusCode)
	}
	if r, _ := do(t, "DELETE", ts.URL+"/projects/prj_s", nil, asEditor); r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor delete: %d", r.StatusCode)
	}
	if r, _ := do(t, "PUT", ts.URL+"/projects/prj_s/share", []byte(`{"edit":true,"reset":true}`), asEditor); r.StatusCode != http.StatusForbidden {
		t.Fatalf("editor reshare: %d", r.StatusCode)
	}

	// Resetting the link stops the old key; turning it off stops editing by link at all.
	_, again := do(t, "PUT", ts.URL+"/projects/prj_s/share", []byte(`{"edit":true,"reset":true}`), nil)
	if again["edit"] == key {
		t.Fatal("reset kept the old key")
	}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_s", nil, asEditor); r.Header.Get("X-Role") != "viewer" {
		t.Fatalf("old key after reset: %q", r.Header.Get("X-Role"))
	}
	_, off := do(t, "PUT", ts.URL+"/projects/prj_s/share", []byte(`{"edit":false}`), nil)
	if off["edit"] != nil {
		t.Fatalf("off: %v", off)
	}

	// A project without an owner (from before sharing) is open, and can be claimed once.
	st := store.NewMemory()
	open := httptest.NewServer(New(st, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(open.Close)
	_ = st.Create(t.Context(), store.Record{ID: "prj_old", Name: "Old", Doc: doc("prj_old", "Old", 1)})
	if r, _ := do(t, "GET", open.URL+"/projects/prj_old", nil, anon); r.Header.Get("X-Role") != "open" {
		t.Fatalf("legacy role: %q", r.Header.Get("X-Role"))
	}
	// Creating a project with its id fails and leaves it open, not owned by nobody.
	if r, _ := do(t, "POST", open.URL+"/projects", doc("prj_old", "Mine", 0), nil); r.StatusCode != http.StatusConflict {
		t.Fatalf("create over a legacy id: %d", r.StatusCode)
	}
	if r, _ := do(t, "GET", open.URL+"/projects/prj_old", nil, anon); r.Header.Get("X-Role") != "open" {
		t.Fatalf("legacy role after a failed create: %q", r.Header.Get("X-Role"))
	}
	r, claimed := do(t, "POST", open.URL+"/projects/prj_old/claim", nil, anon)
	owner, _ := claimed["owner"].(string)
	if r.StatusCode != http.StatusOK || owner == "" {
		t.Fatalf("claim: %d %v", r.StatusCode, claimed)
	}
	if r, _ := do(t, "POST", open.URL+"/projects/prj_old/claim", nil, anon); r.StatusCode != http.StatusConflict {
		t.Fatalf("second claim: %d", r.StatusCode)
	}
	if r, _ := do(t, "GET", open.URL+"/projects/prj_old", nil, map[string]string{"Authorization": "Bearer " + owner}); r.Header.Get("X-Role") != "owner" {
		t.Fatalf("claimed role: %q", r.Header.Get("X-Role"))
	}
}

func TestVersionHistory(t *testing.T) {
	ts := newTestServer(t)
	do(t, "POST", ts.URL+"/projects", doc("prj_h", "One", 0), nil)
	do(t, "PUT", ts.URL+"/projects/prj_h", doc("prj_h", "Two", 1), map[string]string{"If-Match": `"1"`})
	do(t, "PUT", ts.URL+"/projects/prj_h", doc("prj_h", "Three", 2), map[string]string{"If-Match": `"2"`})

	res, out := do(t, "GET", ts.URL+"/projects/prj_h/versions", nil, nil)
	vs, _ := out["versions"].([]any)
	if res.StatusCode != http.StatusOK || len(vs) != 2 {
		t.Fatalf("versions: %d %v", res.StatusCode, out)
	}
	first, _ := vs[0].(map[string]any)
	if first["version"] != float64(1) || first["replacedAt"] == "" {
		t.Fatalf("first version: %v", first)
	}
	res, got := do(t, "GET", ts.URL+"/projects/prj_h/versions/1", nil, nil)
	if res.StatusCode != http.StatusOK || got["name"] != "One" {
		t.Fatalf("version 1: %d %v", res.StatusCode, got)
	}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_h/versions/9", nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("missing version: %d", r.StatusCode)
	}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_h/versions/x", nil, nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad version: %d", r.StatusCode)
	}
	// A view-only link doesn't see past versions.
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_h/versions", nil, map[string]string{"Authorization": ""}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer versions: %d", r.StatusCode)
	}
	if r, _ := do(t, "GET", ts.URL+"/projects/prj_nope/versions", nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("missing project: %d", r.StatusCode)
	}
}
