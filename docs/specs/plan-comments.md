# Spec: comments on the plan

Roadmap item 1 (Planned). Project-manager, 6 Nov 2026. Slice 1: M. **No project schema
change** (stays 9): comments are their own API resource.

**Problem.** Families decide a renovation together, but the talk happens in WhatsApp, away
from the plan: "which wall?", "the fridge where?". Parents who won't learn the editor still
want a say, and nobody can tell later what was agreed.

## User stories (a Punggol 4-room BTO)
1. Wei Ling (owner) sends the view link to the family chat. Her mother opens it on her phone,
   taps the kitchen wall in After and writes "Open kitchen, the wok smell will go everywhere.
   Glass sliding door?". She types her name once, has no account and needs no edit rights.
2. Her husband Jun Hao, on his laptop with the edit link, sees "1 new" on Comments, replies
   "Glass sliding door, $1.2k in the estimate", and pins the fridge: "Blocks the service
   yard?". He moves the fridge. The pin moves with it.
3. Once they agree, Wei Ling resolves both threads. They leave the plan but stay under
   Resolved, with who resolved them and when.
4. Her father pins the master bedroom: "2.4 m wardrobe enough for both of you?". Wei Ling
   copies the open comments as text for the ID's quotation meeting.
5. Wei Ling posted the view link in a BTO Facebook group for advice. Strangers start
   commenting, so she switches comments to "Edit link only" and deletes the spam.

## Decision: storage
**A separate resource, `comments/<id>.json` in R2, one object per project with its own
version.** The server applies each operation (add, reply, resolve, delete) as a
read-modify-write with a conditional PUT, so clients never send `If-Match` or see a conflict.

| | In the document (schema 10) | Separate resource (chosen) |
|---|---|---|
| Viewers comment | No: a view link can't PUT the document | Yes |
| Clashes | Every comment is a save that clashes with the owner's 2 s autosave | None. Operations merge on the server |
| Undo | Ctrl+Z would undo a resolve; restoring a version would wipe comments | Not in undo or history |
| Size | Uses the 512 KB document cap | Its own cap |
| Export, copy | Comes with the project file and "Make my own copy" | Doesn't (wanted: a copy starts a fresh discussion) |
| Anchors | Checked with the document | Ids the server can't check; the client resolves them |
| Cost | Nothing new | One more R2 object, GETs for polling, delete and recovery handling |

Unlike projects, the server knows this format (it enforces authorship and limits). It is
small and fixed, so that doesn't break "the schema lives in core". The zod mirror in core is
checked against a shared fixture.

## Who can do what
"Comment rights" depend on the owner's setting `comments`: `all` (the default), `edit` or
`off`.

| | Owner | Edit link | View link | Open (pre-sharing) |
|---|---|---|---|---|
| See pins and threads | yes | yes | yes | yes |
| Add, reply | yes, always | `all`, `edit` | `all` | `all`, `edit` |
| Resolve, reopen | yes | if they may add | if they may add | if they may add |
| Delete a reply | any | own | own | own |
| Delete a thread | any | own, when no one else replied | same | same |
| Delete all resolved, change the setting | yes | no | no | no |

- **Names:** a typed name, 1–40 characters, kept in localStorage (`dhd-comment-name`), asked
  for at the first post and changed under "Commenting as Mum · Change". The server stamps
  each message with the poster's `role` at the time, so a badge ("Owner", "Edit link") can't
  be faked by typing a name. Accounts later (owner issue #21) replace the typed name.
- **Authorship:** each browser keeps a random author key (`dhd-comment-author`, 24 bytes)
  and sends it as `X-Comment-Author`. The server stores
  `sha256(projectId + "|" + key)` and returns only `mine: true|false`. Clearing site data
  loses the right to delete your own comments (the owner still can).

## Data shapes
```jsonc
// GET /projects/{id}/comments  (ETag: "7")
{
  "version": 7,
  "comments": "all",               // the owner's setting
  "canComment": true,              // for this caller
  "canModerate": false,            // owner only
  "threads": [{
    "id": "t_8f2k1q",              // client-made, ^[a-z0-9_-]{1,40}$
    "anchor": {
      "levelId": "l1",             // the base level id (no ~after)
      "variant": "after",          // "before" | "after"
      "at": {"x": 3.21, "y": 4.05},// where it was placed, metres; the fallback position
      "target": {"kind": "wall", "id": "w12", "t": 0.42, "off": 0.05},
      "label": "Wall · Kitchen / Living"   // ≤ 80 chars, made when placed
    },
    "resolved": {"name": "Wei Ling", "at": "2026-11-06T10:02:11Z"},  // or null
    "messages": [{
      "id": "m_3j9d0a", "name": "Mum", "role": "viewer",
      "text": "Open kitchen, the wok smell…", "at": "2026-11-06T09:41:03Z", "mine": false
    }]
  }]
}
```
- `target` kinds: `item {id, rel: {x, y}}` (offset in the item's own frame), `opening {id}`,
  `point {id}` (electrical), `wall {id, t, off}`, `room {id}`. No target means a plain spot.
- Stored: the same without `canComment`, `canModerate` or `mine`, plus `authorHash` per
  message. `comments` is kept in the access record (`commentsFrom`; missing means `all`).
- `at` and `resolved.at` are the server's clock. Threads are kept in creation order.

## API (Go, standard library)
| Method | Path | Body | Who | Result |
|---|---|---|---|---|
| GET | /projects/{id}/comments | | anyone with the link | 200 as above; `{version: 0, threads: []}` when there are none; 304 on a matching `If-None-Match` |
| POST | /projects/{id}/comments | `{id, anchor, name, text, messageId}` | comment rights | 201 full doc; an identical retry gives 200; same id, different content: 409 |
| POST | …/comments/{thread}/replies | `{id, name, text}` | comment rights | 201 full doc |
| PATCH | …/comments/{thread} | `{resolved: bool, name}` | comment rights | 200 full doc (idempotent) |
| DELETE | …/comments/{thread} | | owner, or its author when every message is theirs | 200 full doc |
| DELETE | …/comments/{thread}/replies/{msg} | | owner or author | 200 full doc |
| DELETE | /projects/{id}/comments?resolved=true | | owner | 200 full doc |
| GET/PUT | /projects/{id}/share | adds `"comments": "all"\|"edit"\|"off"` | owner | as now |

- Every write returns the whole doc (typically a few KB), so the client just replaces its copy.
- Retries: on a failed precondition, up to 5 attempts with 20–100 ms jitter, then 503 "busy".
- `Cache-Control: private, no-store` and `Vary: Authorization, X-Comment-Author`.
- `store.CommentStore`: `GetComments(ctx, id) ([]byte, int, error)` and
  `PutComments(ctx, id, expected int, doc []byte) (int, error)`. Memory, File
  (`data/comments/<id>.json`) and R2 implement it, and the shared contract test covers it.
- A project DELETE copies the comments to `deleted/<id>.comments.json` (they expire with the
  other recovery copies), then deletes them. A project PUT, a restore, a copy or a claim
  leaves comments alone. A missing project gives 404 on every route.

## Limits
- Text: 1–1000 characters (runes, after trimming; CJK counts one each). Newlines are kept.
  Control characters other than `\n` are refused. Rendered as plain text, never HTML.
- Name 1–40 characters, label up to 80; anchor coordinates finite and within ±1000 m; a body
  over 16 KB gets 413.
- 50 messages per thread, and 300 messages per project, resolved ones included (cap 1 MB).
- Edge Worker: comment writes (non-GET under `/projects/*/comments`) count against
  `WRITE_LIMIT` and a new `COMMENT_LIMIT` of 10 a minute per address. There is also a daily
  cap of 100 comment writes per visitor (D1, same HMAC and fail-open rules as
  `DAILY_CREATES`). GETs are not limited.
- Error copy (the API's `error` plus a `code` the web maps to copy):

| Code | Status | Copy |
|---|---|---|
| `comments_off` | 403 | The owner has closed comments on this plan. |
| `comments_edit_only` | 403 | Only people with the edit link can comment on this plan. |
| `not_yours` | 403 | You can only delete your own comments. |
| `thread_full` | 409 | This thread has 50 replies. Start a new comment. |
| `comments_full` | 409 | This plan has 300 comments, the most it can hold. The owner can delete resolved ones. |
| (rate limit) | 429 | You're commenting very fast. Wait a minute and try again. |
| (daily cap) | 429 | That's a lot of comments for one day. Try again tomorrow. |
| (network) | | Couldn't post. Check your connection and try again. (The text is kept.) |

## Pins (core `comments.ts`, pure TS)
- `CommentsDoc` zod schema, matching the Go fixture
  `apps/api/internal/httpapi/testdata/comments.json`.
- `anchorAt(level, point, hit)`: what a tap attaches to, in this order: the topmost item,
  an electrical point, an opening, a wall, a room, else a plain spot. Labels: the item's
  name ("Fridge"), "Door · Kitchen", "Socket · Bedroom 2", "Wall · Kitchen / Living", the
  room name, or "Spot in Kitchen" / "Spot on the plan".
- `anchorPosition(project, anchor)` → `{at, state: 'on' | 'gone', reason?}`:
  - item: its position plus `rel` turned by its rotation, so the pin follows moves and turns;
  - wall: at `t` along the current wall, `off` across it (clamped to half its thickness);
  - opening: its centre;
  - point: its position;
  - room: `at` while it is still inside the room, else the room's label point;
  - target gone: `at`, with `reason` `removed`, `removed-in-renovation` (After lacks it,
    Before has it), `no-renovation`, or `no-level`.
- Copy for gone: "The fridge was removed. The pin stays where it was." / "This wall is hacked
  in the renovation." / "This room is no longer on the plan." / "The renovation was
  deleted." For `no-renovation` and `no-level` the thread is listed but Jump is disabled.
- `threadsView(doc, seenAt)`: open threads, last activity first; resolved ones, most
  recently resolved first; `unread` when a message by someone else is newer than `seenAt`.

## Behaviour (web, `apps/web/src/comments/`)
**Comment tool** (palette, key K, icon a speech bubble). It is the one tool viewers get: the
view banner adds "You can look around and leave comments." It is hidden when the caller has
no comment rights.
- Desktop: hovering highlights what a click would attach to, with a chip "On: Fridge". A
  click drops the pin and opens the compose popover next to it.
- Phone: a tap drops a ghost pin, using the magnifier as Electrical does. A bottom sheet
  opens; the plan pans so the pin sits in the top third, and the sheet stays above the
  keyboard (`visualViewport`). There is **no long-press**: iOS's callout and the
  press-and-drag gestures conflict with it, and nobody finds it.
- Compose: title "New comment · Fridge". "Your name" (only until saved; placeholder "e.g.
  Mum, Wei Ling"; hint "Everyone with the link sees this name."). The "Comment" field
  (placeholder "What do you think?", 16 px font). Buttons "Post" and "Cancel"; Ctrl/Cmd+Enter
  posts. A counter "950 / 1000" appears past 900. The pin shows "Posting…" until the server
  answers.
- In Select, an element's details have **Comment on this**, which opens the same compose.
- Esc or Cancel throws the draft away; if any text was typed, it asks "Discard this comment?"
  first.

**Pins on the plan** (2D only in slice 1; `data-export="skip"`, so not in the PNG):
- A 28 px speech-bubble marker with its tip on the anchor, the poster's initial in it and a
  reply count once there are replies. It stays the same size at any zoom. On touch screens
  the hit area is 44 px.
- Colour: a new `--comment` token, unlike clearance red and renovation teal. Unread pins get
  a dot; gone pins a dashed outline; resolved pins (only with "Show resolved on the plan")
  are grey at 60%.
- Pins draw above every layer, and a tap on a pin opens its thread in every tool except
  while a wall or room chain is being drawn. Pins within 20 px of each other show as one
  marker with a count; tapping it lists them.
- Only the current variant's and level's pins show. The plan details get a "Comments"
  switch (`dhd-comment-pins`, on by default).
- Slice 1 has no dragging of pins.

**Thread** (a popover on desktop, a bottom sheet on phones):
- Header: the label, a "Before"/"After" chip (only when there is a renovation), and the gone
  note if any.
- Each message: name, a badge ("Owner", "Edit link"), the time ("just now", "5 min ago",
  "yesterday", "3 Nov"), and the text.
- Below: a "Reply" field, then **Resolve** (or **Reopen**, with "Resolved by Wei Ling · 2 h
  ago") and a menu with "Copy link" (`?p=<id>&c=<thread>`, view-only) and "Delete" where
  allowed. Delete confirms inline: "Delete this comment? [Delete] [Keep]".
- Resolving closes the popover and hides the pin. The toast says "Resolved. [Reopen]".
- Comments are not plan edits: Ctrl+Z never touches them.

**Comments panel:** the top bar gets **Comments**, with a badge counting open threads (an
icon only on phones). aria-label: "Comments, 3 open, 1 new".
- Desktop: a right-hand panel over the inspector. Phone: a bottom sheet at half height that
  can be dragged to full.
- Segmented "Open 3" / "Resolved 1". Each card shows the label, the variant chip, the first
  message's name, text (2 lines) and time, the reply count and an unread dot.
- A tap on a card **jumps**: it switches level and variant, switches to the plan if it was
  in 3D (or keeps the split's plan), centres the pin at a zoom where the room fits, and opens
  the thread.
- Footer: "Commenting as Mum · Change"; "Copy open comments" (plain text, one block per
  thread: label, variant, then "Name: text" lines, for WhatsApp or the ID); owner only,
  "Delete resolved comments" (confirm: "Delete 4 resolved comments? This can't be undone.").
- Empty: "No comments yet. Choose Comment, then tap the plan to ask the family about a
  spot, a wall or a piece of furniture."
- Opening the panel marks everything seen (`dhd-comments-seen:<id>`, a timestamp). Opening
  one thread marks that thread seen.

**Share menu (owner):** "Who can comment", a segmented control: "Anyone with a link" / "Edit
link only" / "No one". Note: "Everyone with a link can still read comments." Without comment
rights the panel says the matching 403 copy and has no compose.

**Freshness:** no notifications in slice 1. The client polls `GET …/comments` with
`If-None-Match`:
- every 30 s while the panel or a thread is open, every 2 min otherwise;
- only while the tab is visible, plus once at once on `focus` and `visibilitychange`;
- backing off to 5 min after errors.

A new comment from someone else raises the badge, and the live region says "New comment from
Mum on Fridge". A deep link `?c=<thread>` opens that thread once the comments load. If the
thread is gone: "That comment was deleted."

**Local plans** (no API, or kept in the browser by the daily cap): Comments is disabled, with
the title "Comments need the plan saved on the server."

**Telemetry:** a `comment` event (posted, once a visit), added to `EVENT_NAMES`.

## Edge cases
- Two people post at the same moment: both kept (the server retries). One resolves while
  another replies: both apply. A reply to a thread just deleted: 404, "That comment was
  deleted."
- The anchor's element is deleted, or hacked in After: covered above. When the element comes
  back (undo), the pin reattaches, because the id is the same.
- The owner deletes the renovation: After threads stay, listed with "The renovation was
  deleted.", and can still be resolved or deleted.
- A plan restored from version history: comments unchanged; anchors resolve against the
  restored plan.
- "Make my own copy" and Duplicate project don't copy comments. A downloaded project file
  holds none.
- The owner key is per browser: the owner on another device (no sign-in) is a viewer there,
  so they can't moderate. Say so in the Share menu note, as for editing.
- A name with emoji or Chinese characters works. A name changed later applies only to new
  messages.
- A pin outside the drawn flat (on the ledge) is allowed. Coordinates outside ±1000 m are
  refused.
- When the edit link is reset or comments are turned off, existing comments stay. An editor
  whose key was reset becomes a viewer, and gets comment rights only if `all`.
- A viewer whose name is empty and storage disabled: the name is kept for the visit.

## Out of scope (slice 1)
Pins in 3D and the walk; comments on the contractor sheet or print; editing a posted
message; @mentions, reactions, photos and attachments; email, push or digest notifications;
real-time updates; spam filtering beyond limits and the owner's setting; dragging a pin to
another anchor; comments in the project file; accounts (#21).

## Slice 2 (S–M)
- Pins in 3D and the walk as billboards, plus "Comment here" while walking (at the walker,
  facing the view).
- Contractor dialog: an "Open comments" check (off by default) numbers the pins on the plan
  page and adds a "Comments" page (number, place, messages).
- Edit your own message within 15 minutes; https links made clickable
  (`rel="noopener noreferrer nofollow"`).
- Re-anchor a pin by dragging it; comments optionally in the project file download.

## Later (after sign-in, #21)
Account names and avatars; an email digest ("3 new comments on Tampines flat"); Web Push;
"Decided" threads that appear in the change list; a quick vote between layouts ("L or U
kitchen?") tied to AI layouts or variants; family comments fed into the AI layout brief.

## Questions for the tech lead
1. Server-side operations with retry (proposed) or the client PUTting the whole doc with
   `If-Match`.
2. One object per project (proposed) or one per thread (listing costs class A operations).
3. Polling wakes the container (`sleepAfter` 15 m), so any visible tab keeps it running.
   Should the Worker answer `GET …/comments` straight from an R2 binding, or cache it
   briefly?
4. The daily cap: a new `comment_quota` table (migration 0003) or `create_quota` with a
   `kind` column.
5. An author key per browser hashed with the project id (proposed) or one per project.
6. Deploy order: the API ships first. The web hides Comments when the route 404s with no
   JSON `error` (an old API).

## Acceptance criteria
Go API (`go test -race ./...`):
1. A GET with no comments gives 200 `{version: 0, threads: []}`, `ETag: "0"`. A missing
   project gives 404; a bad id gives 400.
2. A view-link POST makes a thread: 201, message `role: "viewer"`, server `at`, `mine: true`
   for that author key and false for another. No response body ever contains `authorHash`.
3. Refused with 400: an empty or whitespace text, 1001 runes (1000 CJK runes pass), a
   41-character name, a control character, `variant: "x"`, NaN or a coordinate over 1000, an
   unknown target kind. A 17 KB body gives 413.
4. Replies append in order. A reply to an unknown thread gives 404. The 51st message in a
   thread gives 409 `thread_full`; the 301st in a project gives 409 `comments_full`.
5. A viewer's resolve sets `{name, at}`; reopen sets null; resolving twice changes nothing.
6. Deleting a reply: the author 200, another viewer 403 `not_yours`, an editor who isn't the
   author 403, the owner 200. Deleting a thread with someone else's reply: its author 403,
   the owner 200.
7. `DELETE …/comments?resolved=true`: owner only (others 403); only resolved threads go.
8. Share `comments: "edit"`: a viewer's POST gives 403 `comments_edit_only`, an editor's
   201. `"off"`: an editor gets 403 `comments_off`, the owner 201. Every role can still GET.
   GET share returns the field; an old access record reads as `all`.
9. 20 concurrent POSTs (memory store, and the R2 contract test) all land, version 20. A store
   that always fails the precondition gives 503.
10. `If-None-Match` with the current version gives 304 with no body; a stale one gives 200.
11. A project DELETE removes the comments (R2: a copy at `deleted/<id>.comments.json`); a new
    project with that id starts empty. A project PUT and a restore leave the comments
    version unchanged; a comment write leaves the project's version and ETag unchanged.
12. An identical retry of a POST gives 200 with one thread; the same id with other content
    gives 409.
13. The `CommentStore` contract passes on memory, file and (live) R2.

Edge (Vitest):
14. The 11th comment write in a minute from one address gives 429 with the copy above;
    GETs are never limited.
15. The 101st comment write in a day gives 429; with no table it fails open and logs
    `quotaUnavailable`.

Core (Vitest):
16. `CommentsDoc` parses `testdata/comments.json`.
17. `anchorAt` on the sample: a tap on the fridge gives `item` "Fridge"; on the kitchen wall,
    `wall` with `t` within 0.01; in an empty part of a room, `room`; outside, a spot.
18. `anchorPosition`: the fridge moved 1 m and turned 90°, and the pin follows within 1 mm; a
    wall lengthened keeps `t`; the item deleted gives `gone`/`removed` at `at`; a room
    reshaped so `at` falls outside moves the pin to the label point.
19. In After, a pin on a wall hacked there gives `removed-in-renovation`; in Before it stays
    `on`. With the renovation deleted, an After pin gives `no-renovation`.
20. `threadsView` orders and flags unread as specified; your own messages are never unread.

Web unit (Vitest):
21. Polling: 30 s with the panel open, 2 min with it closed, none while hidden, at once on
    focus, 5 min after errors; a 304 keeps state.
22. The name is saved and reused; relative times give "just now", "5 min ago", "yesterday",
    "3 Nov".

E2e (desktop; 390 px phone by finger, mid-gesture screenshots):
23. The owner opens the sample. A second context opens the view link: Comment is the only
    tool. It taps the fridge, names itself "Mum", posts, and the pin shows on the fridge.
    The owner's tab, after a focus, shows the badge "1", the unread dot and the pin.
24. The owner moves the fridge, and the pin follows. After a delete, the pin turns dashed
    with "The fridge was removed…". Undo reattaches it. Ctrl+Z after posting leaves the
    comment.
25. The owner's reply shows the "Owner" badge. The viewer resolves: the pin leaves the plan,
    and the thread sits under "Resolved 1" with "Resolved by Mum". "Show resolved on the
    plan" shows it grey. Reopen works.
26. From 3D, a card in the panel switches to the plan and After, centres the pin and opens
    the thread.
27. `?p=<id>&c=<thread>` opens that thread; a deleted one says "That comment was deleted."
28. The viewer has no Delete on the owner's reply, and can delete their own.
29. "No one" in the Share menu: the viewer sees "The owner has closed comments on this
    plan." and no Comment tool; existing pins still show.
30. Phone: tool, magnifier and sheet by finger. The keyboard never hides Post. The panel
    opens as a bottom sheet. Pins keep 28 px through a pinch zoom. The page never scrolls
    sideways.
31. The plan PNG has no pins. Local mode shows Comments disabled with its title.
32. After deploying, production accepts a comment POST and a GET with `If-None-Match` gives
    304 (manual check, recorded in the PR).
