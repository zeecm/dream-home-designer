package store

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// AWS's published SigV4 example for S3 (GET Object with a Range header).
func TestSignMatchesAWSExample(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	now := time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC)
	sign(req, nil, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", now)
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
		"Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization\n got %s\nwant %s", got, want)
	}
}

// fakeS3 implements the slice of the S3 API the R2 store uses, including R2's
// conditional writes, so the store's logic is tested without the network.
type fakeS3 struct {
	mu      sync.Mutex
	writes  int
	objects map[string]fakeObject
	// beforePut lets a test interleave a competing write.
	beforePut func()
}

type fakeObject struct {
	body []byte
	meta http.Header
	etag string
}

func newFakeS3(t *testing.T) (*fakeS3, *httptest.Server) {
	f := &fakeS3{objects: map[string]fakeObject{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=test/") {
		http.Error(w, "unsigned", http.StatusForbidden)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 2)
	key := ""
	if len(parts) == 2 {
		key = parts[1]
	}
	if r.Method == http.MethodPut && f.beforePut != nil {
		hook := f.beforePut
		f.beforePut = nil
		hook()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	obj, exists := f.objects[key]
	switch {
	case r.Method == http.MethodGet && key == "":
		type content struct{ Key string }
		var out struct {
			XMLName  xml.Name `xml:"ListBucketResult"`
			Contents []content
		}
		for k := range f.objects {
			if strings.HasPrefix(k, r.URL.Query().Get("prefix")) {
				out.Contents = append(out.Contents, content{Key: k})
			}
		}
		_ = xml.NewEncoder(w).Encode(out)
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		if !exists {
			http.Error(w, "NoSuchKey", http.StatusNotFound)
			return
		}
		for k, v := range obj.meta {
			w.Header()[k] = v
		}
		w.Header().Set("ETag", obj.etag)
		if r.Method == http.MethodGet {
			_, _ = w.Write(obj.body)
		}
	case r.Method == http.MethodPut:
		if r.Header.Get("If-None-Match") == "*" && exists {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		if m := r.Header.Get("If-Match"); m != "" && (!exists || m != obj.etag) {
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		body, _ := io.ReadAll(r.Body)
		meta := http.Header{}
		for k, v := range r.Header {
			if strings.HasPrefix(k, "X-Amz-Meta-") {
				meta[k] = v
			}
		}
		f.writes++
		sum := md5.Sum(append(body, byte(f.writes)))
		f.objects[key] = fakeObject{body: body, meta: meta, etag: `"` + hex.EncodeToString(sum[:]) + `"`}
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unsupported", http.StatusMethodNotAllowed)
	}
}

func TestR2StoreContractAgainstFake(t *testing.T) {
	runContract(t, func(t *testing.T) Store {
		_, srv := newFakeS3(t)
		return NewR2(srv.URL, "bucket", "test", "secret")
	})
}

func TestR2UpdateLosesRaceCleanly(t *testing.T) {
	f, srv := newFakeS3(t)
	s := NewR2(srv.URL, "bucket", "test", "secret")
	ctx := context.Background()
	if err := s.Create(ctx, Record{ID: "prj_a", Name: "Flat", Doc: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	// Another writer lands between our HEAD and PUT.
	f.beforePut = func() {
		other := NewR2(srv.URL, "bucket", "test", "secret")
		if _, err := other.Update(ctx, "prj_a", 1, "Other", func(int) ([]byte, error) { return []byte(`{}`), nil }); err != nil {
			t.Error(err)
		}
	}
	_, err := s.Update(ctx, "prj_a", 1, "Mine", func(int) ([]byte, error) { return []byte(`{}`), nil })
	var ce *ConflictError
	if !errorsAs(err, &ce) || ce.Current != 2 {
		t.Fatalf("want conflict at v2, got %v", err)
	}
}

// TestR2Live runs the contract against a real bucket when R2_TEST_* is set.
func TestR2Live(t *testing.T) {
	endpoint := os.Getenv("R2_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set R2_TEST_ENDPOINT, R2_TEST_BUCKET, R2_TEST_ACCESS_KEY, R2_TEST_SECRET_KEY")
	}
	runContract(t, func(t *testing.T) Store {
		s := NewR2(endpoint, os.Getenv("R2_TEST_BUCKET"), os.Getenv("R2_TEST_ACCESS_KEY"), os.Getenv("R2_TEST_SECRET_KEY"))
		t.Cleanup(func() {
			list, _ := s.List(context.Background())
			for _, p := range list {
				_ = s.Delete(context.Background(), p.ID)
			}
		})
		return s
	})
}
