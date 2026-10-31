package store

import (
	"context"
	"time"
)

// Version is a saved version of a project that a later save replaced.
type Version struct {
	Version int `json:"version"`
	// ReplacedAt is when the next save replaced it: the end of the time it was current.
	ReplacedAt time.Time `json:"replacedAt"`
}

// HistoryStore keeps the versions saves replaced, for a while (R2 expires them after 30
// days), so a project can be put back as it was.
type HistoryStore interface {
	// Versions lists the kept versions, oldest first.
	Versions(ctx context.Context, id string) ([]Version, error)
	// GetVersion returns a kept version's document, or ErrNotFound.
	GetVersion(ctx context.Context, id string, version int) ([]byte, error)
}

// maxMemoryHistory caps the versions the memory store keeps per project.
const maxMemoryHistory = 200
