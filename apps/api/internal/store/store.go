// Package store persists project documents with optimistic versioning.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrNotFound = errors.New("project not found")
	ErrExists   = errors.New("project already exists")
)

// ConflictError is returned when an update's expected version is stale.
type ConflictError struct{ Current int }

func (e *ConflictError) Error() string {
	return fmt.Sprintf("version conflict: server has v%d", e.Current)
}

// Record is a stored project. Doc is the full JSON document, with its "version" field
// equal to Version.
type Record struct {
	ID        string
	Name      string
	Version   int
	Doc       []byte
	UpdatedAt time.Time
}

type Summary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Store is implemented by an in-memory store (tests), a file store (local dev) and,
// from Phase 4, Postgres.
type Store interface {
	List(ctx context.Context) ([]Summary, error)
	Get(ctx context.Context, id string) (Record, error)
	// Create stores rec at version 1. rec.Doc must already carry version 1.
	Create(ctx context.Context, rec Record) error
	// Update replaces the document if the stored version equals expected, storing it
	// as expected+1. build receives the new version and returns the document to store.
	Update(ctx context.Context, id string, expected int, name string, build func(newVersion int) ([]byte, error)) (int, error)
	Delete(ctx context.Context, id string) error
}
