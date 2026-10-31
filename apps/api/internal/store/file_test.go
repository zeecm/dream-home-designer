package store

import (
	"context"
	"errors"
	"testing"
)

func TestFileStorePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()

	s, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Create(ctx, Record{ID: "prj_a", Name: "Flat", Doc: []byte(`{"version":1}`)}); err != nil {
		t.Fatal(err)
	}
	v, err := s.Update(ctx, "prj_a", 1, "Flat 2", func(v int) ([]byte, error) { return []byte(`{"version":2}`), nil })
	if err != nil || v != 2 {
		t.Fatalf("update: v=%d err=%v", v, err)
	}

	reopened, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	rec, err := reopened.Get(ctx, "prj_a")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Version != 2 || rec.Name != "Flat 2" || string(rec.Doc) != `{"version":2}` {
		t.Fatalf("unexpected record after reopen: %+v doc=%s", rec, rec.Doc)
	}

	if err := reopened.Delete(ctx, "prj_a"); err != nil {
		t.Fatal(err)
	}
	again, _ := NewFile(dir)
	if _, err := again.Get(ctx, "prj_a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound after delete, got %v", err)
	}
}

func TestUpdateBuildErrorLeavesStoreUnchanged(t *testing.T) {
	ctx := context.Background()
	s := NewMemory()
	_ = s.Create(ctx, Record{ID: "prj_a", Name: "Flat", Doc: []byte(`{}`)})
	_, err := s.Update(ctx, "prj_a", 1, "x", func(int) ([]byte, error) { return nil, errors.New("boom") })
	if err == nil {
		t.Fatal("want error")
	}
	rec, _ := s.Get(ctx, "prj_a")
	if rec.Version != 1 || rec.Name != "Flat" {
		t.Fatalf("store changed on failed update: %+v", rec)
	}
}

func TestFileStoreKeepsImagesAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Create(ctx, Record{ID: "prj_a", Name: "Flat", Doc: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutImage(ctx, "prj_a", Image{Hash: "h1", ContentType: "image/png", Data: []byte("png")}); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	img, err := readImage(ctx, reopened, "prj_a")
	if err != nil || img.Hash != "h1" || img.ContentType != "image/png" || string(img.Data) != "png" {
		t.Fatalf("image after reopen: %+v %v", img, err)
	}
	if err := reopened.Delete(ctx, "prj_a"); err != nil {
		t.Fatal(err)
	}
	again, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readImage(ctx, again, "prj_a"); !errors.Is(err, ErrNoImage) {
		t.Fatalf("image after delete and reopen: %v", err)
	}
}

func TestFileStoreKeepsModelsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s, _ := NewFile(dir)
	_ = s.Create(ctx, Record{ID: "prj_m", Name: "M", Doc: []byte(`{}`)})
	if err := s.PutModel(ctx, "prj_m", "abc", []byte("glTF abc")); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewFile(dir)
	if err != nil {
		t.Fatal(err)
	}
	if hs, _ := reopened.Models(ctx, "prj_m"); len(hs) != 1 || hs[0] != "abc" {
		t.Fatalf("models after reopen: %v", hs)
	}
	if err := reopened.Delete(ctx, "prj_m"); err != nil {
		t.Fatal(err)
	}
	again, _ := NewFile(dir)
	if hs, _ := again.Models(ctx, "prj_m"); len(hs) != 0 {
		t.Fatalf("models after delete and reopen: %v", hs)
	}
}
