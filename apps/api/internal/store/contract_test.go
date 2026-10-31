package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func errorsAs(err error, target any) bool { return errors.As(err, target) }

// readImage reads a whole image through the two-step API and checks they agree.
func readImage(ctx context.Context, s ImageStore, id string) (Image, error) {
	info, err := s.ImageInfo(ctx, id)
	if err != nil {
		return Image{}, err
	}
	got, body, err := s.OpenImage(ctx, id)
	if err != nil {
		return Image{}, err
	}
	defer body.Close()
	data, err := io.ReadAll(body)
	if err != nil {
		return Image{}, err
	}
	if got.Hash != info.Hash || int64(len(data)) != info.Size {
		return Image{}, fmt.Errorf("info %+v does not match the image read (%s, %d bytes)", info, got.Hash, len(data))
	}
	return Image{Hash: got.Hash, ContentType: got.ContentType, Data: data}, nil
}

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
		if _, err := readImage(ctx, imgs, "prj_i"); !errors.Is(err, ErrNoImage) {
			t.Fatalf("get before put: %v", err)
		}
		if err := imgs.PutImage(ctx, "prj_i", img); err != nil {
			t.Fatal(err)
		}
		got, err := readImage(ctx, imgs, "prj_i")
		if err != nil || got.Hash != "abc" || got.ContentType != "image/png" || string(got.Data) != string(img.Data) {
			t.Fatalf("get: %+v %v", got, err)
		}
		next := Image{Hash: "def", ContentType: "image/jpeg", Data: []byte("jpeg")}
		if err := imgs.PutImage(ctx, "prj_i", next); err != nil {
			t.Fatal(err)
		}
		if got, _ := readImage(ctx, imgs, "prj_i"); got.Hash != "def" || string(got.Data) != "jpeg" {
			t.Fatalf("replace: %+v", got)
		}
		if err := imgs.DeleteImage(ctx, "prj_i"); err != nil {
			t.Fatal(err)
		}
		if _, err := imgs.ImageInfo(ctx, "prj_i"); !errors.Is(err, ErrNoImage) {
			t.Fatalf("image after DeleteImage: %v", err)
		}
		if err := imgs.PutImage(ctx, "prj_i", img); err != nil {
			t.Fatal(err)
		}
		if err := s.Delete(ctx, "prj_i"); err != nil {
			t.Fatal(err)
		}
		if _, err := readImage(ctx, imgs, "prj_i"); !errors.Is(err, ErrNoImage) {
			t.Fatalf("image outlived its project: %v", err)
		}
	})

	t.Run("models", func(t *testing.T) {
		s := newStore(t)
		ms, ok := s.(ModelStore)
		if !ok {
			t.Fatal("store does not keep models")
		}
		if err := ms.PutModel(ctx, "prj_m", "aaa", []byte("glTF a")); !errors.Is(err, ErrNotFound) {
			t.Fatalf("model for a missing project: %v", err)
		}
		if err := s.Create(ctx, Record{ID: "prj_m", Name: "M", Doc: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		if _, _, err := ms.OpenModel(ctx, "prj_m", "aaa"); !errors.Is(err, ErrNoModel) {
			t.Fatalf("open before put: %v", err)
		}
		for _, h := range []string{"bbb", "aaa"} {
			if err := ms.PutModel(ctx, "prj_m", h, []byte("glTF "+h)); err != nil {
				t.Fatal(err)
			}
		}
		size, body, err := ms.OpenModel(ctx, "prj_m", "aaa")
		if err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(body)
		body.Close()
		if string(got) != "glTF aaa" || size != int64(len(got)) {
			t.Fatalf("open: %q %d", got, size)
		}
		if hs, err := ms.Models(ctx, "prj_m"); err != nil || strings.Join(hs, ",") != "aaa,bbb" {
			t.Fatalf("list: %v %v", hs, err)
		}
		if err := s.Delete(ctx, "prj_m"); err != nil {
			t.Fatal(err)
		}
		if hs, _ := ms.Models(ctx, "prj_m"); len(hs) != 0 {
			t.Fatalf("models outlived their project: %v", hs)
		}
		if _, _, err := ms.OpenModel(ctx, "prj_m", "aaa"); !errors.Is(err, ErrNoModel) {
			t.Fatalf("open after delete: %v", err)
		}
	})

	t.Run("access", func(t *testing.T) {
		s := newStore(t)
		acc, ok := s.(AccessStore)
		if !ok {
			t.Fatal("store does not keep access records")
		}
		if _, err := acc.GetAccess(ctx, "prj_c"); !errors.Is(err, ErrNoAccess) {
			t.Fatalf("get before create: %v", err)
		}
		if err := s.Create(ctx, Record{ID: "prj_c", Name: "C", Doc: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		a := Access{OwnerHash: "h1"}
		if err := acc.CreateAccess(ctx, "prj_c", a); err != nil {
			t.Fatal(err)
		}
		if err := acc.CreateAccess(ctx, "prj_c", Access{OwnerHash: "thief"}); !errors.Is(err, ErrExists) {
			t.Fatalf("second create: %v", err)
		}
		if err := acc.PutAccess(ctx, "prj_c", Access{OwnerHash: "h1", EditToken: "e1"}); err != nil {
			t.Fatal(err)
		}
		got, err := acc.GetAccess(ctx, "prj_c")
		if err != nil || got.OwnerHash != "h1" || got.EditToken != "e1" {
			t.Fatalf("get: %+v %v", got, err)
		}
		if err := s.Delete(ctx, "prj_c"); err != nil {
			t.Fatal(err)
		}
		if _, err := acc.GetAccess(ctx, "prj_c"); !errors.Is(err, ErrNoAccess) {
			t.Fatalf("access outlived its project: %v", err)
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
