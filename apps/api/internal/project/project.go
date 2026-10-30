// Package project validates the envelope of a project document.
//
// The API never interprets geometry: the document is stored as opaque JSON and only
// the envelope fields below are checked. The zod schema in packages/core is the source
// of truth for everything else.
package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// SchemaVersion must match SCHEMA_VERSION in packages/core/src/schema.ts.
const SchemaVersion = 5

// MaxDocBytes caps a single project document. The reference plan is ~15 kB, and plan
// images are stored separately, so 512 KB leaves plenty of room.
const MaxDocBytes = 512 << 10

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// Envelope is the part of a project document the server understands.
type Envelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	Version       int    `json:"version"`
	Name          string `json:"name"`
}

var ErrInvalid = errors.New("invalid project")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// ValidID reports whether id is safe to use as a key and a file name.
func ValidID(id string) bool { return idPattern.MatchString(id) }

// Parse checks that raw is a JSON object with a valid envelope.
func Parse(raw []byte) (Envelope, error) {
	if len(raw) > MaxDocBytes {
		return Envelope{}, invalid("document exceeds %d bytes", MaxDocBytes)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return Envelope{}, invalid("not a JSON object: %v", err)
	}
	for _, k := range []string{"schemaVersion", "id", "version", "name", "levels"} {
		if _, ok := fields[k]; !ok {
			return Envelope{}, invalid("missing field %q", k)
		}
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return Envelope{}, invalid("bad envelope: %v", err)
	}
	// Older formats are accepted (clients migrate them on load); newer ones need a newer API.
	if env.SchemaVersion < 1 || env.SchemaVersion > SchemaVersion {
		return Envelope{}, invalid("schemaVersion %d not supported (want 1-%d)", env.SchemaVersion, SchemaVersion)
	}
	if !ValidID(env.ID) {
		return Envelope{}, invalid("id %q must match %s", env.ID, idPattern)
	}
	if env.Name == "" || len(env.Name) > 200 {
		return Envelope{}, invalid("name must be 1-200 characters")
	}
	if env.Version < 0 {
		return Envelope{}, invalid("version must be non-negative")
	}
	var levels []json.RawMessage
	if err := json.Unmarshal(fields["levels"], &levels); err != nil || len(levels) == 0 {
		return Envelope{}, invalid("levels must be a non-empty array")
	}
	return env, nil
}

// WithVersion returns raw with its top-level "version" field set to v, so the stored
// document always agrees with the version the server assigned.
func WithVersion(raw []byte, v int) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	fields["version"] = json.RawMessage(fmt.Sprint(v))
	return json.Marshal(fields)
}
