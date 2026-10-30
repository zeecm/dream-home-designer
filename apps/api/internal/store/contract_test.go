package store

import (
	"context"
	"errors"
	"testing"
)

func errorsAs(err error, target any) bool { return errors.As(err, target) }

func TestMemoryStoreContract(t *testing.T) {
	runContract(t, func(*testing.T) Store { return NewMemory() })
}

func TestFileStoreContract(t *testing.T) {
	runContract(t, func(t *testing.T) Store {
		s, err := NewFile(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}

// runContract checks the behaviour every Store must share.
func runContract(t *testing.T, newStore func(t *testing.T) Store) {
	ctx := context.Background()
	doc := func(int) ([]byte, error) { return []byte(`{"v":true}`), nil }

	t.Run("create, get, update, list, delete", func(t *testing.T) {
		s := newStore(t)
		if err := s.Create(ctx, Record{ID: "prj_a", Name: "Flat · 4-room", Doc: []byte(`{"a":1}`)}); err != nil {
			t.Fatal(err)
		}
		rec, err := s.Get(ctx, "prj_a")
		if err != nil || rec.Version != 1 || rec.Name != "Flat · 4-room" || string(rec.Doc) != `{"a":1}` {
			t.Fatalf("get after create: %+v %v", rec, err)
		}
		v, err := s.Update(ctx, "prj_a", 1, "Renamed", doc)
		if err != nil || v != 2 {
			t.Fatalf("update: v=%d err=%v", v, err)
		}
		rec, _ = s.Get(ctx, "prj_a")
		if rec.Version != 2 || rec.Name != "Renamed" || string(rec.Doc) != `{"v":true}` {
			t.Fatalf("get after update: %+v", rec)
		}
		list, err := s.List(ctx)
		if err != nil || len(list) != 1 || list[0].ID != "prj_a" || list[0].Version != 2 {
			t.Fatalf("list: %+v %v", list, err)
		}
		if err := s.Delete(ctx, "prj_a"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get(ctx, "prj_a"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get after delete: %v", err)
		}
	})

	t.Run("plan image", func(t *testing.T) {
		s := newStore(t)
		imgs, ok := s.(ImageStore)
		if !ok {
			t.Fatal("store does not keep plan images")
		}
		img := Image{Hash: "abc", ContentType: "image/png", Data: []byte("\x89PNG fake")}
		if err := imgs.PutImage(ctx, "prj_i", img); !errors.Is(err, ErrNotFound) {
			t.Fatalf("image for a missing project: %v", err)
		}
		if err := s.Create(ctx, Record{ID: "prj_i", Name: "I", Doc: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		if _, err := imgs.GetImage(ctx, "prj_i"); !errors.Is(err, ErrNoImage) {
			t.Fatalf("get before put: %v", err)
		}
		if err := imgs.PutImage(ctx, "prj_i", img); err != nil {
			t.Fatal(err)
		}
		got, err := imgs.GetImage(ctx, "prj_i")
		if err != nil || got.Hash != "abc" || got.ContentType != "image/png" || string(got.Data) != string(img.Data) {
			t.Fatalf("get: %+v %v", got, err)
		}
		next := Image{Hash: "def", ContentType: "image/jpeg", Data: []byte("jpeg")}
		if err := imgs.PutImage(ctx, "prj_i", next); err != nil {
			t.Fatal(err)
		}
		if got, _ := imgs.GetImage(ctx, "prj_i"); got.Hash != "def" || string(got.Data) != "jpeg" {
			t.Fatalf("replace: %+v", got)
		}
		if err := s.Delete(ctx, "prj_i"); err != nil {
			t.Fatal(err)
		}
		if _, err := imgs.GetImage(ctx, "prj_i"); !errors.Is(err, ErrNoImage) {
			t.Fatalf("image outlived its project: %v", err)
		}
	})

	t.Run("errors", func(t *testing.T) {
		s := newStore(t)
		if _, err := s.Get(ctx, "prj_missing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("get missing: %v", err)
		}
		if _, err := s.Update(ctx, "prj_missing", 1, "x", doc); !errors.Is(err, ErrNotFound) {
			t.Fatalf("update missing: %v", err)
		}
		if err := s.Delete(ctx, "prj_missing"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("delete missing: %v", err)
		}
		if err := s.Create(ctx, Record{ID: "prj_b", Name: "B", Doc: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		if err := s.Create(ctx, Record{ID: "prj_b", Name: "B", Doc: []byte(`{}`)}); !errors.Is(err, ErrExists) {
			t.Fatalf("duplicate create: %v", err)
		}
		var ce *ConflictError
		if _, err := s.Update(ctx, "prj_b", 7, "x", doc); !errors.As(err, &ce) || ce.Current != 1 {
			t.Fatalf("stale update: %v", err)
		}
	})
}
