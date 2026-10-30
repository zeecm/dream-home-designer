package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

func do(t *testing.T, method, url string, body []byte, hdr map[string]string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
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
