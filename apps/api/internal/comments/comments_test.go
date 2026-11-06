package comments

import (
	"encoding/json"
	"flag"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/comments.json")

func f(v float64) *float64 { return &v }

func validThread() AddThread {
	return AddThread{
		ID: "t_8f2k1q", MessageID: "m_3j9d0a", Name: "Mum", Text: "Glass sliding door?",
		Anchor: Anchor{
			LevelID: "lvl_ground", Variant: "after", At: Point{3.21, 4.05}, Label: "Wall · Kitchen / Living",
			Target: &Target{Kind: "wall", ID: "w_12", T: f(0.42), Off: f(0.05)},
		},
	}
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name string
		edit func(o *AddThread)
		ok   bool
	}{
		{"valid", func(*AddThread) {}, true},
		{"empty text", func(o *AddThread) { o.Text = "" }, false},
		{"whitespace text", func(o *AddThread) { o.Text = " \n\t " }, false},
		{"1000 runes", func(o *AddThread) { o.Text = strings.Repeat("a", 1000) }, true},
		{"1001 runes", func(o *AddThread) { o.Text = strings.Repeat("a", 1001) }, false},
		{"1000 CJK runes", func(o *AddThread) { o.Text = strings.Repeat("厨", 1000) }, true},
		{"newlines kept", func(o *AddThread) { o.Text = "one\r\ntwo" }, true},
		{"control character", func(o *AddThread) { o.Text = "bell\a" }, false},
		{"tab", func(o *AddThread) { o.Text = "a\tb" }, false},
		{"bidi override in name", func(o *AddThread) { o.Name = "‮Wei Ling" }, false},
		{"emoji with ZWJ", func(o *AddThread) { o.Name = "Mum 👩‍👧" }, true},
		{"Chinese name", func(o *AddThread) { o.Name = "妈妈" }, true},
		{"40-rune name", func(o *AddThread) { o.Name = strings.Repeat("n", 40) }, true},
		{"41-rune name", func(o *AddThread) { o.Name = strings.Repeat("n", 41) }, false},
		{"empty name", func(o *AddThread) { o.Name = "  " }, false},
		{"name on two lines", func(o *AddThread) { o.Name = "a\nb" }, false},
		{"invalid UTF-8", func(o *AddThread) { o.Text = "\xff" }, false},
		{"81-rune label (cut, not refused)", func(o *AddThread) { o.Anchor.Label = strings.Repeat("l", 81) }, true},
		{"label with a hidden mark", func(o *AddThread) { o.Anchor.Label = "Kitchen‏" }, true},
		{"line separator in name", func(o *AddThread) { o.Name = "Mum Dad" }, false},
		{"Scotland's flag", func(o *AddThread) {
			o.Name = "Ewan \U0001F3F4\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F"
		}, true},
		{"tag characters on their own", func(o *AddThread) { o.Name = "Ewan \U000E0067\U000E0062" }, false},
		{"tags after a closed flag", func(o *AddThread) { o.Name = "\U0001F3F4\U000E0067\U000E007F\U000E0067" }, false},
		{"bad variant", func(o *AddThread) { o.Anchor.Variant = "x" }, false},
		{"NaN", func(o *AddThread) { o.Anchor.At.X = math.NaN() }, false},
		{"infinity", func(o *AddThread) { o.Anchor.At.Y = math.Inf(1) }, false},
		{"coordinate over 1000", func(o *AddThread) { o.Anchor.At.X = 1000.5 }, false},
		{"coordinate -1000", func(o *AddThread) { o.Anchor.At.X = -1000 }, true},
		{"unknown target kind", func(o *AddThread) { o.Anchor.Target.Kind = "door" }, false},
		{"wall t over 1", func(o *AddThread) { o.Anchor.Target.T = f(1.2) }, false},
		{"wall without off", func(o *AddThread) { o.Anchor.Target.Off = nil }, false},
		{"item without rel", func(o *AddThread) { o.Anchor.Target = &Target{Kind: "item", ID: "it_1"} }, false},
		{"item", func(o *AddThread) { o.Anchor.Target = &Target{Kind: "item", ID: "it_1", Rel: &Point{0.1, -0.2}} }, true},
		{"room with t", func(o *AddThread) { o.Anchor.Target = &Target{Kind: "room", ID: "rm_1", T: f(0)} }, false},
		{"plain spot", func(o *AddThread) { o.Anchor.Target = nil }, true},
		{"after level id", func(o *AddThread) { o.Anchor.LevelID = "lvl_ground~after" }, true},
		{"upper-case element id", func(o *AddThread) { o.Anchor.Target.ID = "W12" }, false},
		{"bad thread id", func(o *AddThread) { o.ID = "T 1" }, false},
		{"bad message id", func(o *AddThread) { o.MessageID = "" }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := validThread()
			c.edit(&o)
			err := o.Validate()
			if c.ok != (err == nil) {
				t.Fatalf("Validate: %v", err)
			}
			if err != nil {
				if e, ok := AsError(err); !ok || e.Status != 400 {
					t.Fatalf("want a 400 Error, got %#v", err)
				}
			}
		})
	}
	o := validThread()
	o.Text = "  one\r\ntwo  "
	if err := o.Validate(); err != nil || o.Text != "one\ntwo" {
		t.Fatalf("normalised text %q %v", o.Text, err)
	}
}

func TestLabelsAreTidiedNotRefused(t *testing.T) {
	for in, want := range map[string]string{
		strings.Repeat("厨", 90): strings.Repeat("厨", MaxLabel),
		"Kitchen‏":              "Kitchen",
		" ​ ":                   "Spot on the plan",
		"Mum 👩‍👧 room":          "Mum 👩‍👧 room",
	} {
		o := validThread()
		o.Anchor.Label = in
		if err := o.Validate(); err != nil || o.Anchor.Label != want {
			t.Errorf("label %q: got %q, %v", in, o.Anchor.Label, err)
		}
	}
}

func TestEncodeKeepsHTMLCharacters(t *testing.T) {
	d, _ := Decode(nil)
	th := validThread()
	th.Text = "<b> & </b>"
	_, _ = th.Apply(&d, mum, t0)
	b, _ := Encode(d)
	if !strings.Contains(string(b), `"<b> & </b>"`) {
		t.Fatalf("escaped: %s", b)
	}
}

func TestDecodeBodyIsStrict(t *testing.T) {
	var o AddReply
	if err := DecodeBody(strings.NewReader(`{"id":"m_1","name":"A","text":"x","extra":1}`), &o); err == nil {
		t.Fatal("unknown field accepted")
	}
	if err := DecodeBody(strings.NewReader(`{"id":"m_1"} {}`), &o); err == nil {
		t.Fatal("trailing data accepted")
	}
	big := `{"id":"m_1","name":"A","text":"` + strings.Repeat("x", 17<<10) + `"}`
	err := DecodeBody(strings.NewReader(big), &o)
	if e, ok := AsError(err); !ok || e.Status != 413 {
		t.Fatalf("17 KB body: %v", err)
	}
}

var (
	t0    = time.Date(2026, 11, 6, 9, 41, 3, 0, time.UTC)
	mum   = Actor{Role: RoleViewer, AuthHash: "hash-mum"}
	jun   = Actor{Role: RoleEditor, AuthHash: "hash-jun"}
	owner = Actor{Role: RoleOwner, AuthHash: "hash-owner"}
	dad   = Actor{Role: RoleViewer, AuthHash: "hash-dad"}
)

func apply(t *testing.T, d *Doc, op Op, a Actor) (bool, error) {
	t.Helper()
	return op.Apply(d, a, t0)
}

func code(err error) string {
	if e, ok := AsError(err); ok {
		return e.Code
	}
	return ""
}

func TestOperations(t *testing.T) {
	d, _ := Decode(nil)
	th := validThread()
	if ch, err := apply(t, &d, th, mum); !ch || err != nil {
		t.Fatalf("add: %v %v", ch, err)
	}
	m := d.Threads[0].Messages[0]
	if m.Role != RoleViewer || !m.At.Equal(t0) || m.AuthHash != "hash-mum" {
		t.Fatalf("message: %+v", m)
	}
	// An identical retry changes nothing; the same id with other content is refused.
	if ch, err := apply(t, &d, th, mum); ch || err != nil {
		t.Fatalf("retry: %v %v", ch, err)
	}
	other := th
	other.Text = "Something else"
	if _, err := apply(t, &d, other, mum); code(err) != "id_taken" {
		t.Fatalf("same id, other text: %v", err)
	}
	if _, err := apply(t, &d, th, dad); code(err) != "id_taken" {
		t.Fatalf("same post by someone else: %v", err)
	}

	// Replies append in order.
	for i, a := range []Actor{jun, owner} {
		r := AddReply{Thread: th.ID, ID: "m_r" + string(rune('0'+i)), Name: "N", Text: "reply"}
		if ch, err := apply(t, &d, r, a); !ch || err != nil {
			t.Fatal(err)
		}
	}
	if got := d.Threads[0].Messages; len(got) != 3 || got[1].Role != RoleEditor || got[2].Role != RoleOwner {
		t.Fatalf("replies: %+v", got)
	}
	if _, err := apply(t, &d, AddReply{Thread: "t_nope", ID: "m_x", Name: "N", Text: "x"}, mum); code(err) != "gone" {
		t.Fatalf("reply to unknown thread: %v", err)
	}

	// Resolve, twice, then reopen.
	yes, no := true, false
	if ch, err := apply(t, &d, Resolve{Thread: th.ID, Resolved: &yes, Name: "Mum"}, mum); !ch || err != nil {
		t.Fatal(err)
	}
	if r := d.Threads[0].Resolved; r == nil || r.Name != "Mum" || !r.At.Equal(t0) {
		t.Fatalf("resolved: %+v", r)
	}
	if ch, err := apply(t, &d, Resolve{Thread: th.ID, Resolved: &yes, Name: "Dad"}, dad); ch || err != nil || d.Threads[0].Resolved.Name != "Mum" {
		t.Fatalf("resolve twice: %v %v", ch, err)
	}
	if ch, err := apply(t, &d, Resolve{Thread: th.ID, Resolved: &no}, dad); !ch || err != nil || d.Threads[0].Resolved != nil {
		t.Fatalf("reopen: %v %v", ch, err)
	}

	// Deleting replies: the author and the owner may; another viewer, or an editor who
	// isn't the author, may not.
	if _, err := apply(t, &d, DeleteReply{th.ID, "m_r0"}, dad); code(err) != "not_yours" {
		t.Fatalf("viewer deletes an editor's reply: %v", err)
	}
	if _, err := apply(t, &d, DeleteReply{th.ID, "m_r1"}, jun); code(err) != "not_yours" {
		t.Fatalf("editor deletes the owner's reply: %v", err)
	}
	if ch, err := apply(t, &d, DeleteReply{th.ID, "m_r0"}, jun); !ch || err != nil {
		t.Fatalf("author deletes: %v", err)
	}
	// A thread with someone else's reply: its author can't delete it, the owner can.
	if _, err := apply(t, &d, DeleteThread{th.ID}, mum); code(err) != "not_yours" {
		t.Fatalf("author deletes a thread with replies: %v", err)
	}
	if _, err := apply(t, &d, DeleteReply{th.ID, th.MessageID}, owner); code(err) != "invalid" {
		t.Fatalf("delete the first message as a reply: %v", err)
	}
	if ch, err := apply(t, &d, DeleteReply{th.ID, "m_r1"}, owner); !ch || err != nil {
		t.Fatal(err)
	}
	if ch, err := apply(t, &d, DeleteThread{th.ID}, mum); !ch || err != nil || len(d.Threads) != 0 {
		t.Fatalf("author deletes their own thread: %v", err)
	}
	if _, err := apply(t, &d, DeleteThread{th.ID}, owner); code(err) != "gone" {
		t.Fatalf("delete twice: %v", err)
	}
}

func TestSettingsAndModeration(t *testing.T) {
	d, _ := Decode(nil)
	open := Actor{Role: RoleOpen, AuthHash: "hash-open"}
	add := func(id string) AddThread { o := validThread(); o.ID = id; o.MessageID = "m_" + id; return o }

	for _, s := range []struct {
		setting string
		actor   Actor
		code    string
	}{
		{SettingAll, mum, ""}, {SettingAll, open, ""},
		{SettingEdit, mum, "comments_edit_only"}, {SettingEdit, jun, ""}, {SettingEdit, open, ""},
		{SettingOff, jun, "comments_off"}, {SettingOff, open, "comments_off"}, {SettingOff, owner, ""},
	} {
		d.Setting = s.setting
		_, err := apply(t, &d, add("t_"+s.setting+"_"+s.actor.Role), s.actor)
		if code(err) != s.code {
			t.Errorf("%s as %s: got %v, want %q", s.setting, s.actor.Role, err, s.code)
		}
	}
	if _, err := apply(t, &d, SetSetting{SettingAll}, jun); code(err) != "owner_only" {
		t.Fatalf("editor changes the setting: %v", err)
	}
	if _, err := apply(t, &d, SetSetting{SettingAll}, open); code(err) != "owner_only" {
		t.Fatalf("an open project can't be moderated: %v", err)
	}
	if ch, err := apply(t, &d, SetSetting{SettingAll}, owner); !ch || err != nil || d.Setting != SettingAll {
		t.Fatal(err)
	}
	if ch, _ := apply(t, &d, SetSetting{SettingAll}, owner); ch {
		t.Fatal("the same setting changed the doc")
	}

	// Deleting resolved threads: owner only, and only the resolved ones go.
	yes := true
	n := len(d.Threads)
	_, _ = apply(t, &d, Resolve{Thread: d.Threads[0].ID, Resolved: &yes, Name: "Wei Ling"}, owner)
	if _, err := apply(t, &d, DeleteResolved{}, jun); code(err) != "owner_only" {
		t.Fatalf("editor deletes resolved: %v", err)
	}
	if ch, err := apply(t, &d, DeleteResolved{}, owner); !ch || err != nil || len(d.Threads) != n-1 {
		t.Fatalf("delete resolved: %v, %d threads", err, len(d.Threads))
	}
	for _, th := range d.Threads {
		if th.Resolved != nil {
			t.Fatal("a resolved thread was kept")
		}
	}
}

func TestLimits(t *testing.T) {
	d, _ := Decode(nil)
	th := validThread()
	_, _ = apply(t, &d, th, mum)
	for i := 1; i < MaxThreadMessages; i++ {
		if _, err := apply(t, &d, AddReply{Thread: th.ID, ID: "m_" + itoa(i), Name: "N", Text: "x"}, mum); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := apply(t, &d, AddReply{Thread: th.ID, ID: "m_full", Name: "N", Text: "x"}, mum); code(err) != "thread_full" {
		t.Fatalf("51st message in a thread: %v", err)
	}
	for i := 1; d.messageCount() < MaxMessages; i++ {
		o := validThread()
		o.ID, o.MessageID = "t_"+itoa(i), "m_t"+itoa(i)
		if _, err := apply(t, &d, o, mum); err != nil {
			t.Fatal(err)
		}
	}
	o := validThread()
	o.ID = "t_last"
	if _, err := apply(t, &d, o, mum); code(err) != "comments_full" {
		t.Fatalf("301st message in a project: %v", err)
	}
	// 300 messages of 1000 four-byte runes (CJK extension B) are over 1 MB: Encode refuses.
	for i := range d.Threads {
		for j := range d.Threads[i].Messages {
			d.Threads[i].Messages[j].Text = strings.Repeat("𠀀", MaxText)
		}
	}
	if _, err := Encode(d); code(err) != "comments_too_big" {
		t.Fatalf("over 1 MB: %v", err)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}

func TestViewHidesAuthorHashes(t *testing.T) {
	d, _ := Decode(nil)
	_, _ = apply(t, &d, validThread(), mum)
	b, _ := json.Marshal(ViewFor(d, "hash-mum"))
	if strings.Contains(string(b), "authHash") || strings.Contains(string(b), "hash-mum") {
		t.Fatalf("view leaks the author hash: %s", b)
	}
	if !ViewFor(d, "hash-mum").Threads[0].Messages[0].Mine || ViewFor(d, "hash-dad").Threads[0].Messages[0].Mine {
		t.Fatal("mine")
	}
	if ViewFor(d, "").Threads[0].Messages[0].Mine {
		t.Fatal("no author key is never mine")
	}
}

// testdata/comments.json is the view a client gets, shared with the zod schema in
// packages/core (its test parses this file). Regenerate with go test -run Fixture -update.
func TestFixture(t *testing.T) {
	d := Doc{Version: 7, Epoch: "5e1f0a2b3c4d", Setting: SettingAll, Threads: []Thread{}}
	yes := true
	ops := []struct {
		op Op
		a  Actor
	}{
		{validThread(), mum},
		{AddReply{Thread: "t_8f2k1q", ID: "m_4k1p2z", Name: "Jun Hao", Text: "Glass sliding door,\n$1.2k in the estimate"}, jun},
		{AddThread{ID: "t_fridge", MessageID: "m_fr1", Name: "Jun Hao", Text: "Blocks the service yard?", Anchor: Anchor{
			LevelID: "lvl_ground", Variant: "after", At: Point{6.2, 1.1}, Label: "Fridge",
			Target: &Target{Kind: "item", ID: "it_fridge", Rel: &Point{0.1, -0.05}},
		}}, jun},
		{AddThread{ID: "t_room", MessageID: "m_rm1", Name: "Dad", Text: "2.4 m wardrobe enough for both of you?", Anchor: Anchor{
			LevelID: "lvl_ground", Variant: "before", At: Point{2, 8}, Label: "Master bedroom",
			Target: &Target{Kind: "room", ID: "rm_master"},
		}}, dad},
		{AddThread{ID: "t_spot", MessageID: "m_sp1", Name: "Wei Ling", Text: "妈妈, what about here? 👩‍👧", Anchor: Anchor{
			LevelID: "lvl_ground", Variant: "before", At: Point{-0.4, 3}, Label: "Spot on the plan",
		}}, owner},
		{Resolve{Thread: "t_fridge", Resolved: &yes, Name: "Wei Ling"}, owner},
	}
	for _, o := range ops {
		if _, err := o.op.Apply(&d, o.a, t0); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := json.MarshalIndent(ViewFor(d, "hash-jun"), "", "  ")
	got = append(got, '\n')
	if *update {
		if err := os.WriteFile("testdata/comments.json", got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile("testdata/comments.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("testdata/comments.json is stale; run go test ./internal/comments -run Fixture -update\n%s", got)
	}
}
