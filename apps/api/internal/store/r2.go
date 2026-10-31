package store

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// R2 stores each project as one object, projects/<id>.json, in a Cloudflare R2 bucket
// via its S3-compatible API. The version, name and update time travel as object
// metadata. Conditional writes (If-None-Match on create, If-Match on the ETag for
// updates) give the same optimistic-concurrency guarantees as the in-memory store,
// across any number of API instances.
//
// Requests are signed with AWS Signature Version 4 using the standard library only.
type R2 struct {
	Endpoint  string // e.g. https://<account>.r2.cloudflarestorage.com
	Bucket    string
	AccessKey string
	SecretKey string
	Client    *http.Client
	now       func() time.Time
}

// NewR2 returns an R2 store. endpoint is the account's S3 endpoint.
func NewR2(endpoint, bucket, accessKey, secretKey string) *R2 {
	return &R2{
		Endpoint:  strings.TrimRight(endpoint, "/"),
		Bucket:    bucket,
		AccessKey: accessKey,
		SecretKey: secretKey,
		Client:    &http.Client{Timeout: 20 * time.Second},
		now:       time.Now,
	}
}

const (
	r2Prefix    = "projects/"
	metaVersion = "X-Amz-Meta-Version"
	metaName    = "X-Amz-Meta-Name"
	metaUpdated = "X-Amz-Meta-Updated"
	// maxList bounds List so a large bucket can't turn one request into thousands.
	maxList = 200
)

func objectKey(id string) string { return r2Prefix + id + ".json" }

type objectMeta struct {
	etag    string
	version int
	name    string
	updated time.Time
}

func metaFrom(h http.Header) (objectMeta, error) {
	v, err := strconv.Atoi(h.Get(metaVersion))
	if err != nil {
		return objectMeta{}, fmt.Errorf("object has no version metadata: %w", err)
	}
	name, err := url.QueryUnescape(h.Get(metaName))
	if err != nil {
		name = h.Get(metaName)
	}
	updated, _ := time.Parse(time.RFC3339Nano, h.Get(metaUpdated))
	return objectMeta{etag: h.Get("ETag"), version: v, name: name, updated: updated}, nil
}

func (s *R2) List(ctx context.Context) ([]Summary, error) {
	var keys []string
	token := ""
	for len(keys) < maxList {
		q := url.Values{"list-type": {"2"}, "prefix": {r2Prefix}, "max-keys": {"1000"}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		res, err := s.do(ctx, http.MethodGet, "", q, nil, nil)
		if err != nil {
			return nil, err
		}
		var out struct {
			Contents              []struct{ Key string }
			IsTruncated           bool
			NextContinuationToken string
		}
		err = xml.NewDecoder(res.Body).Decode(&out)
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("r2 list: %w", err)
		}
		for _, c := range out.Contents {
			keys = append(keys, c.Key)
		}
		if !out.IsTruncated {
			break
		}
		token = out.NextContinuationToken
	}
	if len(keys) > maxList {
		keys = keys[:maxList]
	}

	out := make([]Summary, 0, len(keys))
	for _, k := range keys {
		id := strings.TrimSuffix(strings.TrimPrefix(k, r2Prefix), ".json")
		m, err := s.head(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue // deleted since the listing
		}
		if err != nil {
			return nil, err
		}
		out = append(out, Summary{ID: id, Name: m.name, Version: m.version, UpdatedAt: m.updated})
	}
	slices.SortFunc(out, func(a, b Summary) int {
		if c := b.UpdatedAt.Compare(a.UpdatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

func (s *R2) Get(ctx context.Context, id string) (Record, error) {
	res, err := s.do(ctx, http.MethodGet, objectKey(id), nil, nil, nil)
	if err != nil {
		return Record{}, err
	}
	defer res.Body.Close()
	m, err := metaFrom(res.Header)
	if err != nil {
		return Record{}, err
	}
	doc, err := io.ReadAll(res.Body)
	if err != nil {
		return Record{}, err
	}
	return Record{ID: id, Name: m.name, Version: m.version, Doc: doc, UpdatedAt: m.updated}, nil
}

func (s *R2) Create(ctx context.Context, rec Record) error {
	rec.Version = 1
	err := s.put(ctx, rec, http.Header{"If-None-Match": {"*"}})
	if errors.Is(err, errPrecondition) {
		return ErrExists
	}
	return err
}

func (s *R2) Update(ctx context.Context, id string, expected int, name string, build func(int) ([]byte, error)) (int, error) {
	m, err := s.head(ctx, id)
	if err != nil {
		return 0, err
	}
	if m.version != expected {
		return 0, &ConflictError{Current: m.version}
	}
	next := expected + 1
	doc, err := build(next)
	if err != nil {
		return 0, err
	}
	// Keep the version being replaced, so a bad save (or a vandal with an edit link) can be
	// undone by hand. Best effort: a failed copy doesn't block the save.
	_ = s.copy(ctx, objectKey(id), previousKey(id, m.version), m.etag)
	err = s.put(ctx, Record{ID: id, Name: name, Version: next, Doc: doc}, http.Header{"If-Match": {m.etag}})
	if errors.Is(err, errPrecondition) {
		// Someone else wrote between our HEAD and PUT; report what's there now.
		cur, herr := s.head(ctx, id)
		if herr != nil {
			return 0, herr
		}
		return 0, &ConflictError{Current: cur.version}
	}
	if err != nil {
		return 0, err
	}
	return next, nil
}

func (s *R2) Delete(ctx context.Context, id string) error {
	// A deleted project is kept for a while (the bucket's lifecycle rule expires it), so a
	// delete can be undone by hand. No copy, no delete. A save landing in between changes
	// the version to copy, so look again.
	var err error
	for try := 0; try < 3; try++ {
		var m objectMeta
		if m, err = s.head(ctx, id); err != nil {
			return err
		}
		if err = s.copy(ctx, objectKey(id), deletedKey(id), m.etag); !errors.Is(err, errPrecondition) {
			break
		}
	}
	if err != nil {
		return err
	}
	// Its owner too, so a restored project isn't left open to anyone with the link.
	_ = s.copy(ctx, accessKey(id), deletedAccessKey(id), "")
	// The project goes first: if a later step fails, a leftover image or access record is
	// harmless, whereas a project without its access record would be open to anyone.
	res, err := s.do(ctx, http.MethodDelete, objectKey(id), nil, nil, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	_ = s.DeleteImage(ctx, id)
	_ = s.DeleteModels(ctx, id)
	_ = s.DeleteAccess(ctx, id)
	return nil
}

// Versions lists the versions saves replaced (the recovery copies), oldest first.
func (s *R2) Versions(ctx context.Context, id string) ([]Version, error) {
	prefix := "previous/" + id + "/"
	var out []Version
	token := ""
	for {
		q := url.Values{"list-type": {"2"}, "prefix": {prefix}, "max-keys": {"1000"}}
		if token != "" {
			q.Set("continuation-token", token)
		}
		res, err := s.do(ctx, http.MethodGet, "", q, nil, nil)
		if err != nil {
			return nil, err
		}
		var page struct {
			Contents []struct {
				Key          string
				LastModified time.Time
			}
			IsTruncated           bool
			NextContinuationToken string
		}
		err = xml.NewDecoder(res.Body).Decode(&page)
		res.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("r2 list versions: %w", err)
		}
		for _, c := range page.Contents {
			v, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(c.Key, prefix), ".json"))
			if err != nil {
				continue
			}
			// The copy is made as the next save replaces it, so its time is the replacement's.
			out = append(out, Version{Version: v, ReplacedAt: c.LastModified})
		}
		if !page.IsTruncated || len(out) >= 5000 {
			break
		}
		token = page.NextContinuationToken
	}
	slices.SortFunc(out, func(a, b Version) int { return a.Version - b.Version })
	return out, nil
}

// GetVersion returns a version a save replaced, or ErrNotFound once it has expired.
func (s *R2) GetVersion(ctx context.Context, id string, version int) ([]byte, error) {
	res, err := s.do(ctx, http.MethodGet, previousKey(id, version), nil, nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(res.Body)
}

var errPrecondition = errors.New("precondition failed")

// Recovery copies: each version a save replaced, and deleted projects with their access
// records. The bucket's lifecycle rules expire both prefixes (see HANDOVER), so they never
// pile up.
func previousKey(id string, version int) string {
	return fmt.Sprintf("previous/%s/%d.json", id, version)
}
func deletedKey(id string) string       { return "deleted/" + id + ".json" }
func deletedAccessKey(id string) string { return "deleted/" + id + ".access.json" }

// copy copies an object within the bucket on the server side, only if it is still the
// version with etag `match` (any version if empty).
func (s *R2) copy(ctx context.Context, from, to, match string) error {
	h := http.Header{"X-Amz-Copy-Source": {"/" + url.PathEscape(s.Bucket) + "/" + from}}
	if match != "" {
		h.Set("X-Amz-Copy-Source-If-Match", match)
	}
	res, err := s.do(ctx, http.MethodPut, to, nil, h, nil)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

func (s *R2) head(ctx context.Context, id string) (objectMeta, error) {
	res, err := s.do(ctx, http.MethodHead, objectKey(id), nil, nil, nil)
	if err != nil {
		return objectMeta{}, err
	}
	res.Body.Close()
	return metaFrom(res.Header)
}

func (s *R2) put(ctx context.Context, rec Record, cond http.Header) error {
	h := http.Header{
		"Content-Type": {"application/json"},
		metaVersion:    {strconv.Itoa(rec.Version)},
		metaName:       {url.QueryEscape(rec.Name)},
		metaUpdated:    {s.now().UTC().Format(time.RFC3339Nano)},
	}
	for k, v := range cond {
		h[k] = v
	}
	res, err := s.do(ctx, http.MethodPut, objectKey(rec.ID), nil, h, rec.Doc)
	if err != nil {
		return err
	}
	res.Body.Close()
	return nil
}

// do sends a signed request and maps 404 and 412 to ErrNotFound and errPrecondition.
// The caller closes the body of a successful response.
func (s *R2) do(ctx context.Context, method, key string, query url.Values, h http.Header, body []byte) (*http.Response, error) {
	segs := strings.Split(key, "/")
	for i, seg := range segs {
		segs[i] = url.PathEscape(seg)
	}
	u, err := url.Parse(s.Endpoint + "/" + url.PathEscape(s.Bucket) + "/" + strings.Join(segs, "/"))
	if err != nil {
		return nil, err
	}
	u.RawQuery = canonicalQuery(query)
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range h {
		req.Header[http.CanonicalHeaderKey(k)] = v
	}
	if body == nil {
		req.Body = http.NoBody
	}
	req.ContentLength = int64(len(body))
	sign(req, body, s.AccessKey, s.SecretKey, r2Region, s.now().UTC())

	res, err := s.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("r2 %s %s: %w", method, key, err)
	}
	switch {
	case res.StatusCode == http.StatusNotFound:
		res.Body.Close()
		return nil, ErrNotFound
	case res.StatusCode == http.StatusPreconditionFailed:
		res.Body.Close()
		return nil, errPrecondition
	case res.StatusCode >= 300:
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		res.Body.Close()
		return nil, fmt.Errorf("r2 %s %s: %s: %s", method, key, res.Status, bytes.TrimSpace(msg))
	}
	return res, nil
}

// ------------------------------------------------------------------------- SigV4

const (
	r2Region   = "auto"
	sigService = "s3"
)

func hashHex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// uriEncode encodes per AWS rules: unreserved characters stay, everything else is %XX.
func uriEncode(s string, keepSlash bool) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case 'A' <= c && c <= 'Z', 'a' <= c && c <= 'z', '0' <= c && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == '/' && keepSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		vs := slices.Clone(q[k])
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k, false)+"="+uriEncode(v, false))
		}
	}
	return strings.Join(parts, "&")
}

// sign adds SigV4 headers to req, signing every header it carries plus host.
func sign(req *http.Request, body []byte, accessKey, secretKey, region string, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	day := now.Format("20060102")
	payload := hashHex(body)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payload)

	headers := map[string]string{"host": req.URL.Host}
	for k, v := range req.Header {
		headers[strings.ToLower(k)] = strings.Join(v, ",")
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + strings.TrimSpace(headers[k]) + "\n")
	}
	signed := strings.Join(names, ";")

	canonical := strings.Join([]string{
		req.Method,
		uriEncode(req.URL.Path, true),
		req.URL.RawQuery,
		canonHeaders.String(),
		signed,
		payload,
	}, "\n")
	scope := day + "/" + region + "/" + sigService + "/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hashHex([]byte(canonical))

	key := hmacSHA256([]byte("AWS4"+secretKey), day)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, sigService)
	key = hmacSHA256(key, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(key, toSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey, scope, signed, sig))
}
