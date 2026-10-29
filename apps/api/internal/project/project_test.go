package project

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestParse(t *testing.T) {
	valid := `{"schemaVersion":1,"id":"prj_demo","version":0,"name":"Flat","units":"m","underlay":null,"levels":[{}]}`
	if _, err := Parse([]byte(valid)); err != nil {
		t.Fatalf("valid doc rejected: %v", err)
	}

	bad := map[string]string{
		"array":          `[]`,
		"no levels":      `{"schemaVersion":1,"id":"prj_demo","version":0,"name":"Flat"}`,
		"empty levels":   `{"schemaVersion":1,"id":"prj_demo","version":0,"name":"Flat","levels":[]}`,
		"future schema":  `{"schemaVersion":2,"id":"prj_demo","version":0,"name":"Flat","levels":[{}]}`,
		"unsafe id":      `{"schemaVersion":1,"id":"../etc","version":0,"name":"Flat","levels":[{}]}`,
		"uppercase id":   `{"schemaVersion":1,"id":"PRJ","version":0,"name":"Flat","levels":[{}]}`,
		"negative ver":   `{"schemaVersion":1,"id":"prj_demo","version":-1,"name":"Flat","levels":[{}]}`,
		"string version": `{"schemaVersion":1,"id":"prj_demo","version":"1","name":"Flat","levels":[{}]}`,
	}
	for name, raw := range bad {
		if _, err := Parse([]byte(raw)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
}

func TestWithVersionKeepsOtherFields(t *testing.T) {
	out, err := WithVersion([]byte(`{"id":"prj_a","version":3,"levels":[{"walls":{"w1":{}}}]}`), 4)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if m["version"] != float64(4) || m["id"] != "prj_a" || len(m["levels"].([]any)) != 1 {
		t.Fatalf("unexpected: %s", out)
	}
}

// testdata/hdb4room.json is the reference fixture serialised from packages/core, so the
// Go envelope check stays in step with the TypeScript schema.
func TestParseReferenceFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/hdb4room.json")
	if err != nil {
		t.Fatal(err)
	}
	env, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if env.ID != "prj_demo" || env.SchemaVersion != SchemaVersion {
		t.Fatalf("unexpected envelope %+v", env)
	}
}
