# Handover: Dream Home Designer

Updated 2026-10-30 at the end of the second build session (Phase 0 verified, Phase 1
built). Read this once, then use `CLAUDE.md` for day-to-day conventions.

- **Repo:** https://github.com/zeecm/dream-home-designer (private). Only the owner merges to
  `main`; work happens on a branch with a pull request.
- **Product and technical plan (source of truth for scope and phases):**
  https://claude.ai/artifact/Wu33FsPzhspwQJBwgxeaP5
- **Owner:** zeecm. Backend engineer whose daily language is Go; also writes TypeScript.
- **Live:** production https://dream-home-designer.pages.dev (from `main`); each branch gets a
  preview, e.g. https://claude-magical-noether-1zc17.dream-home-designer.pages.dev.

---

## 1. What we're building

A free, browser-based home designer: upload a floor plan image, calibrate its scale, trace
walls over it, add doors, windows and furniture, and walk through the result in first
person (WASD + mouse). The project file is plain JSON that the user owns.

The pitch against Planner 5D, HomeByMe, Coohom and Sweet Home 3D is that it's free, quick
(plan to walkthrough in under 10 minutes) and open. v1 is single-user, single-floor and
desktop-first. Automatic floor-plan recognition, multi-floor, photoreal rendering,
real-time collaboration and shopping/cost features are explicitly out of scope for v1.
The full feature inventory is in the plan doc.

## 2. Decisions already made (do not relitigate without the owner)

| Decision | Choice | Why |
| --- | --- | --- |
| Floor plan input | User traces walls over an image underlay; auto-recognition is Phase 4+ | Reliable and quick to ship |
| Frontend | Vite + React 18 + React Three Fiber + drei + Zustand + Immer + zod | R3F keeps the scene reactive to the store |
| React version | 18, not 19 | R3F v8 / drei v9 compatibility. Upgrade together with R3F v9 later |
| Backend language | **Go** (confirmed by owner) | Owner's daily language. The API never touches geometry |
| Backend libraries | **Standard library only** (chi + pgx + sqlc + goose were the plan) | Go 1.22+ `ServeMux` covers routing; the R2 client signs SigV4 itself |
| Web hosting | **Cloudflare Pages, connected to GitHub** (owner asked for this) | `main` deploys production, every other branch a preview, with PR comments |
| API hosting | **Cloudflare Containers** behind a Worker (`apps/edge`), replacing Fly.io | Owner upgraded to Workers Paid to unblock it. Pages reaches it through a Pages Function and a service binding, so the app stays same-origin |
| Project storage | **R2**, one object per project, conditional writes for optimistic concurrency | Containers have no persistent disk |
| Accounts and version history (Phase 4) | **Cloudflare D1** (owner chose it over Postgres) | Stays on Cloudflare; replaces the Postgres-on-Neon plan |
| Licence | **MIT**, repo to be published at beta (owner approved) | Helps catalogue contributions |
| HDB BTO layout presets | **Not wanted** (owner) | |
| Document storage | The project is one JSON document; the server validates only the envelope | Keeps the schema in one place (zod in `packages/core`) |
| Wall model | Walls reference **shared vertex ids**; the wall tool splits walls where they meet or cross | Dragging a corner moves every wall at it, and rooms can be found from the wall graph |
| Rooms | **Detected** from the wall graph's faces inside each topology-changing command | Rooms can't drift from walls; names survive edits by matching faces to old rooms |
| Openings | Rectangular only; walls are solid prisms around them. **No CSG** | Simpler and faster |
| Wall corners | Mitred in `core/footprints.ts`; a hub polygon fills T and X junctions | One outline feeds both the 2D plan and the 3D extrusion |
| 2D editor | SVG, not canvas | Free hit-testing at this element count |
| Undo/redo | Immer patches per command; `coalesceKey` merges drags and multi-wall tools | No hand-written inverses |
| Units | Metres and radians everywhere. Plan (x, y) maps to world (x, 0, y), +Y up | |
| Visual style | taste-skill "framed sheet" app style (seed 69376578), IBM Plex Sans, colour on data only | Owner asked to use taste-skill; it is vendored in `.claude/skills/design-taste-frontend` |

Before/after renovation variants (the flat as it is and as planned, compared in plan and
3D) are **in v1** (owner, 30 Oct).

## 3. Repository tour

```
apps/
  web/                 Vite SPA: the plan editor
    src/App.tsx          layout (top bar, palette, stage, inspector), global shortcuts, notices
    src/store.ts         project + undo history + sync state machine (autosave, conflicts)
    src/backend.ts       Backend interface: remote (Go API) or local (localStorage fallback)
    src/editor.ts        editor-only state: tool, selection, 2D camera, view mode (never saved)
    src/plan/            SVG plan: PlanCanvas (pan/zoom/routing), layers, tools (select,
                         measure, wall, room, door/window/opening, set scale), view maths
    src/ui/              TopBar, Palette, Inspector, PlanImage panel, form fields, icons
    src/assets.ts        plan images in IndexedDB; PDF first page via pdf.js (lazy-loaded)
    src/Viewport.tsx     R3F canvas; keeps one incremental LevelMeshes per project
    public/samples/      a drawn 4-room sample plan and a real HDB 3-room Type 4 PDF (public)
    e2e/                 Playwright suite (production build + Go API in memory)
  api/                 Go module: REST API
    cmd/api/main.go      STORE=file|memory|r2, LIST_PROJECTS=off for public deployments
    internal/store/      Store interface; Memory, File, R2 (SigV4 + conditional writes) and a
                         shared contract test (runs against live R2 when R2_TEST_* is set)
    internal/httpapi/    REST handlers + tests
    Dockerfile           distroless static image (built by wrangler for the Container)
  edge/                Cloudflare Worker that runs apps/api as a Container
    src/index.ts         ApiContainer (env from secrets), /api prefix stripping, write rate limit
    wrangler.jsonc       dhd-api (production, bucket dhd-projects) and env.preview
                         (dhd-api-preview, bucket dhd-projects-preview)
functions/api/[[path]].ts  Pages Function: /api/* -> API service binding
packages/
  core/                Pure TS, no React or three.js; everything depends on it
    src/schema.ts        zod schema (SCHEMA_VERSION 1, unchanged this session)
    src/history.ts       Command, dispatch, undo, redo, coalescing
    src/commands.ts      edits: moveVertex, drawWall, splitWall, deleteWall, deleteVertex,
                         setWallLength (push/end), updateWall/Room/Opening, addOpening, ...
    src/snap.ts          snapPoint (corner > guide-crossing-wall > wall > 0/45/90 > grid)
    src/rooms.ts         detectFaces + syncRooms
    src/footprints.ts    mitred wall outlines and junction hubs
    src/plan.ts          wall frames, plan pieces cut around openings, door swings
    src/underlay.ts      plan image placement, rotation, calibration
    src/fixtures/hdb4room.ts  simple reference plan (5 rooms, 93.5 m²) used by tests
  render/              Project -> three.js
    src/levelMeshes.ts   incremental per-wall/hub/room meshes keyed by geometry hash
    src/extrude.ts       convex polygon -> prism with outward normals
.github/workflows/ci.yml          lint, typecheck, unit tests, build, e2e; Go fmt/vet/race/build
.claude/skills/design-taste-frontend  vendored taste-skill (MIT)
```

### API (current)

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | /healthz | `{"status":"ok"}` |
| GET | /projects | Summaries, newest first. **Off in production** (`LIST_PROJECTS=off`) until auth exists |
| POST | /projects | Full document. Stored as version 1. 409 if the id exists |
| GET | /projects/{id} | Document. `ETag: "<version>"`. 400 for unsafe ids, 404 if missing |
| PUT | /projects/{id} | Requires `If-Match: "<n>"` (428 without it). 409 + `{"version": current}` if stale |
| DELETE | /projects/{id} | 204 |

Writes are rate-limited per IP at the Worker (60/min). IDs must match `^[a-z0-9][a-z0-9_-]{0,63}$`.

### Client model

- **Backend:** the app probes `/api/healthz` once (20 s timeout for a cold container). With no API
  it uses localStorage with the same versions and 409s, and says so in a notice.
- **Projects:** the open project's id is in the URL (`?p=`). A first visit opens a fresh copy of the
  sample flat (never a shared one). The project menu lists projects this browser has opened,
  because the public API doesn't list.
- **Saving:** sync is loading, saved, dirty, saving, conflict or error. Every edit autosaves 2 s
  later. A conflict offers "Load the latest" or "Keep mine". Leaving with unsaved, conflicting or
  failed changes warns.
- **Plan images:** stored in IndexedDB under `underlay.assetKey`, so they show only in the browser
  that uploaded them.

## 4. State

**Phase 0** is verified. The Phase 0 gate passed in a browser, and CI is green.

**Phase 1 (plan editor)** is built:
- **Image work:** upload an image or PDF, set its opacity and rotation, then set the scale.
- **Walls and rooms:** the wall tool has snapping and typed lengths, the room tool draws
  rectangles, and walls can be edited (drag corners, double-click to split, delete, set length or
  thickness). Rooms are detected automatically.
- **Openings:** a door, window or opening tool places them, and the inspector edits them.
- **Plan and 3D:** walls have mitred corners in both views, and the 3D rebuild is incremental.

**Tests:**
- 126 core and 12 render unit tests, plus 22 web unit tests.
- An 11-test end-to-end suite, one of them on a phone with touch only.
- Go tests, including a store contract test that has passed against live R2.

**Independent acceptance testing, round 1, found:** cropped Split view, the Esc handling in
Measure, door hit areas, the conflict dead end, the bad-link error, phone status and labels, and
the sample's misplaced master door. All of these are fixed.

**Independent UX review, round 1, found:** onboarding, typed lengths breaking geometry, guidance,
hit targets and the 3D pane's behaviour. Fixed or addressed.

**Round 2, Phase 1 gate (passed):** an independent agent traced the real HDB 3-room Type 4 PDF
from upload to rooms on the live preview.
- **Calibration:** within 0.1%.
- **Rooms:** all 8 detected.
- **Area:** internal 66.1 m² against HDB's 66 m²; 68.6 m² against 69 m² with the A/C ledge.
- **3D and reload:** both correct.
- **Effort:** about 150 actions, roughly 8 to 10 minutes for a person, which is borderline. Fixed
  since:
  - bare numbers are read as millimetres;
  - Set scale keeps the drawing in place;
  - wall chains end when they join existing walls;
  - the phone layout no longer overflows.

**Round 2, code review:** every confirmed bug is fixed. The fixes cover:
- settling corners after moves (merge, split, crossings);
- sliver walls next to corners;
- re-clamping openings;
- the save races;
- not forgetting projects when the server is unreachable;
- repairing and migrating documents on load;
- API hardening.

**Backlog batch A (built):**
- **Corners:** dragging a corner onto another merges them (part of the round-2 fixes). A selected
  or dragged corner shows live lengths on all its walls, and the Corner inspector edits each one,
  moving the corner along that wall (`setWallLength(…, 'end', vertexId)`).
- **Keyboard:** the plan canvas is focusable. In Select, Tab and Shift+Tab walk rooms, walls,
  openings and corners in reading order, and leave the canvas past either end. Arrows nudge 1 cm
  (10 cm with Shift), sliding doors along their wall, and pan when nothing movable is selected.
  The selection is announced in a live region (`apps/web/src/plan/keyboard.ts`).
- **Faster tracing:** door, window and opening width presets in the palette and the inspector
  (HDB 700/800/900 mm doors). Double-click a room, or press Enter or F2 on it, to rename it, with
  common names suggested. Room labels move clear of door swings and holes (`placeLabel`).
- **Rooms inside rooms:** a group of walls standing free inside a room is a hole in it
  (`roomShapes`): its area is subtracted, the floor and ceiling are cut, the plan fill skips it,
  and room matching ignores points inside holes.

**Round 3 code review (fixed):**
- **Enclosures stealing names:** a centred enclosure could take the outer room's name when the
  label search landed on its edge. Room matching now keeps 5 cm of clearance from holes.
- **Nudge runs:** a run of nudges merged into, or split, whatever it passed. Nudges now only move
  things, and the corners settle once, 0.5 s after the last press or when the selection changes.
  A merged corner stays selected.
- **Double-click rename:** the canvas took focus back after a double-click on a room.
- **Smaller fixes:** labels are re-fitted per zoom step, not per wheel tick. Columns down to
  0.01 m² count as holes. The shape cache only holds frozen levels.

**Room boundaries (schema 2):** `Wall.kind: 'boundary'` is a room edge that is not a wall, such
as an open kitchen beside the living room. It divides rooms, has no footprint, mesh or
openings, and is drawn dashed. The Wall and Room tools offer "Boundary" beside the
thicknesses, and the wall inspector switches a wall between the two kinds. Making a wall a
boundary removes its openings. Version-1 documents migrate unchanged, and the Go API accepts
versions 1 and 2.

**Round 3 acceptance (fixed):**
- **Double-click rename:** see the code review above.
- **Escape:** it now cancels in text and length fields instead of saving.
- **Focus after a rename:** a keyboard rename hands focus back to the plan.
- **Decimal commas:** `3,5` is read as 3.5, and `10,275` is still read as thousands.
- **Common widths:** the control fits the inspector.
- **Labels:** they keep 10 cm clear of walls.
- **Empty-plan card:** it no longer blocks drawing.
- **Corner fields:** two of them pointing the same way are numbered.
- **Wall announcements:** they name the rooms on either side.
- **Open:** the phone palette hides the width presets, and the 390 px layout scrolls 2 px
  sideways.

**Round 4 (fixed):**
- **Inspector edits (high):** an edit made in the inspector used to land on the next object
  clicked. Fields now pin an edit to the object it was typed for (`useEdit` in
  `ui/fields.tsx`).
- **Topology:**
  - A wall or boundary that ends on a door or window snaps to the nearer jamb instead of
    moving the opening.
  - Where a wall and a boundary coincide, the wall is kept, and a dropped wall's openings move
    to its twin.
  - Tracing a wall over a boundary turns it into a wall.
  - Overlapping openings are refused.
- **Plan images:**
  - The API checks the hash from metadata before reading any bytes, answers HEAD from metadata,
    and streams GETs with at most 4 in flight. The Pages Function caches image responses at
    the edge.
  - The file store writes `<id>.<hash>.bin` before its meta.
  - Upload errors are 413 only when the image really is too large, and uploads have 2-minute
    timeouts.
  - `DELETE /projects/{id}/image` runs when the plan image is removed.
  - The client syncs one upload at a time per project, and catches up if the image changed
    meanwhile.
  - Images the server can't take are re-encoded and re-keyed, with the scale adjusted. The
    re-key is not an undo step (`DispatchOptions.record: false`).
  - Missing images are retried a few times.
- **Opening failures:** a project that fails to open is now `sync: failed`. It isn't editable,
  and Retry reopens it.
- **Smaller fixes:**
  - "0,040" is read as 0.04 m.
  - Boundaries say "boundary" in toasts and aren't counted as walls.
  - Outer walls are announced as "… and outside".
  - Nudging keeps the object in view.
  - Labels allow for wall thickness.
  - The 390 px layout no longer scrolls sideways.
- **Open:**
  - A corner moved onto a collinear wall can overlap it without splitting at the T it passes.
  - Two rooms with different ceiling heights at a boundary leave an unfilled step in 3D.
  - The API doesn't refuse a PUT that lowers `schemaVersion`.
  - The edge cache can still serve a deleted image by its exact hash URL.
  - The door, window and opening tools give no cue when hovering a boundary.
  - The phone palette hides the width presets.
  - Labels are truncated in Split view at default zoom.
  - Dimension labels can cover room labels.

**Round 5 (fixed):**
- **Walk mode passed:** an independent agent took about 2,200 position samples and saw no
  wall or window crossed. Doors and passages let you through, and phone stick and look work.
- **Edits on panel change:** an edit was lost when the next click was a different kind of
  object or empty canvas. Inspector panels are now keyed by object, and a field commits its
  pending edit as it unmounts. A refused value no longer carries over.
- **Plan images:** removing an image and then undoing straight away could delete the server's
  copy after re-checking it. Deletes now queue behind uploads. A new route,
  `GET /projects/{id}/image` → `{hash}`, replaces the HEAD check that logged 404s.
- **Walking:**
  - The start view faces the longest view across the room.
  - A light at head height gives the walls depth.
  - On phones the walk view takes the whole screen, and the thumb stick has more contrast.
  - The hint explains the two-step Esc.
  - Clicking under pointer lock no longer throws.
- **Openings:** the door, window and opening tools say why a spot is refused: it overlaps an
  opening, the wall is too short, or it's a room boundary.
- **Keyboard:** Escape then Shift+Tab leaves the plan.
- **Wording:** a wall with the same room on both sides is announced "in" that room.
- **Phone width:** the last 2 px of sideways overflow is gone.

**Round 5 code review (fixed):**
- **Jamb snapping:** it now happens in `snapPoint`, so only the point being drawn moves and the
  preview shows it. `splitWallAt` no longer moves a shared corner, which bent walls.
- **Inspector fields:** they commit through the latest values for their object (the panels are
  keyed per object). A commit during unmount is guarded. A top-level `ErrorBoundary` replaces a
  blank page with a Reload screen.
- **Smaller fixes:**
  - The thumb stick is released when a walk ends.
  - Remove deletes the server image only if the plan really lost it.
  - Image sync runs only while the plan can be edited.
  - Walk keys leave a focused `<select>` alone.
  - The file store reads older `<id>.bin` images.
  - A busy image GET returns 503.

**Sharing (owner's decision: links can be view-only or editable, and edits save to the
owner's plan):**
- **Owner key:** creating a project returns `X-Owner-Token` once; the server keeps only its
  SHA-256 (`store.AccessStore`, `access/<id>.json` in R2). The browser keeps its keys per project
  in localStorage (`keys.ts`) and sends `Authorization: Bearer …`.
- **Roles:** `GET /projects/{id}` reports `X-Role`:
  - `owner`: edit, share and delete;
  - `editor`: edit, through the edit link `?p=<id>#k=<key>` (the key is in the fragment, so it
    stays out of server logs and Referer headers; older `&k=` links still work);
  - `viewer`: the plain link;
  - `open`: a project from before sharing.
  Writes (PUT, image PUT and DELETE) need owner, editor or open; DELETE of a project needs
  owner or open.
- **Sharing endpoints:** `GET`/`PUT /projects/{id}/share` (owner only) turn the edit link on or
  off, or reset its key so old edit links stop working.
- **Claiming:** `POST /projects/{id}/claim` makes the caller the owner of an `open` project.
  The web app only claims when asked: the Share menu of an open project says anyone with its
  link can edit it and offers "Make me the owner". (Claiming automatically from the recent list
  let anyone who had opened the link take it from its creator.) If someone does take a plan,
  the remedy is deleting `access/<id>.json` in R2 by hand, which makes it open again.
- **Recovery copies:** each save copies the version it replaces to
  `previous/<id>/<version>.json`, and a delete first copies the project to `deleted/<id>.json`
  and its access record to `deleted/<id>.access.json` (images are not kept). Lifecycle rules
  on both buckets (`expire-previous`, `expire-deleted`) expire them after 30 days. To restore,
  copy the objects back (`projects/<id>.json`, `access/<id>.json`) with wrangler.
- **Web:**
  - a Share menu in the top bar;
  - a view-only banner with "Make my own copy";
  - tools, inspector and project name locked for viewers;
  - an edit key is taken out of the address bar and kept;
  - a save refused with 403 turns the tab view-only with a notice.
- **Deploy order:** a web app that expects roles must not meet an API without them, or every
  visitor becomes a viewer. Deploy the API first.

**Mobile (from a fingers-only audit):**
- **Touch on the plan:**
  - A tap acts where the finger lifts.
  - A one-finger drag in a drawing tool previews under the finger and acts from start to end
    (`ToolController.touchDrag`): a wall or room corner to corner, a scale or measure line end
    to end.
  - Select drags a corner or door, or pans.
  - Two fingers pinch-zoom and pan in every tool, and never place anything.
- **Wall tool:** a drawing bar (length field, Add, Undo, Done) shows while a chain is open.
- **Set scale:** a real length field and button.
- **Details panel:**
  - On phones and tablets it shows the active tool's name, hint and options (thickness or
    widths), and Set scale's plan-image controls.
  - On phones it folds to one row when there's nothing to edit.
- **Top bar:** the project menu is no longer clipped, and the save status shows as a dot on
  phones.
- **Touch targets:** they are at least 40–44 px on coarse pointers.
- **Testing:** `e2e/mobile.spec.ts` drives a phone with touch events only. Earlier acceptance
  rounds used keyboard events a phone can't send, which is how the Set scale and menu bugs got
  through; every mobile check now uses fingers only.
- **Round 2 fixes (from a second fingers-only audit):**
  - the wall bar's typed length can turn the corner: Left, Straight or Right (sticky, so a
    rectangle is three taps), with a preview of where it will go;
  - Set scale ends can be dragged to adjust them (`ToolController.grabs` hands a touch that
    starts on one to down/move/up), and the length card sits on the side away from the line;
  - a drag in Room or Set scale starts where the finger went down, and a waiting first room
    corner shows with Cancel;
  - an uploaded plan opens framed on its drawing, not the page (`inkBounds`);
  - Set scale with no image, and the empty plan, offer Upload and the HDB PDF sample directly;
  - a pinch outside the plan no longer zooms the page (`touch-action`, iOS `gesturestart`);
  - the top bar and the tool row fit a 390 px phone (Share is an icon; only Fit in the
    plan corner on touch screens);
  - opening another plan veils the old one; a door tap that can't place says why; the wall
    details have "Add a corner in the middle".
- **Round 3 fixes:** the details panel keeps to the screen (chips scroll sideways, options
  before the hint) and stays folded across tools once folded; the plan keeps its place when
  the panel resizes; a finger on a scale end takes it at once (no 8 px threshold); a typed
  length landing on a corner joins it (closing an outline ends the chain) and a typed wall
  running off screen brings its end into view; an opening narrowed to fit says so; the top
  bar fits 390 px exactly.
- **Still open:**
  - placing points on lift with a magnifier;
  - room deletion.
- **Also fixed after a review:**
  - a cancelled touch (a back swipe) acts on nothing;
  - panning in Select doesn't select the room under the finger;
  - the wall bar's Undo only takes back the chain's own wall;
  - a typed length aims along the last wall unless the pointer has moved since.

**Walls to one side of their line (schema 3):** `Wall.side` ('left' | 'right', absent =
centred) puts one face on the wall's line, so walls of different thickness in a row keep a
flush face, as real outside walls do where structure gives way to a thinner wall or a window.
`wallFaces` gives each face's distance from the line; mitres in `wallFootprints` use those,
and `wallFrame` sits on the real centre line, so openings, 3D, collision and hit-testing need
no changes. The wall details offer Centred / One side / Other side. Rooms are still traced
along wall lines, so a room bounded by a one-sided wall's line includes that wall's
thickness.

**Sample flat:** `sampleFlatProject` (core fixtures) is the owner's own plan: the published HDB
3-room Type 4 (Blk 39A), traced from `public/samples/hdb-3room-type4.pdf`. It has 9 rooms and
68.9 m² to its wall lines, matching the published 69 m² gross; the dry kitchen is marked off
from the living room by two room boundaries. Every wall has the thickness measured off the
PDF at 600 dpi (300 mm structural, 255 mm shelter, 254 and 150 mm outer, 125 mm kitchen,
105 mm ledge parapets, 100 and 90 mm partitions), and two runs are one-sided with a flush
face: the bedroom's 300 → 100 mm wall and the shelter's wall carrying on as the kitchen's. A
test walks from the start into every room that has a door. It is built with the editor's own commands, then given
readable ids (`w_bedroom_main-bedroom`). It comes with its plan image already scaled under it:
`public/samples/hdb-3room-type4.png`, a 16-grey crop of the PDF keyed by its hash
(`SAMPLE_PLAN_KEY`). The web app fetches bundled images from `/samples` (`BUNDLED_ASSETS` in
`assets.ts`) and uploads them to each sample copy like any plan image; a unit test checks the
file still matches its key. `hdb4room` stays as the test fixture.

**Plan images on the server (built):** `PUT /projects/{id}/image` stores one PNG, JPEG or WebP
of up to 10 MB per project, checked by sniffing the content, and returns its SHA-256.
`GET /projects/{id}/image/{hash}` serves it, immutable and sandboxed, only while that hash is
current. Deleting a project deletes its image. The memory, file and R2 stores implement
`store.ImageStore`; in R2 it is `images/<id>`. In the web app, `underlay.assetKey` is
`sha256:<hex>`. The image is kept in IndexedDB and uploaded in the background, and a browser
without it fetches it from the server. Other formats and very large photos are re-encoded as
JPEG first. Older `img_…` keys are uploaded and re-keyed the next time their plan opens in the
browser that has them.

**Your own models (schema 6):** the Furniture catalogue's "Your models" group uploads a
binary glTF (`.glb`, up to 20 MB, 40 per plan). `Project.models` (optional) holds each one's
name, SHA-256, category and size; items made from it have its id (`mdl_…`) as `assetId`.
Core keeps the open project's models in a registry (`setProjectModels`; `furnitureKind`
falls back to it), which the web store refreshes whenever the document changes (`store.ts`).
The size is measured on upload (`modelFiles.ts`: the first of metres, centimetres and
millimetres that makes the largest side 5 cm to 6 m); render's `ModelLibrary` centres the
model on load and the scene fits it to that size. Draco-compressed models load (decoder in
`public/draco/`, copied from three's `examples/jsm/libs/draco/gltf`, outside Biome). The GLB is kept in IndexedDB under `sha256:<hash>` and copied to the
API in the background (`models.ts`, `syncModels`); a browser without it fetches it from
`GET /projects/{id}/models/{hash}` (no key needed, immutable, sandboxed, as plan images).
The API stores them per project (memory, file `models/<id>/<hash>.glb` read on demand, R2
`models/<id>/<hash>`) and deletes them with the project. `GET /projects/{id}/models` lists
the hashes held, so a client uploads only what's missing (never from a view-only link).
At 40, an upload first drops the models the saved document no longer names; still full is
422. Uploads run two at a time, downloads eight. Copying a plan fetches its models into this
browser first, so the copy can upload them; a plan naming a model that is on neither this
device nor the server (an imported file) says so. The details panel's "Your model" renames
a model or removes it with every piece made from it (one undo step); restoring an earlier
version brings its models back. Not handled: rigged (skinned) models measure wrongly.

**Welcome page (`/welcome/`):** a second Vite entry (`apps/web/welcome/index.html`,
`src/welcome/`), built with the taste-skill (direction "the product performs", seed
1945293713, the app's palette and type kept). The app stays at `/`; its project menu links
to the page ("About Dream Home"). The fragments are the app's own code: `MiniPlan` draws the
sample flat with core, the hero's wall drags through `shiftWall`/`shiftBlocked` (a slider to
keyboards), and the renovation section's controls redraw the main bedroom. Pictures are the
app's own (3D view, walk, furnished plan, an orbit clip in `public/welcome/`, captured with
Playwright) and one photograph, "Kovan HDB flats" by Angcr (CC BY 3.0, credited in the
footer). The closing form opens `/?new=<name>`, which starts a blank plan of that name.
Checked with the skill's `lint.mjs` and `inspect.mjs` (0 FAIL, 0 WARN at 1440, 768, 390;
run the inspector with a `--no-sandbox` Chrome wrapper as root). Whether `/` should become
the welcome page (and the app move) is the owner's call.

**Exact render (slices 0 and 1, [spec](docs/specs/exact-render.md)):** the render dialog opens
on **Exact | AI impression**, on Exact every time. Exact path traces the 3D model on the
device: `buildExactScene` (packages/render) builds the same `LevelMeshes` as the 3D view with
`PhotoMaterials` (physical versions of the same material ids) and adds only the sun, the sky
(an equirect float texture), every lamp (`lampLights`: flush ceiling lights as spots, the rest
points, candela as is) and the ground. `lampsAuto` (core) turns lamps on at night or in a room
daylight doesn't reach. The engine is `three-gpu-pathtracer@0.0.23` (WebGL 2), pinned, lazily
loaded (61 KB gzip) behind `ExactEngine` (`apps/web/src/exact/engine.ts`); `ExactRun` drives
it (a step a frame, never more than one GPU step queued: a fence per step; time cap, Stop,
Carry on, More samples, paused when hidden or on the AI side). The frame stays covered until
the first whole sample is metered (exposure: AgX, ±3 EV about a typical room at that hour, set
for good at 8 samples). The engine is kept for the session (`loadEngine`): its shader is
compiled once, each render only builds its scene (`claim`/`release`); a lost context makes a
fresh one, and the last kept snapshot stands in, to see and download, with Try again. A render
left for another camera ("Render from") is kept as its last picture. The 3D view's frameloop
rests while Exact renders. Tests set `window.__DHD_EXACT_TEST__` (size box, samples, cap).
- **Library bugs found (0.0.23 on three 0.170), handled in the adapter:** a mesh with several
  materials (geometry groups: every wall) shifts the material of every mesh after it, because
  materials are numbered per mesh but listed per slot; most paths then went black.
  `flattenForTracing` hands the tracer one mesh per material, in world space (same
  triangles). `WebGLPathTracer.dispose()` throws (`_renderQuad`); the adapter frees the parts.
  The detectors aren't exported; `PrecisionDetector` is imported from its source.
  **Shadow rays pass through the shown face of a one-sided material** (its sidedness test
  skips `side == material.side`), so ceilings and floors (single planes) let the sun and sky
  into closed rooms: every material the exact scene uses is two-sided (`PhotoMaterials`,
  model copies, the ground). A sealed room at noon now reads black (e2e); before, about
  3,700 cd/m². `SpotLight.copy` drops the tracer's ad-hoc `radius`; `flattenForTracing` keeps
  it, and expands instanced meshes.
  Without `KHR_parallel_shader_compile` (SwiftShader, some phones) the shader is built on the
  first draw, holding the page; that can't be timed or caught, so the dialog says "the first
  time takes longest" before that draw. A failed link is caught (`LINK_STATUS` after compile).
  Sharing GLB textures with the exact renderer leaves a dispose listener on them; with one
  engine per session that holds one renderer, not one per render.
- **Spike measurements (6 Nov, this cloud machine: 4 CPUs, no GPU, so Chromium's SwiftShader
  as in CI; the furnished sample from eye height):** prepare (flatten, BVH, textures, shader
  link) 0.3–0.8 s; SwiftShader compiles the tracer's shader on its first draw, about 25 s; then
  35–45 k pixel-samples a second (160 × 120: about 1.5 samples/s; 320 × 180: 0.6/s). 16 samples
  at 160 × 120 take 35–50 s in all, inside the 60 s CI budget, so the pixel test runs in CI.
  A GPU was not available here: the desktop and phone budgets (samples/s at 1600 px, first
  picture, Good in 45 s) are **not measured yet**; use `/dev/exact-spike.html` on the dev
  server on the reference devices.
- **Sun through glazed windows reaches the floor** (spike `probe=auto`, redone after the
  two-sided fix; the first numbers were inflated by the leak): at 4 pm, through a kitchen
  window facing the sun, the patch read 208 cd/m² against 28 in the shade beside it, and 227
  with the pane left out (the pane passes about 92%; 32 samples at 200 × 150, noisy). From eye
  height in the living room at 4 pm the sun's patch through the window shows on the wall. No
  fallback needed.
- **Window light portals (6–7 Nov):** daylight-only interiors were grainy because the tracer
  finds the sky only by rays that chance on a window (its sky sampling doesn't aim at them;
  no portals in 0.0.23): at 64 samples 10–18% of pixels black and 10–15% specks. Now, for a
  view from inside a room (ceilings on, the camera in a room, by day: `daylight.light` ≥
  `PORTALS_FROM`), `portalLights` puts one light in each opening to the sky of the rooms whose
  daylight reaches the camera. `skyOpenings` (core, `portals.ts`) finds windows, passages,
  glazed doors, glass walls (an opening in one is part of the wall's), the gap over a half wall
  (glazed if it has glass above; an opening in a half wall only up to the wall's top) and
  boundaries, between a room and outside; `daylightReach`
  goes from the camera's room on through passages, inside windows, glazed doors, doors
  standing open (the 3D view's open fractions; a shut one stops it), glass walls and half
  walls, room after room. Each light is an even rectangle the opening's size, **flat in the
  hole a hair inside the pane** (a passage's at its far end; a glazed door's a hair on the
  room's side of its shut leaves, wherever they stand): the reveal's sill, jambs and head on
  the room's side are lit, and nothing reaches into the room. It carries the sky's light (its irradiance on the opening over π, `portalRadiance`)
  and the ground's (half its radiance for the lower half of the view: sky-lit, plus sunlit as
  much as `groundInSun` finds the ground below that window in sun, a few shadow tests against
  the solid walls; times `GROUND_REACHES`, 0.37), less what the reveal beyond it hides
  (`revealPasses`, the view factor through the outer half of the hole) and the glass (90%).
  The sun is unchanged (a directional light, aimed at, through the panes). **No double
  counting:** with at least one portal the sky lights nothing (`environmentIntensity` 0) and
  stays the backdrop (seen by camera rays and through glass); rays from a room pass through
  the ground (`castShadow` false, which the tracer's diffuse bounces honour), so the ground
  lights the rooms only through the portals; seen through glass, the backdrop below the
  horizon is the ground's lit look; seen straight on (an open passage) it gives off the sky's
  share. A portal sits inside the pane so a ray from the room meets it first and the tracer
  weighs the hit against the bounce that sent it (behind the pane it is weighed against the
  pane and counted twice). **With no portal in reach** (a windowless room, a camera outside
  the rooms, night) the sky lights the scene as before, so the sealed-room e2e still guards
  leaks. **Known limits:** an outside wall seen from a window has the sun's light but not the
  sky's; a mirror or glossy surface facing a window reflects the portal's even light, not the
  view out (the tracer counts light hits on reflected rays; making portals invisible to them
  needs a deeper shader patch, and the glossy share would then be counted twice); a door in a
  glass wall is lit as glass; `GROUND_REACHES` is one number for every window (below).
- **Firefly clamp:** each sample is capped, a shader patch on the tracer's material. The cap is
  `sampleClamp` (twice a white wall in full sun, 20,000 cd/m² at least) **times the number of
  lights the tracer picks among** (`lightChoices`, by the tracer's own rule, `getLights`:
  every visible rect area, spot, point and directional light whatever its intensity, and the
  sky if it lights; counted on the scene the tracer is given and checked against its code in
  a unit test). The tracer aims each sample at one light at random and scales the find by the
  count, so the first version, capped at `sampleClamp` alone, cut true direct sun (at 4 pm the
  picture lost about a fifth); now a sunlit white wall's one direct sample is under the cap.
  It only cuts a rare path the tracer boosts (Russian roulette, a glossy bounce).
- **Specks spread, not cut (7 Nov):** what was left was white specks: true light (the sun's
  patches on the floor and furniture, seen off a wall) found too rarely to average out by 64
  samples, which the denoiser keeps as detail. Clamping only what comes after the first bounce
  was tried (a shader patch splitting the sample where the tracer first aims at a light from a
  second surface): it removes the specks but **the room loses 15–50% of its light** (a cap of
  1,000 cd/m²: specks 0.05–0.3%, room −20 to −50%; 4,000: 0.06–0.6%, −14 to −40%), since that
  light is real, found only by such paths. So the shown picture spreads them instead
  (`KeepPass`, `ExcessPass`, `SpreadPass` in `pathtracer.ts`, before exposure and the
  denoiser; `specks.ts` is the same kernel in TypeScript, with tests): a pixel more than
  `speckLimit` times the median of the eight around it (2.5 up to Good's 256 samples, then
  loosening with the square of the samples: 10 at 512, 40 at 1024) keeps that much, and its
  excess is spread over the pixels about it by a Gaussian (σ 1/40 of the picture's width:
  **12 px on a real 480-px picture, at most 12**; the spike's 120-px measurements used 3 px)
  weighted by how alike each looks to the speck's own pixel (colour, and loosely brightness),
  so a floor's light stays on the floor and doesn't tint the sofa on it (a plain spread
  failed the pixel test's grey sofa: saturation 0.22). Each speck's share is divided by the
  weights it hands out before it is gathered, and taps off the picture are mirrored back in
  at its edge, so the picture keeps all its light and an even picture stays even to its edges
  (clamped taps, as at 78ac7b0, smeared a corner and didn't keep the light; skipped ones keep
  it but darken the edges, a uniform field to 0.69 at the edge). A pixel that isn't a finite
  number counts as black. The passes run once a whole sample (the picture shown between is
  the last whole sample's; drawing it every tile step cost as much as tracing on SwiftShader),
  each pixel's look is written once, and `speck = 0` skips them. At 1280 × 720 in headless
  Chromium (SwiftShader) a whole sample took 11.3 s of tracing (82%), 1.4 s of speck spread
  (10%) and 1.1 s of display (8%); 15.3 s a sample in all, 12.5 s without the spread, against
  30.1 and 26.7 s at 78ac7b0 (which drew every tile step). The tiles adapt on the tracer's step
  alone (the fence goes in before the picture is drawn): 3 4 4 4 4 4 a side over six samples
  with the spread and without. `release()` shrinks its targets to 1 × 1. Specks as shown:
  0.04% at 256 samples where the raw picture has 2.1% (the sample flat's living room at 4 pm,
  160 × 120), 0.10% at 1024 (raw 0.05%): there, a window's corner, 6 times its neighbours,
  stands at its full 841 cd/m² (cut to 346 at the 2.5 limit). Early on the walls show soft,
  low mottling where the specks were; it fades as samples add up. The tracer's own sample
  stays as it was, so the metering and the spike's raw numbers (`raw=1`) are unchanged.
- **Measured (7 Nov; spike on SwiftShader, 120 × 90, 6 Nov sun):** black = pixels with no light
  at all, specks = over 4× their 5 × 5 neighbourhood's median, of the raw samples or of the
  picture as shown (specks spread; both linear, before the denoiser); room = the mean over the reference's room pixels (under 5× its median, so not
  the windows), pixel for pixel and specks included, so light found by chance counts;
  reference = no portals, no clamp, 1024 samples. `GROUND_REACHES` was set on the first three
  (the ground's share at 0 and 1 against the references: 0.30–0.41, mean 0.37); the last four
  are held out: another flat (the 4-room fixture), other hours, furnished.

  | scene | before, 32 / 64 samples: black; specks (raw) | 34e204a at 64: specks (raw); room vs reference | now, 32 / 64: black; specks (shown) | now, room at 64 vs reference |
  |---|---|---|---|---|
  | sample flat, living, noon | 28 / 10%; 23 / 13% | 1.3%; −1% | 0 / 0%; 0.06 / 0.06% | 158 vs 166 (−5%) |
  | sample flat, living, 4 pm | 26 / 10%; 19 / 10% | 1.7%; +4% | 0 / 0%; 0.06 / 0.03% | 120 vs 113 (+7%) |
  | sample flat, walk (8.16, 4.6) north, noon | 28 / 10%; 24 / 11% | 1.1%; −12% | 0 / 0%; 0.06 / 0.06% | 181 vs 198 (−9%) |
  | *held out:* 4-room, living (west window), 10 am | 41 / 18%; 29 / 15% | 0.5%; −13% | 0 / 0%; 0.14 / 0.08% | 67 vs 77 (−13%) |
  | *held out:* 4-room, master bedroom, 3 pm | 29 / 11%; 23 / 14% | 2.7%; −30% | 0 / 0%; 0.30 / 0.03% | 128 vs 168 (**−24%**) |
  | *held out:* furnished sample, living, 9 am | 35 / 17%; 26 / 15% | 1.6%; −1% | 0 / 0%; 0.13 / 0.09% | 73 vs 88 (−18%; again: 88, 0%) |
  | *held out:* furnished sample, living, 4 pm | 32 / 13%; 26 / 13% | 4.9%; +6% | 0 / 0%; 0.33 / 0.11% | 128 vs 108 (+18%; again: 100, −7%) |

  **This table is the regression baseline** (`phase3.sh`-style runs: the spike's `portals=1`,
  `clamp=auto`, its default speck spread, against `portals=0` at 1024). Room numbers at 64
  samples move by up to ±20% from run to run in the furnished scenes (the sun's patches on
  the furniture light the room by chance), about ±10% in the others, so compare a few runs
  (the furnished ones were run twice here). So: no black pixels; specks, as shown,
  0.03–0.33% (from 10–15% before the portals, 1–5% at 34e204a); the room's light within the
  64-sample noise of the reference in six scenes of seven, held-out ones included. **Accepted slice-1 limit: the 4-room master bedroom at
  3 pm is 23–30% dark** (its own fit would be about 1.0, against 0.37): the ground's share is
  the weak part. An even light in the window sends the ground's light down onto the floor as
  much as up to the ceiling, where the real light goes up, so how much reaches the camera's
  view varies with the view (0.30–1.0); "ground light sent upward" is slice 2 (a light that
  shines upward: a tipped emitter, which no longer fits in a reveal, or spot lights). The sky's
  portal alone was checked against a render with no light sampling at all (sun off, ground
  black): 53.2 against 52.5 cd/m². Redo with the spike's `portals=1`, `plain=1`,
  `flat=hdb4`, `room=`, `pose=`, `clamp=auto`, `speck=`, `raw=1`, `gk=`, `nosun=1`, `mis=0`,
  `glow=0`, `darkground=1`; it writes each pixel's luminance for comparing. The app's own
  picture (the walk at 4 pm, 48 samples, 480 × 420): specks 1.55% at 34e204a, 0.01% now
  (390 × 844 phone, 32 samples: 0.63% and 0.02%; display values, over 1.6× their 5 × 5
  median). That dialog's 48 samples took 3:24 on SwiftShader, against 4:14 at 78ac7b0 (the
  spread every tile step) and 3:01 at 34e204a (no spread).
- **Tests:** `e2e/exact.spec.ts` (about 3 min under SwiftShader: one dialog flow (stop, carry
  on, switch and back with the frame and focus kept, kept renders per camera, a context reset,
  close and reopen; the picture kept after a reset is a metered one, not mostly black: the
  snapshot is taken only once the first whole sample is metered), a sealed room (no portals
  in reach, so the sky lights the scene: a leak shows), the pixel test on a fixture room at 32
  samples, the phone walk, no WebGL 2). The AI render tests now click "AI impression" first.
  Unit tests: `portals.test.ts` (core: the openings, the pane, glass walls once, gaps over
  half walls and a half wall's window cut at its top, a glazed door inside its leaf, reach
  through open and shut doors and glass, the ground in sun), `exactScene.test.ts` (one flat
  portal per opening, its light, sky on with none or at night, the clamp per light choice)
  and `flatten.test.ts` (the light count against the tracer's own `getLights`).
- **Seen, to check on a GPU at 256 samples:** what grain is left (the sun's patches on the
  floor lighting the room by chance, the lamps' at night: lamps are aimed at already); the
  picture is warm where an oak floor bounces sunlight and cool where only the sky lights a
  room (physically so; no white balance, which the spec leaves out). The view out of the
  walk's end window shows dark dots on SwiftShader, with or without portals (not looked into).
- **Left for slice 2+:** Quality, Time, Lamps and Brightness settings; hints; full-screen
  viewer; real textures; Polish with AI; the slow-device estimate.

**AI designer v2, slice 1 (merged 7 Nov, #47):** the model answers with intent (`against`,
`faces`, `near`, `zone`) and `designer/solve.ts` places the pieces: candidates per piece,
lookahead and backtracking under a tries budget (12k for a space's first solve, 5k per swap,
10k for swaps, 3k for a walkway re-solve; counted, so results are deterministic). Ranking:
essential pieces left out, then pieces short of room, then other drops, then score. Swaps
(round or bench table, extendable table keeping every chair, 2-seat sofa) run only when the
0.60 m dining-to-lounge gap, places or seats, or an essential piece need them. A walkway
re-solve is kept only through `acceptResolve` (`designer/resolve.ts`): no new failing hard key,
strictly fewer, pieces no worse. Principles once in `principles.ts`, hard/soft in `checks.ts`
(HDB rules not waivable), regression cases in `fixtures/designer/cases/`, benchmark in
`designer/benchmark/`. PERF (7 Nov, follow-up): sample about 110-150 ms cold, 35-55 ms
cached; heavy living rooms about 140-190 ms median (bound 300 ms under `PERF`; they were
330-470 ms). Each piece's poses are made once per space and kept for the first solve, its
swaps and the walkway re-solves (`PoseCache`, with what the walls and doors do to each), a
pose's room-only score parts once (`PoseRoom`; the room off a side is the nearer of the walls'
and the pieces', so only the pieces' part is redone), and a walkway re-solve stops once its
budget is spent and it already leaves out, squeezes or turns more pieces than the solve it
would replace (`noWorseThan`: it could only be refused). Layouts unchanged. Next for phones
(about 4x slower): `designResult` in a Web Worker.
Slice 2 (the conversation) is designed: `designer-v2/slice2-ux.md` and `slice2-tech.md` in
the session scratchpad, decisions folded into the build; PR 1 is being built.

**AI designer v2, slice 2 PR 1 (the conversation, 8 Nov):** core `designer/talk/` (zod records
with `TALK_LIMITS`, the reducer, first meeting, change sets and `acceptChanges`/`putPlanBack`
Commands in `talk/changes.ts`, pricing `askRule`/`estimatePlan`); web `apps/web/src/ai/designer/talk/`
(panel and phone sheet, cards, scope buttons, cost cards, IndexedDB `dhd-talk`, separate from
`dhd-designs`, records checked before every write, a newer build's record never touched). Money
only leaves from a priced button; Go ahead is bound to the figure shown. Cards compute from the
project once edits pause (`useSettledProject`), folded cards not at all. Known gaps for PR 2:
designing levels other than the first; on a no-bedroom plan "Just design it" leaves nobody a bed
with no row to change it; a failed card still offers Show in 3D and Another idea; focus after a
cost card or a finished run; after Undo the card's ticks reset; the "Updated from another tab"
line never shows; the plan doesn't zoom to the proposal's room. Design docs: `slice2-ux.md`,
`slice2-tech.md`; QA results `s2pr1-qa.md` (session scratchpad).

**AI designer v2, slice 2 PR 2 (talk to it, 8 Nov):** core `designer/talk/` adds `plan.ts`
(`planScope`, `changePlan`, `changeFrom`, moved from web), `parseTalkReply` (salvaging), the
`partialTalk` streaming scanner, `talkPrompt` (byte-stable history, cache marks, summaries) and
record version 2. Web `talk/turn.ts`: Send, Try again (newest message only), Edit, Stop; one
reply per plan through a Web Lock (`withReplyLock` never re-runs a callback, so no double call);
a dead reply in another tab is detected by re-querying the lock. A reply may tighten but never
loosen the walls brief or raise the budget: those become a free Yes/No (`talkConfirm`). Talk
calls stop retrying once they've spent their priced at-most or reach the tab limit. Not done: A/B/C alternatives (PR 3); the phone cost card that needs scrolling; "about S$40k"
stored as S$32-40k. QA results: `s2pr2-qa.md` (session scratchpad).

**Designer results in a Web Worker (8 Nov):** `apps/web/src/ai/designer/results.worker.ts` owns
core's memos and does the pricing; `results.ts` keeps a 12-entry main-thread cache keyed by
core's `designResultKey`, read through `readResult`/`readPrice` (pending until the answer lands;
results frozen on arrival). Priced buttons show a skeleton until priced; a press re-prices and
compares with the figure its button showed (missing or dearer: cost card). A worker that errors,
fails to clone or doesn't answer within 12 s is terminated and the main thread answers from then
on; Stop races every placing. `window.__dhdDesignerWorker` (set by tests only) counts answers.
Heavy-room run: blocking time about 85 to 33 ms; drag with the panel open: about 73 to 0.
Still on the main thread: `subsetReport` (about 190 ms heavy), `sendPrice`/`talkPrompt`,
`probeLines`.

**AI designer v2, slice 2 part 3 (iterate, 8 Nov):** core `designer/talk/iterate.ts`
(alternatives, Bring this back, restart, text and export). Alternatives A/B/C share one card and
one V number (V4A, V4B) for one- or two-room scopes; only accepted options become versions.
Bring this back re-checks an old option on today's plan and keeps hand edits made since. Put it
back is one Command and one undo step; `rememberPutBack`/`putBackMoves` keep cards, lines and
versions in step with real history moves only. Start over keeps numbering and sweeps unused
levels. Folded cards compute nothing; a 20-card e2e keeps each round near 1-2 s.

**AI designer v2, slice 3b PR 1 (lenses and the storage lens, 8 Nov):** core
`designer/lenses/` holds the `Lens` interface (`report`, optional `steer`; lenses never gate)
and `storageLens`. The household it measures for (`storageSettingFor`): the storage meter's own
household when the person set it there (people or others; how much they own doesn't count),
else who sleeps where in the brief (assumed as the checks assume), the unplaced and a helper as
"others". How much they own (the brief's `owns`, What I know's "How much do you own?") is never
asked in the first meeting: it shows as Assumed (Typical) in What I know, and the card's storage
line has free chips ("Measured for typical amounts · Few · Typical · Lots"). It is one value with
the meter's amount, which the lens reads as the live value: `useTalk` writes the meter after a
fact change and turns a meter change into an `editFact` line. `DesignOptions.storage` (the
meter's setting, `designOpts`, also in `priceKey`) and `lenses` are in the result key, so a
change re-scores the cards with no request. Cards show a Storage line ("clothes 1.8 of 2.0 m,
short 0.2 m · +1.8 m hanging": the designed bedrooms' clothes, the home's other measures) from a
worker `lens` ask (`readLens`). Room steps get a storage block in the tail (data). The solver:
each space is solved as before (memoised as with no lens); only if that solve lost storage the
lenses protect (`storageLost`: a protected piece left out, a preferred one narrowed) is it solved
again with the steer (`Steer`, weights only: protected roles left out last, `dropPriorityOf`; a
preferred piece narrowed costs more and is looked at again at full width, gains a little against
a wall; swaps go on to one that keeps it whole), kept only if no worse (`piecesNoWorse`, no new
hard key from `spaceHardKeys`, the one helper for a space's hard checks). The benchmark's
layouts are unchanged and cost about the same. The conversation record still needs 3a's v3
(`owns` is a new question key): this branch rebases onto it.

**Drag on big plans (task #69):** room labels are fitted once per room (`fitRoomLabel`,
memo keyed on everything the fit reads) with `placeLabel` filtering far circles and searching
nearest-first (exact, ties kept); `wallStatuses`, `planGeometry`, `roomShapes` and
`outsideOpenings` are cached on frozen level parts; the walkway bare raster is rebuilt
incrementally from the last one (`rasterBare`, exact; widths recomputed within WIDE/2+1).
72-room corner drag: about 970 ms CPU a step before, about 150 ms after; walkway run 126 to
58 ms. Left: the main-door widest-way search (about 25 ms, global), possibly a Web Worker.

## 5. Owner to-dos

- **Before the repo goes public:** `apps/web/public/samples/hdb-3room-type4.pdf` (and its PNG
  crop) is a real HDB floor plan (Blk 39A, 3-room Type 4). HDB likely holds its copyright;
  the live app already serves it, but publishing the repo redistributes it. Decide whether
  to keep it, ask HDB, or swap in a plan drawn from scratch (the 4-room reference plan is
  original). No credentials are in the tracked files (only AWS's documentation example keys
  in a signing test).

0. **Done (31 Oct, at the owner's request):** migration `0002` applied to `dhd-auth-preview`
   and `dhd-auth`, and the production edge deployed from main (`pnpm --filter @dhd/edge run
   deploy`): schema 6 with uploaded models, the daily cap and the `%` guard are live (a write
   with `%` in its path gets 400).
   Earlier: the production API must accept schema 4 (deployed with this branch).
   Earlier note: the production API must accept schema 2. It was deployed from this branch
   at the same time as the preview, and it still accepts version-1 documents from `main`.

1. **Connect the API Worker to Git (one time, in the dashboard).** The Builds API refuses the
   account token, so this can't be scripted. In **Workers & Pages → dhd-api → Settings → Builds →
   Connect**, choose GitHub `zeecm/dream-home-designer`, then set:
   - Root directory `apps/edge`, build command empty.
   - Deploy command `npx wrangler@4.152.0 deploy`.
   - Non-production branch builds on, with deploy command
     `npx wrangler@4.152.0 deploy --env preview`.
   - Watch paths `apps/api/*` and `apps/edge/*`.

   Until it's connected, deploy the API by hand (§8). The web app already deploys through Pages'
   Git integration.
2. **Domain:** point it at the Pages project. The `/api` routing comes with it. (Also what
   email sign-in links would need, later.)
2b. **Google sign-in:** create the OAuth client (Web application; origins
   `https://dream-home-designer.pages.dev`, the branch preview and `http://localhost:5173`;
   redirect URIs the same origins plus `/api/auth/google/callback`), send the client id, and
   add the secrets `GOOGLE_CLIENT_SECRET` and `KEYS_SECRET` (a long random string, e.g.
   `openssl rand -base64 32`) to dhd-api and dhd-api-preview (Workers & Pages → Settings →
   Variables and Secrets). This session's permission check refuses secret writes (even a
   generated `KEYS_SECRET`; tried 31 Oct), unless the owner adds a permission rule allowing
   `wrangler secret put`. `KEYS_SECRET` also keys the daily cap's address hashes, so it is
   worth setting before sign-in.
3. **Merge** the open PR when happy.

**Furniture (Phase 3, first cut):** `core/furniture.ts` holds a catalogue of 27 pieces built
from boxes (beds in single, super single, queen and king; wardrobe, bedside table, desk;
sofa, armchair, coffee table, TV console, TV, rug, floor lamp; dining tables and chair;
kitchen base, sink, hob and wall cabinets, fridge, washing machine; toilet, vanity; shoe
cabinet, bookshelf; potted plant), sized as they come in Singapore flats. Items use the
existing schema (`assetId` is the catalogue id; `scale` stretches the default size;
`position.y` is height above the floor). `placeFurniture` backs a piece that stands
against a wall onto the nearest wall face within 35 cm, facing into the room. Commands:
`addItem`, `updateItem`, `deleteItem`. Render builds one merged mesh per material per item;
the walk collides with items standing on the floor (not rugs or wall cabinets). Web: the
Furniture tool (I) with a catalogue and filter in the tool options, a preview that follows
the pointer, R to turn; in Select, drag (with the wall snap), R / Shift+R, arrows, Delete;
the details panel sets width, depth, height, height above the floor, and turns.
A piece backed onto a wall also slides along it clear of the walls that meet it (`clearAlong`
clips the other wall pieces into the strip in front of the face), so a wardrobe dropped in a
corner stands beside the side wall, not in it; a piece wider than the wall stays put. Depth
grows from the wall. On phones the catalogue is one sideways row under a find field, and a
selected piece's details come before the tool's options. Room labels step aside for
furniture, and deletes and announcements name the piece and its room.
**Still open:** the walk mini-map doesn't draw furniture; plan symbols are plain rectangles;
Esc after an invalid field value deselects instead of reverting.
**Finishes:** `core/finishes.ts` lists floor finishes (oak, walnut, ash vinyl, grey and white
tile, marble, polished concrete, grey carpet, plain) and eight wall paints, with colours the
plan (a light tint) and the 3D view share. Each side of a wall takes its own paint: the
render regroups a wall's triangles by facing (`bySide`), ends and tops stay white. The wall
details name each side by the room it faces.

**Lighting (schema 4):** `Project.site` (optional; absent = `DEFAULT_SITE`, Singapore with
north up the plan) holds `north` (radians clockwise from plan-up), latitude, longitude and UTC
offset. `core/sun.ts` gives the sun's altitude and compass bearing for a day and clock hour
(NOAA low-precision formulas, tested against Singapore and London), its world direction, and
a 0–1 `daylight`. The 3D view's sun, sky, background and fill light follow a Time slider
(6 am–10 pm, today's date; view state, not saved). The plan details set which way the top of
the plan faces (N … NW, then a 1° slider; `setSite`), and a compass on the plan (Select tool
only) shows north and opens that setting. Lamps: floor and table lamps, ceiling and pendant
lights (category Lighting; ceiling ones hang from the level's ceiling height and draw as a
circle-and-cross). `itemLights` places each bulb; the view lights the 8 nearest the camera
with unshadowed point lights fading out by 7 m, so some light leaks through walls.
**Before and after (schema 5):** `Project.renovation` holds a second copy of the levels,
"after"; `levels` stays the flat as it is. `startRenovation` copies every level with the same
element ids (the level id gets `AFTER_SUFFIX`, `~after`), so every existing command edits
either version through `draftLevel`/`findLevel`. The web's `variant` (editor store) picks
which version the plan, 3D and walk show and edit (`useLevel`, `currentLevel`); a plan with
a renovation opens on "after". `renovationDiff` compares the two by where walls run, not by
id: a wall split or redrawn in place is unchanged, a moved or thickened one is hacked and
rebuilt. The plan marks hacked wall (red hatch; a dashed outline in "after") and new wall
(accent; an outline in "before"); a bar above the stage switches versions and sums the
changes; the plan details show the totals and "Make it the plan" (`endRenovation('after')`)
or "Discard the renovation", both undoable with a toast. The plan image, north and site are
shared. The diff counts height (a wall cut down is hacked), leaves doorways out of the
lengths, and matches doors and windows by position and size. Undo and redo switch to the
version they change (`touchedVariant` on the step's patches); switching versions remounts the
plan, dropping a half-drawn wall; the bar says which version edits go to and hides while
walking; `loadProject` gives a renovation level that clashes with the plan's id its own.
The details also list the changes room by room (`renovationChanges` in core, `ChangeList` in
`ui/Renovation.tsx`): wall hacked and built (summed per place), doors, windows and openings
added, closed up (or gone with a hacked wall), moved, resized or changed in kind, rooms
renamed, refinished, grown or shrunk, and rooms new or gone, each placed by the rooms either
side of it (just past each face; "outside wall" where one side has none), in the version it
belongs to and named as the room is in the renovation. Rooms are matched between the versions
by where they are (each one's inside point in the other), not by id, since a wall hacked and
drawn again can give a room a new id. "Copy list" puts them on the clipboard as
text, a line per place, for a contractor.
An edit to the flat as it is (Before shown) carries over to the renovation
(`carriedToRenovation` in core, applied in the store's dispatch), all of it or none
(`planCarry`): each corner, wall, door or piece it changes, adds or removes merges field by
field (`merge`: the edit's fields go over where the renovation's are as they were, and the
renovation keeps fields it changed itself, so a repainted wall can still be split or
thickened by a trace fix); a field both changed differently, or a record one removed and
the other changed, holds it back; so does a door of the renovation's own on a wall whose
ends the edit moves (or makes a boundary), or a wall's end moved where the renovation moved
that corner too; a piece of a split wall takes the renovation's fields for the wall; and the
result must hold together (every wall's corners and every opening's wall there, no opening on
a boundary, no wall drawn along another, no two doors overlapping). Then the
renovation's rooms are found again, keeping a name or finish the edit gave a room where the
renovation's was as it was (a new room's name only if free). Otherwise nothing is carried
and a toast says so (a room the renovation renamed or refinished too counts, as does a room
the renovation made or changed that the edit would take away; a room split off in the flat
whose name was taken in the renovation counts as the renovation's own, so a later edit
merging it back is held back too, a cautious answer left as it is). A drag or run
of nudges (one coalesce key) held back at any step goes back to how the drag found the
renovation (`restore`), taking back its steps already carried, and stays held back. Restoring a version (or anything replacing the plan or renovation whole) carries
nothing. One undo step, which shows Before (`touchedVariant`).
**AI: walls from a plan image (stage 1, 5 Nov):** bring your own key. Project menu "AI
assistant…" (`ai/AiSettingsDialog.tsx`): Claude, OpenAI or Gemini, key and model (defaults
`claude-opus-5-5`, `gpt-5`, `gemini-3-pro` since 6 Nov), Test, Forget; kept in this tab
(sessionStorage), or on this device if ticked (`ai/credentials.ts`, key `dhd-ai`), never
in a project, export, share link or `/api` request (e2e checks). Calls go straight from the
browser to the provider (`ai/providers.ts`: the Anthropic SDK, lazy-loaded, with
`dangerouslyAllowBrowser`, JSON-schema output, effort high, the server-side refusal fallback,
no retries, adaptive thinking with summaries streamed; stuck after 120 s with no event, and
OpenAI and Gemini stopped at 300 s; OpenAI chat completions with a strict JSON
schema; Gemini generateContent with `responseJsonSchema`). "Trace walls with AI" in the plan
image panel sends the plan image (at most 1568 px) and asks for wall centre lines, openings
(with a door's hinge and arc), room labels and the printed area, in image pixels
(`ai/trace.ts`). Core (`trace.ts`) turns the reading into metres with the plan's own
calibration and cleans it as a person tracing would: straightened onto the axes, the two
faces of a thick wall made one centre line, a wall broken at its doors joined through them,
ends within 8 cm one corner, ends just short of a wall taken onto it, thickness to 25 mm
(`readingToPlan`); then built with the Wall tool's own `drawWall` (T-junctions split, rooms
found), doors swung the way the plan shows, rooms named from the labels inside them
(`tracedLevel`). The draft shows over the plan with counts and the area (vs the printed one):
Accept builds it again on the plan as it is then and puts it in as one undo step
(`importTrace`, `applyLevel` patches; it replaces walls already drawn), Try again, Discard.
A Content-Security-Policy (`public/_headers`, the same in `vite preview` for the e2e suite)
limits scripts to the site and connections to our API and the three providers; no
violations in 3D, the walk, models or PDF upload. Keys are kept per provider (`credentials.ts`: one in use for
reading plans, others kept), so Claude can read plans while an OpenAI or Gemini key makes
pictures. Each key has its own "remember" (device or this tab). A trace belongs to the
project and level it was started on (`ai/draft.ts`, `traceWhere`): opening another one
cancels it or puts the draft away. Models' enum answers are lower-cased before the zod
parse (`lowerEnums`).
UX review fixes (5 Nov): the AI dialogs scroll in the middle (`.dialog-body`) with their
title and actions fixed (`.dialog-foot`); a dialog's `onClose` checks `e.target` (React
passes a nested dialog's close up the tree). While a draft waits the plan fades
(`:has(.ai-draft)`), the tool goes to Select, and a refused key offers AI settings. Saving a
key from the Trace button starts the trace. The AI assistant can keep the plan reader while
adding an image key ("Use … to trace plans", `saveAi(settings, readsPlans)`); from Render it
opens on OpenAI. Renders switch between the render and the 3D view. Layout thumbnails show
rooms, new or changed walls in the accent colour and walls taken down dashed; an option with
nothing applicable has no Use button. Touch: 44 px buttons in dialogs and the trace bar.

**Photo-real renders (5 Nov):** "Photo-real render" on the 3D view (and while walking: under
Footsteps, a 44 px camera icon on touch screens, with the mini-map moved down below it) takes a picture of the view as it is (`capture3d`) and sends it, with a look (as
designed, warm modern, Scandinavian, modern luxe, industrial), to the person's image model
(`ai/render.ts`: OpenAI `images/edits` with `gpt-image-1`, or Gemini
`gemini-2.5-flash-image` generateContent with image output; Claude makes no pictures). The
picture shows in the dialog to download. The prompt keeps the camera, room and furniture
and asks only for materials and light. While the dialog is open over a walk, the walk
stands still (`paused` on `WalkControls`; the sticks let go and ignore a finger still down,
`disabled` on `Joystick`), so the picture is the view the person saw; closing it carries on
from the same spot (6 Nov, owner: "mobile doesn't have the render option in walk through";
`e2e/walk-render.spec.ts`).

**Renders at true scale (6 Nov, owner: "a high pov makes it look like a big room and the
render adds furniture … that wouldn't actually fit"):** the prompt now carries a scene sheet
(`sceneFacts` and `sceneSheet` in `core/src/sceneFacts.ts`; `renderPrompt` in
`ai/render.ts`). It gives the room the view is of (the camera's room at eye height, else
where the view's middle meets the floor), its size across and into the picture, its area and
ceiling height, and any rooms open to it (joined by room boundaries) or seen through a doorway.
It gives the camera's height and field of view, and whether it is at eye height, overhead
(above 2.2 m) or outside every room. Furniture is listed only when its box is in the frustum
and, below the wall tops, something of it is in plain sight past the walls, up to 25
pieces, largest first, with sizes and where it stands ("against the left wall, by the
window"). Finishes are listed only for the "As designed" look. The sheet starts with the
instruction (keep the size, don't add, remove, enlarge or move furniture, leave empty floor
empty), so the length cap (`MAX_SHEET`, 4500) can only drop pieces, then doors and windows ("and N more"), never it.
Room and piece names (uploaded models' too) are cleaned (`clean`, 40 characters: no newlines
or direction overrides) and quoted as labels. From an orbit or
outside view the dialog offers "From eye height in <room>" (the default) or "From this view
(overhead: rooms may look larger)" with a warning; the walk skips the choice.
`eyeLevelCamera` stands a person 1.6 m up in that room (or its open-plan space), facing the
view's direction across the floor (turned up to 60° if the view ahead is under 2.5 m),
backed towards the wall behind but a step clear of walls, door leaves and furniture, and
not facing a tall piece (over 1.2 m) closer than 1.5 m, 70° across, tilted down 8°.
`Capture.renderFrom` in `Viewport.tsx` draws it with the same renderer and a temporary copy
of the level with ceilings (in their paint, unlit), lit as the walk is (no sun shadows, the
walk's sky and even light), reads the canvas, and puts the view's lights back and redraws it
before the browser shows a frame, so the screen doesn't move. If the eye-height picture
fails, "this view" stays, with a note. `e2e/render-scale.spec.ts`.

**AI model pickers (6 Nov, owner reports: Gemini 400 with gemini-3-pro-image; type-in model
names):** the AI assistant has two selects, "Model for plans and layouts" and, for OpenAI and
Gemini, "Model for pictures", stored per key as `model` and `imageModel` (`credentials.ts`;
`imageSettings()` uses the picture model, else `PROVIDERS[p].imageModel`). A saved key whose
one model was an image model (the owner's case: gemini-3-pro-image was being sent to plan
reading and Test as a JSON request) has it moved to pictures on load (`migrateKey`). Once a
key is typed (600 ms pause), the selects fill from the provider's own list with that key,
straight from the browser (`ai/models.ts`: Gemini `GET /v1beta/models`, OpenAI `GET
/v1/models`, Anthropic `GET /v1/models`), friendly names where given, best first, the default
marked "(recommended)" (Gemini: best listed Pro; pictures: the cheaper gemini-2.5-flash-image
and gpt-image-1, since every render costs; `priceNote` labels "cheaper" / "about 3× the
price"). A saved picture model, or the default a key saved before the choice renders with,
is never changed by saving again. OpenAI text models are an allow-list (chat-completions
models that take images); Gemini text models start `gemini-`. The selects keep the last list
while a changed key's is looked up, falling back per job. If listing fails, `CURATED` in
`credentials.ts` with a hint; a saved model not listed stays as "(saved)". Test checks the
plans model with JSON and the picture model without making a picture (Gemini `countTokens`,
OpenAI `GET /v1/models/{id}`), a line each; changing the provider, key or a model stops it.
Every failed provider call (trace, layouts, render, Test, listing) now shows what the
provider said (`failure`/`providerMessage` in `providers.ts`: `error.message`, cut to 200
characters, shown as text, with keys and tokens redacted: sk-…, sk_live_…, AIza…, AQ.…,
ya29.…, Bearer …, and long mixed-case or hex runs; lower-case model names stay): "Gemini
turned the request down (400): …". Gemini's 400 "API key not valid" counts as a refused key.
`input_fidelity: high` goes only to gpt-image-1 (`HIGH_FIDELITY`). A held Enter that closes
the render dialog doesn't reopen it from the button focus returns to. Only a 401 or the
provider's own "invalid key" is a key error; other 403s read "{Provider} refused the request
(403): …" (OpenAI's organisation verification, say), and OpenAI's Test says the picture model
only exists (verification may still be needed). Models show by name (the provider's, else
`MODEL_NAMES` or one made from an OpenAI id; a shared name gets "preview" or the id). The
render dialog keeps the model line and the Look select in its sticky foot, beside Render. In
the walk, the camera says "Render" (named "Photo-real render") and answers a second finger
while a thumb holds a stick (its own pointerup: browsers make no click of it); on phones on
their side (320 to 500 px tall) the map and the camera sit along the top beside the time,
clear of the sticks (`walk-render.spec.ts` checks 844 × 390, 750 × 342 and 568 × 320). The e2e AI specs abort
any provider request a test doesn't mock (`ai-models.spec.ts`).

**AI: suggested layouts (stage 2, 5 Nov):** "Suggest layouts with AI" in the plan's
Renovation section opens a brief (who lives here, eight common wishes, anything else) and
sends the flat as it is (`planForModel` in core: walls by id with the rooms either side,
locked ones marked, openings, rooms with areas; no image) to the model in use, asking for up
to three layouts as operations: remove wall, half wall, glass wall, add wall, add door (with
a style), remove opening, rename room (`ai/layouts.ts`, `LayoutSuggestions` schema).
`applyLayout` in core applies each with the app's own commands to a copy of Before; outside
walls, the household shelter's and bathrooms' walls and walls with windows are locked
(`lockedWalls`), windows can't be closed up, and whatever is refused is listed in words
("remove wall between Bedroom and outside: an outside, shelter or bathroom wall"). Each
option shows a small plan, its reasons and its change list (`renovationChanges`); "Use this"
makes it the renovation, starting one if there is none, as one undo step (`adoptLayout`),
then shows After. Each option keeps its operations and "Use this" applies them again to
Before as it is then. Next: a recorded real reading and real layouts as tests; the rules the
spec lists that aren't checked yet (bedroom windows, corridor widths, the work triangle).

**Wall colours and wallpapers (5 Nov):** a wall side's paint can be any colour (the
browser's colour picker, after the preset swatches; stored as `paint-#rrggbb`, `customPaint`
and `finish` in core) or one of eight wallpapers (`WALLPAPERS`: pinstripe, linen, fine grid,
herringbone, botanical, white brick, fluted wood, terrazzo). Wallpapers are drawn on a canvas
(`render/src/wallpaper.ts`, no downloads), tiled at 0.6 m on the wall faces (whose UVs run
in metres; the pattern restarts at each stretch between openings), and shown as swatches. No
schema change: a side's material id was already free text.

**People for scale (5 Nov):** the catalogue's People: a person 1.70 m and a child 1.20 m,
box-built in one grey (`person()` in furniture.ts, material `figure`), placed, moved, turned
and resized like any piece, and walked through rather than into.

**Glass walls and half walls (schema 7, 5 Nov):** a wall's `build` is solid (absent) or
`'glass'`: a framed glass partition (`glassPartition` in core: 40 mm aluminium frame round
each stretch between openings, mullions so no pane is over 1.2 m, a transom of glass over a
door; render draws the frame full thickness in `aluminium` and the panes 10 mm thick in the
shared transparent glass). A wall lower than the ceiling is a half wall; `glassAbove` adds
fixed glass from its top to the ceiling. Wall details: "Built of" Solid / Glass, "Half wall"
Full / 0.90 / 1.00 / 1.20 m, and the glass-above check. Plan: glass pale with a pane line,
half walls lighter with a tag "HW 1.00 m (+ glass)" (`WallTags`). Both still block walking. The
renovation diff counts a wall swapped for glass, cut down, or given glass above as hacked and
built again, and the change list says which ("Put up 2.40 m of glass partition", "Build … of
half wall, 1.00 m high, with glass above"). Schema 7 also adds `structural` (for HDB hacking
warnings, not used yet). Junction blocks take the tallest wall's height (aluminium where
only glass meets). Not handled yet: a window in a glass wall draws as a window; fixed glass
goes to the level's ceiling even under a room's lower one.

**Door styles (schema 7):** a door's `style`: swing (absent), double, sliding, pocket, bifold
or folding, with `panels` (a count for sliding, bi-fold and folding; else sized from the
width: `doorPanels`), `glazed` (clear or frosted leaves) and `stack` (which end leaves slide
or fold to). `doorLeaves(frame, opening, open)` in core gives every leaf's centre line at any
amount open, for every style: the plan symbol (leaves shut and a dashed slide for sliding and
pocket, half folded for bi-fold and folding, two arcs for double), the 3D leaves (each a box
`placeLeaves` moves to its pose; the walk's door swing drives it, `setDoorOpen`) and walk
collision (open leaves solid) all come from it. Door details: "Opens by", leaves/panels
stepper, Solid / Glass / Frosted, Flip side (for leaves that stack) or Flip hinge. Folding
partitions open on approach like any door. Sliding and pocket leaves travel only as far
as the wall beside the opening goes (a short wall leaves them part open). Panels are never
under 25 cm (bi-fold in pairs). The renovation change list names a door that now opens
another way or has glass leaves. Plan symbols: sliding has a travel arrow, bi-fold and
folding the first panel's sweep. A wall beside a room named "…shelter" warns that HDB
doesn't allow it changed; choosing glass makes a wall over 100 mm 80 mm thick. Not built yet
from the spec: the Play button, "Fill the wall", and tap or E to open a wide partition.

**Comparing in 3D:** with a renovation, the 3D view offers "Compare before and after": the
flat as it is left of a divider and the renovation right of it, in one view with one camera
(`CompareRender` in `Viewport.tsx` takes over drawing: each frame draws the scene twice, each
time cut to its side with the scissor; the two versions are their own `LevelMesh`es). The
divider drags by its handle (or the arrow keys, as a slider); walking shows one version and
the comparison comes back after. Each side is lit by its own lamps, the nearest four each
so the two stay within the budget of eight (the other's are turned down for that pass, not
hidden, so the count of lights and the shaders stay the same).
Outside the frame the version picked above the plan shows and is the one named `level`, so a
3D download while comparing draws that one. The divider sits under the view's buttons; Home,
End, Page Up and Down move it too; a side under 90 px loses its label; its handle is a 44 px
target, white with a dark edge for night and dark mode. Comparing ends with the renovation.

**Downloads (Phase 4):** the project menu's Download section (`exports.ts`): the plan as a
PNG (the plan SVG cloned with its computed styles inlined, handles and grid removed, the plan
image inlined as data, drawn at 3× on a canvas), Print (the same picture on its own page;
the print dialog saves a PDF), the 3D view as a PNG (drawn on demand through `Capture` in the
Viewport and read at once), the 3D model as GLB (`GLTFExporter` on the level group, models
included) and the project file (JSON). "Open a project file…" loads one through
`loadProject` as a new plan. A download that needs the plan or 3D shows it for a moment and
puts the view back.

**Version history (Phase 4, before accounts):** the API lists and serves the copies R2 already
keeps of each version a save replaced (`GET /projects/{id}/versions`, `…/versions/{n}`;
`store.HistoryStore`, in R2 and memory; not for view-only links). Autosave makes a version
every few seconds, so `historyPoints` offers the end of each editing session (a version that
stayed current 5 minutes or more), up to 20, newest first. "Version history…" restores one
with `restoreVersion`, one undoable step. Copies expire after 30 days (the bucket rule).

**Duplicate:** Ctrl/Cmd+D or the details' Duplicate sets a copy one width along the piece
(`duplicateOf`), selected.

**Your plans:** the project menu's "Manage your plans…" opens a dialog listing this
browser's plans (the recent list, up to 20): open one, delete one (with an inline confirm), or
Clear all. Plans this browser owns (owner key, or a local-only plan: `ownsPlan`) are deleted
on the server, which keeps its 30-day recovery copy; plans shared with it are only taken off
the list. Sample copies (`RecentProject.sample`, or older ones named "… (sample)") are kept
and can't be deleted: the most recently opened sample copy is kept (`keptSample`), and older
copies (from another "New copy of the sample flat") can be deleted. A link to a missing plan
opens the kept sample rather than making another copy. Deleting the open plan opens the
newest one left, or a new sample.
While a dialog is open the plan's keyboard shortcuts are off.

**Still open:** latitude and place aren't editable in the UI; lamps are always on. Ceiling
lights move with `setCeilingHeight`. Walking at night is lit by lamps, with only a faint fill.

**Furniture models (Phase 3c):** `tools/models` (a workspace package) builds them:
`pnpm --filter @dhd/models build [ids…]` reads `catalogue.json` (Poly Haven asset, our id,
name, category, placement flags, an optional `turn` to face +Z, triangle budget), downloads
each 1k glTF, centres it on its footprint with its base at 0, simplifies above 40k triangles,
shrinks textures to 512 px WebP, compresses with meshopt, and writes
`apps/web/public/models/<id>.<hash>.glb` (19 models, 3.7 MB, cached immutable) and
`packages/core/src/modelKinds.generated.ts` (sizes measured from the models). Core adds them
to `FURNITURE` with a stand-in box (`placeholder`); render's `ModelLibrary` loads each GLB
once and `LevelMeshes` swaps the box for a copy when it arrives (copies share geometry, marked
`userData.shared`). No modern beds or TVs on Poly Haven, so those stay box-built.
Rebuild a few with `pnpm --filter @dhd/models build <id…>` (`built.json` remembers the rest).
51 models since 31 Oct (25 added, chosen for a Singapore flat: a rolled-arm leather sofa; a
rosewood set of Chinese armchair, daybed, tea table, stool, console, display cabinet and a
folding screen; a backed bar stool, a metal-and-wood stool, the plastic monobloc chair, a
bistro set and a folding stool; a chest of drawers, narrow steel shelves, wicker baskets; an
enamel pendant and a pipe desk lamp (both lit); three white vases, a photo frame, a framed
picture, an alarm clock and a chess set). Left out: models the simplifier can't bring under
12k triangles (a wooden bar stool, a game console), the book set (no glTF), plants that come
as several variants in one file, and the antique and gothic pieces. A catalogue entry's `drop`
names a material whose parts are left out (the frames' glass, which hid the picture once its
texture was compressed); oversized models are scaled (the Chinese cabinet came 2.9 m tall,
the drawers 1 m deep).
26 models since October (seven added: a leather ottoman, a steel-and-wood side table, a tall
side table, a round pedestal table, a metal desk, steel-frame shelves and a tabletop
succulent). Most of Poly Haven's other furniture is antique or ornate. A catalogue entry's
`scale` shrinks a model that comes larger than a flat's furniture (a number, or
`[across, up, deep]`; the desk and shelves are only narrowed).
**Thumbnails:** `pnpm --filter @dhd/models thumbs` serves `apps/web/thumbs.html` (dev only,
not in the build) with Vite, renders every catalogue piece through `LevelMeshes` and the
model library, and writes 96 px WebPs to `apps/web/public/models/thumbs/`; the catalogue
shows them. Re-run it after changing the catalogue.
Kept cheap to draw (acceptance round 10 measured 0.66 fps in software rendering with all 19
placed, now about 3.3): the pipeline drops refracting glass (`KHR_materials_transmission`,
which makes three.js draw the scene twice a frame) for plain transparent glass and caps
models at 12k triangles; `ModelLibrary` draws opaque materials front-side only and lets only
pieces over 0.5 m radius cast shadows. Lamp models' shades glow (`glow` in the catalogue);
a model that fails to load is retried after 5 and 30 seconds.
**Next:** more models (Sketchfab CC0 needs an API key).

**Accounts (Phase 4, Google sign-in on D1; built, off until the owner's Google client is
set):** the edge Worker answers `/api/auth/*` and `/api/me/*` (`apps/edge/src/auth.ts`):
Google's OAuth code flow with PKCE and a signed, short-lived state cookie; a 30-day
`dhd_session` cookie (HttpOnly, Secure, SameSite=Lax; only its SHA-256 stored); and the plans
a person keeps (`user_projects`), with their owner and edit keys sealed by AES-GCM under
`KEYS_SECRET`. D1: `dhd-auth` and `dhd-auth-preview` (`apps/edge/migrations`, applied with
`wrangler d1 migrations apply <db> --remote [--env preview]`). Sign-in starts only from an
origin matching `AUTH_ORIGINS`. In the app (`account.ts`): a Sign in button when the server
says sign-in is on; once signed in, every plan opened (not view-only) is kept with the
account and the account's plans (and keys) join this browser's list, so another device opens
them as owner; deleting a plan forgets it there too. **To switch it on:** set
`GOOGLE_CLIENT_ID` in `apps/edge/wrangler.jsonc` (both environments) and redeploy, and the
secrets `GOOGLE_CLIENT_SECRET` and `KEYS_SECRET` (any long random string) on dhd-api and
dhd-api-preview (see §5).

**Getting started (Phase 5):** a new blank plan gets a guide bar over the stage (`ui/Guide.tsx`,
`guide.ts`): add a floor plan, set its scale, draw walls round a room, walk through. Each step
ticks off as it happens (a picture, a "Calibrate plan image" step this session or any walls,
a room, a walk), one at a time with a button for its tool; it ends with "That's the basics"
or when closed, and is remembered per project in this browser.

**Errors and usage (Phase 5, no third party):** the app posts to `/api/telemetry`
(`telemetry.ts`, sendBeacon): unhandled errors and ErrorBoundary catches (message, stack,
path; ten a visit), and usage events once a visit each (`open-sample`, `new-plan`,
`upload-plan`, `calibrate`, `first-wall`, `first-room`, `walk`, `furnish`, `renovation`,
`share`, `download`, `restore-version`). The edge Worker answers it itself: errors to its
logs (Workers observability), events to Analytics Engine (`dhd_events`, `dhd_events_preview`;
event, detail, country). No project ids, plan content or personal data. Query:
`curl -X POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data "SELECT blob1 AS event, SUM(_sample_interval) AS n FROM dhd_events WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY event"`.
The Go API logs it locally (`POST /telemetry`, 204).

**Drawing and editing, acceptance round 11 (fingers first, mid-gesture checks):**
- Every drag draws from where it began, with a mouse as with a finger (a press is resolved on
  release: a click places a corner, a drag draws the wall or room); the wall, room, scale
  line and measurement all preview mid-drag.
- `useCornerHandles` (drawTools): the corners of the wall or room just drawn are handles; a
  press drags the corner (live lengths, snapped, settled, one undo step), a tap on a wall end
  carries on drawing from it. In the Room tool, a drag from a corner just drawn that heads away
  from that room draws the next room from the corner (sharing its wall); one heading into it
  adjusts the corner (`intoRoom`, decided once the drag has gone 8 px). The drawing bar's Undo also takes back an end dragged.
- A tapped first corner shows as a marker. Measure ends can be dragged; a tap starts afresh.
- In the Door/Window/Opening and Furniture tools, a press on an existing piece of that kind
  goes to Select for the gesture (a drag moves it), via `placing()` in `PlanCanvas`.
- Delete room (`deleteRoom`, `roomOwnWalls`): takes down the walls only it has; a room whose
  walls are all shared says to delete one of them instead.
- Corners are 32 px targets on touch screens; the scale bar lets drags through; a swipe in a
  walk moves the scene with the finger; the guide is worded for phones too, keeps a fixed
  height, and step 1 offers "Draw instead".
- **Panning (31 Oct, owner: "unintuitive on mobile"):** a one-finger (or mouse) pan moves the
  view as it is now (`liveView`), not as of the last render, so the plan stays under a fast
  finger (it used to lose the moves between renders and slip behind); a finger let go while
  moving coasts and slows to a stop (`fling` in `PlanCanvas.tsx`: speed smoothed over the last
  moves, capped at 2.5 px/ms, two thirds lost every 325 ms; only after 40 px of real panning,
  so not from what's left of a pinch; it stops before the plan leaves the screen (48 px of
it, or all of a smaller plan, stays in view, unless the coast is bringing it back; a plan
of one straight wall counts as in view while the wall's line is),
  when anything else moves the view (Fit), and at any press or wheel, and a tap that stops
  it does nothing else); one finger left down after a pinch pans on; in 3D, two fingers (or right-drag) pan over the floor
  (`screenSpacePanning={false}`) rather than up and down the screen.
- Dragging a whole room: built since (**Moving a room** below).

**Magnifier:** while a finger places a point (Wall, Room, Measure, Set scale, or dragging a
corner in Select), a 2.5x loupe shows the plan under it with a crosshair, above the finger or
in a top corner away from it near the top, or after a 250 ms hold (`Loupe` in
`PlanCanvas.tsx`). It is a `<use>` of the scene group
(`plan-scene…`), so plan CSS must not depend on ancestors outside that group: a `<use>` copy
matches selectors from its own root (hence `[id^="plan-scene"] *` beside `.plan-svg *`).

**Moving a wall:** in Select, a wall already selected drags sideways (along its normal, 1 cm
steps, 1 mm with Alt) through `shiftWall` in core (`shiftWall.ts`), applied afresh to the level
as the drag began on every move:
- Walls joined at its ends follow, keeping their far ends; their doors and windows keep
  their distance from those far ends.
- Where the wall carries straight on into another, that one stays put and a short step
  joins them (`shiftIds` names the step's corner and wall up front).
- `shiftBlocked` stops the move before it comes within the two walls' half thicknesses of
  another wall (measured between faces), before a following wall turns back on itself, and
  before the moving end reaches a door or window on a following wall.
- Corners settle at the end, in one undo step; back where it began, nothing is kept. Escape,
  a cancelled touch or a second finger takes it back. A second click that never moves still
  splits the wall (double-click).
- Dragging a wall not selected still pans, by mouse or finger. The distance moved shows
  beside it (`.wall-shift`, in mm for an Alt move).

**Moving a room:** a selected room shows a move handle (a four-way arrow in a circle, placed
inside the room clear of its label, door swings, furniture and corners where it can be, else
just inside the room, and not at all in a room too small for it on screen: `roomHandleAt` in
`plan/layers.tsx`; a press on the drawn handle beats a corner or a piece under it). Dragging it, by mouse
or finger, moves the room (1 cm steps, 1 mm with Alt); the arrow keys move a selected room too
(1 cm, 10 cm with Shift). A drag elsewhere in the room still pans. Core: `moveRoom.ts`, applied
afresh to the level as the drag began on every move (vertices, wall ends, rooms, furniture and
openings put back first, anything added before dropped):
- The room's corners, everything inside its outline (walls, enclosures, furniture by centre)
  and the doors and windows on its walls go with it (`planRoomMove`).
- A room standing alone moves anywhere. A room joined to others (`roomJoined`: a wall with
  one end on it) moves along one axis at a time, the one the pointer has gone further (with
  some hysteresis), so no joined wall slants:
  - joined walls running the way it moves stretch or shrink;
  - where one runs across the move, its corner stays and the room's walls leave it with a
    short step along the move (`steps`). Walls at that corner running the way it moves,
    towards where it goes, leave with them, so a step never lies along another wall; the step
    copies the wall it continues, running the same way (side and faces match);
  - a corner on a straight stretch of the room's wall running the way it moves stays as the
    wall slides through it (`stays`);
  - shared walls move with the room, so neighbours grow or shrink;
  - a wall shrunk to nothing (a step taken back) closes up, its ends merging, so moves are
    reversible one after another (arrow presses plan each move afresh);
  - doors and windows on a wall with one end moved keep their distance from the end that
    moved on the room's own walls (they go with the room), from the end that stayed on walls
    joined to it.
- `moveBlocked` checks the moved geometry (a scratch copy): no wall closer to another than
  their half thicknesses (unless joined at a corner or by one wall, or already that close and
  not getting closer), no wall turned back or shrunk past its doors, and no room squeezed out,
  merged or squeezed thinner than about 0.3 m (twice its area over its perimeter; one already
  that thin may not get thinner). About 0.3 ms a check on the sample.
  `moveTowards` checks every centimetre to the pointer and, moving freely, slides along a wall
  in the way; stopped, it goes on to where a shrinking wall closes up exactly, if that lies
  within the last centimetre, rather than leaving a stub of a few millimetres.
- One undo step per drag; back where it began, nothing is kept; Escape, a cancelled touch or
  a second finger takes it back. The distance shows under the handle (`← 0.45 m   ↓ 0.10 m`),
  with "· stopped" when something stopped it short of the pointer ("Can't move this way" if
  it couldn't move at all). Shift pressed between arrow presses keeps the run (one undo step).
- Not handled: corners merging where a move lands them on another corner or wall (nothing is
  settled at the end); a room with a closet carved into a corner counts as joined (the
  closet's outer corner is off its outline), so the closet stretches rather than moving.

**Door and window clearances:** while one is dragged (Select or its own tool), the clear wall
on each side of it to the inside corners shows as a dimension off the wall
(`openingClearances` in core: from where both faces have begun, past a joining wall), on the
side a door doesn't swing to; a door dragged stays between the inside corners.

**Furniture handles:** a selected piece shows four corner handles and a turn handle in front
(`itemHandles` in `plan/tools.tsx`), in Select and in Furniture straight after placing (the
`placing` wrapper routes a press on a handle to Select). A corner resizes with the opposite
corner fixed (1 cm steps, 1 mm with Alt; size shown mid-drag); the turn handle faces the piece
at the pointer in 15° steps (free with Alt). One undo step per drag; a finger takes a handle at
once (`grabs`).

**Phone on its side** (`orientation: landscape` and height ≤ 500 px, in `styles.css`): a thin
top bar, a one-line sample notice, the tool rail at the left (it scrolls), and the details as a
column that folds to a vertical tab at the right; walking hides the rails, the notice and the
hint and shrinks the mini-map. `e2e/landscape.spec.ts` checks it at iPhone 13 landscape.

**Wall tool on phones:** a finger drag previews the first wall (and a room, in Room) from where
it went down (`ToolController.move`'s `dragFrom`); the last wall's ends show as handles, and a
finger on one drags that corner (`grabs`; snapped, settled, one undo step) instead of drawing.

**Walk-through link:** Share offers `?p=<id>&walk=1`, which opens the plan straight into a
walk (once; the parameter is then dropped from the address).

Poly Haven (CC0, reachable from here) has about 136 indoor models for later; Kenney is
blocked by the network proxy and Sketchfab needs an API key.

## 6. Next

**Finish Phase 1**, in order:
1. **Public-deployment safety:** sharing and recovery copies are done (see §4). A visitor may
   start at most 40 plans a day (`apps/edge/src/quota.ts`), on top of the per-minute limits:
   counted in D1 (`create_quota`, migration `0002`) by an HMAC of the day and address under
   `KEYS_SECRET`, pruned after two days, and failing open (logged as `quotaUnavailable`) while
   the table is missing. Writes whose path holds a `%` are refused, since the API would decode
   one past these checks. A visitor refused by the cap (a busy shared network) gets their plan
   kept in the browser instead (`createFrom` in `store.ts`). Migration `0002` is applied to
   both databases (31 Oct). Until `KEYS_SECRET` is set, addresses are hashed with no secret.
2. **Room matching by overlap (looked into, not adopted):** rooms are matched across edits by
   label point and shared corners. Sampled area overlap was tried; it gave the same results on
   splits, merges and a closet drawn mid-room (now a test), and disagrees only on odd shapes
   where either answer is defensible, so the cheaper rule stays.

**Phase 2, first-person walkthrough (first cut built):**
- **What's built:**
  - "Walk through" in the 3D view starts walking in the largest room, facing its longest view
    inside the flat (`walkStart`).
  - Movement is WASD or the arrow keys, with Shift to run, plus a thumb stick on touch screens.
  - Clicking the view gives mouse look under pointer lock. Dragging to look works everywhere.
  - Esc or "Leave walk" returns to the previous view.
  - Ceilings are on while walking.
- **Collision:** it is 2D, in core (`walk.ts`). The walker is a 0.2 m circle sliding against the
  edges of the plan's wall pieces and hubs. Door and passage gaps are open, windows are closed,
  and room boundaries never block. This replaces the planned three-mesh-bvh capsule, because a
  single floor needs no 3D collision and this one is unit-tested. Revisit it if stairs or
  furniture collision arrive.
- **Outside openings:** doors and openings to the outside (with a room on one side only)
  block like windows, so the walk stays inside the flat.
- **Mini-map:** a small plan in the corner while walking shows where you are and which way you
  face (`walk/MiniMap.tsx`).
- **Field of view:** set across the view, not up and down (three.js's `fov`), so a narrow
  view (the split screen, a phone held upright) gets the same width across as a wide one:
  110° by default (people see about 114–120° across with both eyes), 60–120° on the "View"
  slider under Time while walking, on every screen, remembered per browser (`walk/fov.ts`,
  `verticalFov`, key `dhd-walk-fov-2`). Up and down it may reach 150° (a phone held upright at
  120°). Until 5 Nov it was capped at 100° up and down, which cut a phone held upright to
  about 57–70° across; the owner found that too narrow.
- **Looking:** a drag (finger or mouse) turns the way it moves, as in a game: right looks
  right, up looks up (until 5 Nov a finger dragged the scene, as Street View does; the owner
  found that backwards). On touch screens a second thumb stick, bottom right, looks around
  (`Joystick look`, `lookStick` in `WalkControls`: squared response, 2.2 rad/s at full tilt).
- **Doors and footsteps (built):** inside doors stand open in the orbit view; walking
  through, they start shut, swing open within 2 m of the walker and shut beyond 2.8 m (open in about a third of a second, so a run doesn't catch them half shut)
  (`useDoorSwings` in `Viewport.tsx`; render builds each inside leaf as a group pivoting at
  its hinge, `LevelMeshes.doors()` / `setDoorOpen`). A shut leaf sits flush with the face it
  hinges on. Collision is unchanged (doorways open, an open leaf solid). Soft footsteps,
  synthesised with Web Audio (`walk/footsteps.ts`), play with each step, louder running;
  "Footsteps on/off" in the walk view, remembered per browser.
- **Built since:**
  - door leaves in 3D (`doorLeaf` in core): open square to the wall on the swing side as the
    plan symbol shows, and solid to the walker; doors to the outside (`outsideOpenings`) are
    shown shut;
  - a gentle head bob (none with reduced motion);
  - the next walk resumes where this browser last stood in that project, unless the plan
    changed under that spot (`walk/pose.ts`, localStorage).

`LevelMeshes` already gives one mesh per wall, with `userData.wallId`. The plan doc has the
algorithm notes and the checklists for Phases 3 to 5.

## 7. Conventions

**AI runs that survive a locked phone (owner, 8 Nov).** Approved: (1) designer runs resume from their last finished step when the tab comes back, with a screen wake lock while running; (2) opt-in cloud runs: the key is sent to our server for that run only, held in memory (never stored or logged) and wiped at the end; (3) storing keys on the server may be BUILT, but must stay disabled (flag off, not exposed) until the owner has finished setting up Google sign-in (#21). Do not enable (3) before the owner says so.
Owner answers on #56: the consent wording is fine and a privacy notice page is needed before cloud runs reach production; agents may generate and set the push (VAPID) secret; production stays off until the owner has tried a cloud run with a real key; no rate limits or quotas (own key), but every cloud run shows estimated tokens and cost and asks to confirm.

**Check main after every merge (owner, 8 Nov).** A green PR is not enough: after a squash merge, watch the `ci` run on `main` to the end and fix a red one at once. Main went red after #48, #51 and #52 (e2e: `exact.spec.ts:99`, `elevation.spec.ts:238`, `guide.spec.ts:33`) without anyone noticing until the owner did.

**Never go idle (owner, 7 Nov).** This session only wakes on a message, a finished agent or
command, a PR event or a scheduled check-in, so a turn that ends with nothing running stops all
work until the owner prompts. After a merge, start the next roadmap item (spec, design or
build agents) in the same turn. Before ending any turn, make sure something is running or a
check-in is scheduled (`send_later`). A merge is not a stopping point.

**Acceptance testing method (owner, 30 Oct: "add more testing methods").** Basic phone
interactions got through earlier rounds (no wall preview under the finger; no way to adjust
a wall just drawn). Every acceptance round now does all of these, and reports a missing
affordance as major:
1. **Fingers only on a phone profile** (CDP touch events; no keyboard, no mouse), and the
   same tasks with a mouse on desktop.
2. **Mid-gesture checks:** for every drag (draw, move, resize, look around), a screenshot
   while the finger is still down. Feedback must show before the lift.
3. **Make it, then fix it:** after creating anything by touch, adjust it by touch: in the
   same tool straight away, and in Select. Undo each step.
4. **First use:** start from "New blank plan", not the sample, and follow the
   getting-started guide as a newcomer would.
5. **Slow device:** repeat the touch tasks with CPU throttling
   (`Emulation.setCPUThrottlingRate`, rate 4) to surface lost taps and merged moves.
6. **Expectations:** for each step, write what a person used to phone apps would try next,
   then try it.
The e2e suite follows the same rules for the phone (`mobile.spec.ts` checks the first wall's
preview mid-drag and drags its end).

**E2e specs import `test` and `expect` from `e2e/test.ts`, not `@playwright/test` (8 Nov; Biome
refuses the latter in `e2e/`).** Its `test` closes every browser context a test opens itself
(a second person on a share link). Playwright closes only the one behind `page`, and each one
left open stays in the worker's browser for the rest of the run; in Split or 3D view its 3D
view draws every frame in SwiftShader. That was why `main` went red after #41: with two such
pages in its browser the exact render's first sample never came (36 s without them); a view
link's first paint missed its 10 s and the guide's close click hung for 60 s (2.4 s without).
`contexts.spec.ts` checks that a context a test leaves open is gone by the next test.

- Every document mutation goes through a `Command` in `packages/core/src/commands.ts`.
  UI code never mutates the project directly.
- Generate ids outside the recipe (as `addWall` does) so recipes are deterministic and
  the caller knows the new ids.
- Geometry lives in `packages/core` with unit tests. `packages/render` only converts to
  three.js.
- When the schema changes: bump `SCHEMA_VERSION` in `schema.ts` **and** `SchemaVersion`
  in `apps/api/internal/project/project.go`, add a migration in core, and regenerate
  `apps/api/internal/project/testdata/hdb4room.json` from the fixture.
- TypeScript is strict with `noUncheckedIndexedAccess` on. Biome formats with single
  quotes, 2 spaces and 100 columns. Go code is gofmt-clean.
- Commits are small and imperative.

- Front-end work follows the vendored taste-skill: run `inspect.mjs --app` on the
  production build and look at the screenshots. In this container Chrome needs a wrapper that
  adds `--no-sandbox` (set `CHROME_PATH`).

## 8. Commands

```sh
pnpm install
pnpm dev                                 # web on :5173, proxies /api to :8080
pnpm test | pnpm typecheck | pnpm lint
pnpm --filter @dhd/web e2e               # Playwright: builds, starts the Go API in memory
cd apps/api && go run ./cmd/api          # file store in ./data (STORE=memory to skip disk)
cd apps/api && go test -race ./...
# live R2 contract test (use the dhd-test bucket only; it deletes everything it lists)
R2_TEST_ENDPOINT=https://<account>.r2.cloudflarestorage.com R2_TEST_BUCKET=dhd-test \
  R2_TEST_ACCESS_KEY=... R2_TEST_SECRET_KEY=... go test -run TestR2Live ./internal/store
# API Worker + Container (needs Docker and CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID)
pnpm --filter @dhd/edge run deploy           # production: dhd-api
pnpm --filter @dhd/edge run deploy:preview   # previews: dhd-api-preview
```

**A schema bump deploys both APIs** (`deploy` and `deploy:preview`), then checks each with a
POST of `testdata/hdb4room.json` (a fresh id) through its own Pages host. Branch previews
route `/api` to `dhd-api-preview`: left behind at schema 7, it refused every save from a
schema-10 preview ("schemaVersion 10 not supported (want 1-7)"; owner, 6 Nov).

**Cloudflare resources:**
- **Pages:** the `dream-home-designer` project, Git-connected. It binds `API` to `dhd-api` in
  production and to `dhd-api-preview` in previews.
- **Workers with Containers:** `dhd-api` and `dhd-api-preview`.
- **R2 buckets:** `dhd-projects`, `dhd-projects-preview` and `dhd-test`.
- **Bucket-scoped tokens:** `dhd-api-r2-production` and `dhd-api-r2-preview`. Their S3 credentials
  are set as Worker secrets `R2_ACCESS_KEY` and `R2_SECRET_KEY`.

## 9. Known gaps and debts

- **Links are the capability.** A project is readable by anyone with its link; editing needs
  the owner or an edit key. Listing is off in production, and writes are rate-limited (and
  capped per day). Google sign-in is built and off until the
  owner configures it.
- **One plan image per project on the server.** Replacing it drops the old one, so undoing a
  replacement shows the old image only in browsers that still have it locally.
- **Flaky phone e2e:** the first test in `mobile.spec.ts` used to fail about one run in four
  locally (CI retries once); it has passed 20 runs in a row since (31 Oct). Another, the
  room-handle test, failed whenever the plan opened at a smaller zoom (the room's move is
  stopped by a wall 0.55 m on, under 10 px there, and the pan's start landed off the room):
  it now expects 5 px and picks a spot that hits the room. When the Add tap or the
  finger-drawn room doesn't land, the run is slow. Four real causes were found and fixed on the way: Add was `disabled` until the
  typing re-rendered (a quick tap was dropped); a busy page merges a quick drag's moves into
  the lift (the plan and the walk now play the lift's position as a last move); and the orbit
  controls left `touch-action: auto` on the 3D canvas, so a phone cancelled sideways swipes
  in walk mode (the owner's "can't look around without moving"). Swipe-to-look turns half a
  circle per screen width on touch. Three more (6 Nov), all from timing a busy page: the plan
  timed double-clicks and flings by when its handlers ran, not by the events' `timeStamp`
  (a slow redraw after the first press made a double-click two clicks; a late lift lost the
  coast); a remounted plan (Before/After) drew one frame at size 0 until its ResizeObserver
  reported, and a requested fit used the old size; a double-click on a small room landed on the
  move handle its first click showed. The swipe e2e stamps its touches with the finger's times.
- **Wall tool snapping:** a point landing inside a door or window moves to the nearer jamb
  (`jambSnap` in `snap.ts`), so an angle-snapped wall drawn to a doorway slants by up to half
  the door's width. The alternative, ending the wall straight but short of the doorway and
  unjoined, leaves the room open; not decided.
- **Placing on furniture:** a piece that stands on others or hangs above them (the succulent,
  the desk lamp, ceiling lights) is placed by a click on a piece as anywhere else (`over` in
  `placing()`, `PlanCanvas.tsx`); a tabletop piece (under 1.2 m: a lamp, the succulent, the
  TV) stands on the top of the highest floor or tabletop piece under the point (`standsOn`
  in core: so under a wall cabinet, on the desk beneath it), higher ones (a wall cabinet)
  keep their height; a press on a piece of the same layer (`furnitureLayer`: ceiling, high,
  tabletop, floor; a lamp with a lamp picked, a light with a light) selects it, one on a
  piece of another layer doesn't (switch to Select for that).
- **Corner dimension lines** for walls that run into the room draw inside it; fine at plan scale,
  busy on short walls.

**Structural and shelter walls (5 Nov, spec `docs/specs/structural-walls.md`):** core
`structural.ts`: `wallStatus` (shelter from the room beside it, whatever the mark; structural
when marked; `likely` when unmarked and 200 mm or thicker), `wallStatuses`, `markStructural`
(both versions, one undo step), `sidesOf` (moved from layouts). The sample marks its 200 mm+
walls structural and the rest not. `renovationBreaches(before, after)` lists Before walls a
renovation hacks, moves, thickens, cuts down, glasses or cuts an opening into (or closes,
moves, restyles one in); `renovationChanges` marks such lines `guard`. The store checks every
edit made in After (cached per level): a new shelter breach isn't committed ("Household
shelter walls can't be changed…", toast without Undo, so a drag stays put); a new structural
one is kept with a warning and Undo. Before stays free. Plan: structural and shelter walls
hatched (`#structural-hatch`, in metres, in PNG/print too). Inspector: a Structural wall
switch, a Yes/No suggestion for a likely wall, the shelter note; plan details: "N walls look
structural [Mark them]" (Before). The change list adds "(structural)", a count banner and the
permit note (and Copy list). AI layouts lock structural and likely walls. No schema change.

**Clearance checks (5 Nov, spec `docs/specs/clearance-checks.md`, slice 1):** core
`clearance.ts`: `CLEARANCE_RULES` by catalogue id (wardrobe 0.60 m in front, drawers 0.75,
desks 0.80, fridge and kitchen cabinets 0.90, washer 0.70, toilet 0.60, vanity 0.70; queen
and king beds 0.60 each long side, single beds one side), `clearanceIssues(level)` →
`zone` (room short off a side, measured to the nearest wall, hub or floor piece by clipping
them to the zone), `door` (a floor piece in a door's sweep: `doorSweep` hulls `doorLeaves`
sampled shut to open, every style), `overlap` (> 20 mm; seats under tables and desks
allowed) and `wall` (> 10 mm into a solid wall piece). Rugs, people and pieces off the floor
are left out; cabinets of one connected kitchen run don't block each other. Bounding-box
pre-checks; about 5 ms for 80 pieces packed into the sample. Web `clearance/clearance.tsx`:
`useClearanceOn` (remembered, key `dhd-clearance`), `issuesOf` cached per level,
`ClearanceLayer` over the plan (red dashed zones and sweeps, red footprints for clashes, the
selected piece's clear zones faint; `data-export="skip"`), the Inspector's Clearances section
for a piece, and in plan details the switch, the count and Show next. Advice only: no edit
is blocked. Review fixes: a bed's sides count from the foot to the bedside table; barn doors' slides
are checked (leaves have thickness); a U kitchen's arms block each other, an L's legs don't;
windows count as wall for "into a wall"; overlaps over 40 mm (a snap's rounding is fine);
walls, hubs and sweeps cached by the walls/vertices/openings objects; Show next remembers
where it was (`useClearanceOn.shown`) and centres the piece; the Clearances section is first
in a piece's details. Not yet (spec): labels in the plan, live zones for the piece being
placed (before it's dropped), zones cut at walls, the drop announcement, walkways and the
rest of slice 2.

**Clearance checks, slice 2 (6 Nov, spec `docs/specs/clearance-checks.md#slice-2`; design
notes from the tech lead and UX bind where they refine it):** no schema change. Core
`walkway.ts`: `walkwayReport(level)` → `{status ('ok' | 'no-main-door' | 'issues'), start,
routes (every room and bed side checked: need, capped, have, ok, pinch, path, blamed),
issues, grid}` and `walkwayStatus`. The rooms are rastered (`grid.ts`) at 50 mm, coarser past
300k cells; obstacles are wall pieces and hubs (half and glass walls too), windows, room holes,
outside the rooms and floor pieces (`blocks`), filled by cell centre plus every cell an edge
crosses so thin glass stays closed. An exact distance transform (Felzenszwalb, keeping each
cell's nearest obstacle) gives each cell a width (2 × distance); doorways and passages get a
throat (span × wall + 0.45 m each side) whose cells are twice their exact distance to the
nearest piece (walls don't count there), else wide; a pinch measured in a throat needs at most
the span less 0.02. A bucketed (10 mm) maximin search from the main door's throat
(`entranceDoor` in `delivery.ts`: the first `mainDoors` only if it leads outside) finds each
room's widest way, a room counting as reached only past its doors' throats; where the raster comes within 0.10 m of the need, the narrow stretch is
measured exactly (nearest polygon, then the nearest on the far side, or where the rooms end on
the raster when no wall is drawn there; their sum). The need is
0.90 m, 0.60 m to a room only reached through a room with a bed (an en-suite) and to bed sides
(`bedSides`: the slice 1 zones with room, a single bed's better side, from the bedroom's doors
to the rest of the flat, not its en-suite's; the bare searches kept per room);
never more than the flat's own widest way to that target less 0.02 (cached per target with
the bare raster, keyed by walls, corners, openings and rooms). Blamed: the pieces either side
of the pinch; for a closed way, those standing in the bare way (else those narrowing it); for a
wall-to-wall pinch, those narrowing the bare way. One issue per piece and pinch (routes held up
by the same pieces at the same need merge, the narrowest shown), `to` listing every room and
bed side beyond it. About 20–30 ms on the sample with 40 pieces (timing tests take the median
of 7 runs: the spec's bounds under `PERF=1`, three times them otherwise). `clearance.ts`: dining chairs (`DINING_TABLES`/`DINING_CHAIRS`,
`chairsOf`, a chair within 0.30 m of a table) need 0.75 m from the table edge through the
chair's centre (`side: 'back'`); `clearance-doors.ts`: `doorClashes` (sweeps overlapping
> 20 mm, cached with the walls) and `doorFrontIssues` (`REACH` of hinged fronts, the fridge's
its width; skipped where slice 1 already has the piece in that swing); `issueItem` (a `doors`
issue has no piece); polygon helpers moved to `convex.ts`. Web `clearance/walkways.ts`: a
store outside React runs the report on a 100 ms trailing timer while a pointer is down (250 ms
if a run takes over 30 ms), at once on release or any other edit, and counts releases for the
announcement. `clearance.tsx`: `useClearanceIssues` merges per-frame issues with the last
report; `ClearanceLayer` (now given geom, view and size) draws pinch bars with end ticks, chips
("0.62 / 0.90 m", 11 px at any zoom, placed in order selected piece's zones, its pinches,
then others by shortfall; skipped if they would cover another or leave the view; room names
avoided by trying each side and beyond the bar's ends), the selected piece's narrowed way
dotted (hidden while Show the way is drawn), a table's chairs' zones with it, clashing sweeps
and hit fronts. Inspector lines worst first; a door's Clearances section; "Add chairs to check
the room to sit."; doors named by the smaller room they join. Plan details: "N pieces and M
doors are short of room or in the way" (the UX wording, not the spec's "N clearance problems";
Show next goes through pieces, then doors) and the walkway line. The live region adds ". "
and the first problem after a drop, 500 ms after a nudge, or "No clearance problems." when
fixed. `--clearance` token; `.warning-text` and `.clearance-clash` dark colours. E2e
`clearance-walkways.spec.ts` (desktop and a 390 px phone by finger). Not yet (slice 3):
editable numbers, Fix it, sliding fronts, a saved main door, zones cut at walls; the
contractor sheet has no walkway pinches by design.
QA fixes (6 Nov): a closed way's bar spans the doorway a piece fills (else the bare way's
cross-section just before the piece); a pinch's bar is as long as its label; chips avoid the
selected piece's corner and turn handles (spots further out and beside the zone's corners) and
a pinch chip matching a zone chip close by is dropped; a door hit by a piece's front counts and
is visited by Show next, which zooms a door's clash to a third of the plan; a front only hits a
door's swing in its own room; the walkway line looks for the main door on the other levels of
the version shown; issues and the walkway line list rooms worst first (a room before its
en-suite); bed sides name their room when there are several beds; door names and plan geometry
are cached by walls/openings/rooms. Drag p95 on 21 pieces: 16.7 ms on, 16.8 off.

**On hold (owner, 7 Nov): no more ageing work (slices 1b and 2) until the owner says.** It is hidden in the app behind a flag (`apps/web/src/features.ts`): turn it on in a browser with `?ageing=1` in the address (remembered; `?ageing=0` turns it off) or localStorage `dhd-feature-ageing` = "1"; `ageing.spec.ts` turns it on per test. **Ageing parents check, slice 1 (7 Nov, spec `docs/specs/ageing-parents.md`, "Slice 1 as
built"):** no schema change. Core `ageing.ts`: `ageingFacts(level, profile)` (choice-free, cached
per frozen level) and `ageingReport(level, choice)` → issues by group (in, around, bedroom,
bathroom, points) with Needed/Recommended, `passed`, `notes`, `turns`, bedroom counts, the
auto bathroom; `ageingSupersedes` hides walkway bars it redraws. `walkway.ts` shares one
`furnishedPass(level)` with it (guarded by level: never read its buffers for another level).
Turning: a raster of the room group only, refined on polygons (doorways closed) and cached by
the pieces near it. `ageing-zones.ts` (`depthOff`, `largestSquare`), `accessClearWidth` (mm,
per leaf), `ease.ts` (EASE 2026 prices in cents). Web `ageing/`: per-browser store
`dhd-ageing-<projectId>` (zod `AgeingSetting`), the runner in `clearance/walkways.ts` runs it
even with clearance off, the "Older person" section, the list (sheet on a phone, "‹ Back to the
list"), the plan layer (`--advise` amber), "For a wheelchair" in a piece's or door's details,
the live region. E2e `ageing.spec.ts` (desktop, phone by finger). Slice 2's `household` shape
is shared with the storage meter (`household.flatType`, `household.ageing`).

**Carpentry and cost estimate (5 Nov, spec `docs/specs/carpentry-cost.md`, slice 1):** five
built-ins in the catalogue's Built-in category (wardrobe and shoe cabinet 2.6 m high, TV
console, kitchen base and wall runs), `carpentry` on their kinds and on the kitchen cabinets.
Core `cost.ts`: `TYPICAL_RATES` (S$ low–high), `footRun`, `carpentryCost`, `costEstimate(before,
after?, rates)` → grouped lines (walls hacked and built, glass, half walls and glass above,
openings cut and closed, doors by style and glass leaves, windows, floors, repainting by
centre-line perimeter × ceiling + ceiling, built-ins new or resized with countertops, debris,
10% contingency), totals to $100. Renovation changes now carry the opening's `id`. Web
`cost/estimate.tsx`: rates per browser (`dhd-rates`, merged over the typical ones), the plan
details' "Cost estimate: about $X–Y" and See estimate, the dialog (groups, total, editable
rates with toggles and Reset, Copy as text, Print in a window of its own), and the built-in's
line in its details. Not yet: built-ins sized to the level's ceiling when placed, the
estimate per level for multi-level projects (it prices the first), slice 2.

**My furniture and the way in (6 Nov, spec `docs/specs/my-furniture.md`, slice 1, schema 8):**
`CustomModel.hash` is optional, with `shape` (sofa, bed, table, cabinet, box), `material` and
`diagonal`; exactly one of hash and shape (zod refine). Go `SchemaVersion` 8; migration 7→8
a no-op. `customKind` draws a shape from boxes (`shapeParts`) and carries `diagonal`; model
sync and project copy skip hash-less entries. Core `delivery.ts`: `clearWidth` by door style,
`turnLimit` (the moving-sofa corner limit), `mainDoors` (doors to the outside, widest first),
`deliveryCheck(level, itemId, {from, lift})` → the route from the main door room to room
(through doors and passages, freely across boundaries; fewest doors among routes that pass,
else fewest), each door judged fits / tight (<20 mm spare) / hinges (passes only with a
swing door off) / too big (the width it needs, or the turn it can't make in the space in
front), and the worst. Web `delivery/delivery.tsx`: Add by size (catalogue "Your furniture"),
"Getting it in" in a piece's details (own pieces always, others via Show the way; a From
picker when there are several main doors, remembered per browser), and the route on the
plan with each door's clear width (`data-export="skip"`). Not yet: the lift in the UI,
corridor widths, furniture in the way.


**Plan for contractors (6 Nov, spec `docs/specs/dimensioned-export.md`, slice 1):** core
`dimensions.ts`: `planDimensions(level, geom?, opts?)` → chains per side (outside faces found
by sampling each face: flat behind, free space in front, and seen from outside, so a face in
a notch is left off; within 1° of an axis; tier 0 openings, tier 1 corners, tier 2 overall;
stops within 5 mm merge, a tier equal to the next is dropped; each stop's `from` is the face
its extension line starts at, the outline edge for a stop out of sight), `aligned` chains for
slanting faces (their ends are corners on both sides), room spans (rays ±x, ±y from the label
point to the nearest wall face, opening or boundary; under 0.6 m left out), door/window tags
(away from a door's swing, into the room for a window; flipped to the other side if a label
or built-in is on them), label points (placeLabel, then a grid search clear of tag and
built-in boxes, `opts.labelHalf`/`tagHalf`/`avoidBoxes` sized by the sheet), `roundChain`
(cumulative rounding, so pieces add up) and `sheetScale`/`SHEET_MM`/`PAPER_MM`. Web
`print/contractorSheet.tsx` draws its own SVG pages in mm (walls, hatch, glass, half walls,
boundaries, door symbols by style, windows, built-ins with name and length, furniture
optional, After's hacked red / new teal, labels with white halos, chains, title column with
scale bar (2.5 m at 1:50), north from `site.north`, key, page n of N; page 2+ the change list
from `changesAsText` with the place bold, then Notes lines), rendered by a lazily loaded
`react-dom/server` and printed from a hidden iframe (`data-print="contractor"`, `@page` size
landscape, margin 0). `print/ContractorDialog.tsx` from Projects ▸ Download (disabled without
walls). The phone rules that hid the view switch's Split button were `.topbar .segmented`,
which also hit segmented controls in dialogs opened from the top bar; now
`.topbar-right > .segmented`. Spec criterion 7's "25 m wide: 1:200, fits false" can't both hold
(25 m fits A4 at 1:200: 147 mm of drawing width); the test checks 25 m → 1:200 and 40 m → not
to scale. Not yet: slice 2, a label that can't fit a crowded room (furniture shown) may sit on
a built-in.

**Plan for contractors, review fixes (6 Nov):** After draws hacked walls under the After walls
and new ones over them as what they are (teal wall, light-teal half wall, teal-outlined glass,
with their length), new doors and windows teal (`diff.openingsAdded`) with the cut hatched red
where the wall stays; `outlineBounds` takes boundary lines and `include` points, `planExtent`
adds door swings, so chains clear a door opening out and (After) hacked walls; a face beside a
boundary-closed room is inside it for half the wall's thickness (no 50 mm pieces at a
terrace); pieces under 20 mm join a neighbour; labels keep off walls, door leaves, tags and
`blockBoxes` (hacked walls), a long name goes on two lines; spans go beside the label when the
line through it would cross a tag, leaf or hacked wall (`spanFigure` sizes the room needed),
none for a room under 95% of its bounding box; tags carry the clamped width. Printing
(`print/frame.ts`, also `printPlan`) drops the frame on `afterprint` (10 min fallback) and
focuses Projects; pages are wrapped in clipping `.sheet-paper` boxes. Dialog: the scale counts
hacked walls (`print/extent.ts`), A3 by default when only A3 is to scale, `role="alert"`,
focus back to Projects; the sheet always has a Version line. Not yet: a notch's depth (faces
hidden in a notch get no chain).

**Electrical and lighting plan (6 Nov, spec `docs/specs/electrical.md`, slice 1, schema 9):**
`Level.points` (`ElecPoint`, default `{}`; migration 8→9 a no-op; Go `SchemaVersion` 9, fixture
regenerated; **the production API must be deployed before this merges**). A point is on a wall
(`wall: {wallId, t, side, height}`, on that face; an aircon unit's height is its top) or on the
plan (`at`: ceiling lights and fans, a compressor), never both (zod refine); switches have
`gang` 1–3, an aircon unit `route` bends and `compressorId`. Core `electrical.ts`: `ELEC_KINDS`
(names, place, plate size), `pointPosition`, `defaultHeight` (sockets 300, 1150 over a kitchen
base run, switches 1050, data/TV 300, aircon top 200 under the ceiling, water heater 2000,
cooker 600, doorbell 1200), `clearAlong`/`placePoint` (nearest face within 0.3 m, between the
inside corners, never across a door or passage, under a window only below its sill, else beside
the nearer jamb with the plate 50 mm clear: the spec's "jamb + 50 mm" read as the plate's edge),
`trunkingPath`/`trunkingLength`, `pointWarnings` (socket in a bath/WC, shelter wall, structural
or likely-structural wall judged on Before, aircon with no compressor), `pointCounts`,
`electricalChanges` (by id: new, moved over 50 mm or onto another face, removed; a changed kind
or a point on a hacked wall is removed and new), and `addPoint`/`updatePoint`/`deletePoint`.
Points follow their wall in `splitWallAt`, `mergeVertex`, `deleteWall` (one undo), a wall made a
boundary, `repairLevel`, `applyLevel`, `shiftWall` (`keepFromFarEnds`) and `moveRoom` (ceiling
points carried with the room); `carriedToRenovation` carries them; a traced plan replacing the
walls drops the wall points. Cost: `elecNew`/`elecMove` per kind, `elecRemove`, `trunking` per m;
group "Electrical" ("13A double socket, new · Bedroom · 2"); without a renovation every point is
new and the dialog says to start one; the compressor comes with the aircon. Render: a white
plate 8 mm proud (146 mm for doubles), slots or rockers on it, the aircon unit, compressor and
trunking as boxes; no ceiling points, not walked into. Web (`electrical/`): Electrical tool (E)
with a kind palette (a sideways row on phones), a ghost on the face, the magnifier on phones;
an aircon unit starts "Run the trunking" (a bar at the foot of the plan: taps are bends, a tap on
a compressor ends it, "New compressor here", Undo bend, Done); in Select (and the tool) points
drag along their wall or to another face, keeping a height moved off the usual, and the selected
unit's bends drag. `ElectricalLayer` draws the symbols in metres (radius 9 px, at least 70 mm),
"h1150" off the usual height, a red "!" with the warnings as its title; switched by "Electrical"
in the plan details (`dhd-electrical`, on with the tool, in the PNG when on). Room labels step
aside for ceiling points. Inspector: kind, height in mm (`LengthField unit="mm"`), gang, room,
warnings, trunking length, Run trunking. Contractor dialog: "Electrical plan" (on when there are
points) adds a page (walls faded, room names, points in ink; After: new teal, moved teal with the
old spot faint, removed red; trunking dashed with its length; key with heights and counts; "Work
by a Licensed Electrical Worker.") and a schedule page (room, point, qty, height, change), the
schedule on its own page rather than squeezed into the title column. e2e `electrical.spec.ts`
covers criteria 11–18. Not yet: slice 2; a kind changed in the Inspector isn't re-checked
against openings; the plan doesn't colour After's new or moved points.

**Comments on the plan (6 Nov, spec `docs/specs/plan-comments.md`, slice 1; no schema change):**
comments are their own resource, never in the project document, its undo or its history. **API
first:** deploy the API and edge (new `COMMENT_LIMIT` rate-limit namespaces 2005/2006, 30 a
minute) before the web; an old API answers the routes with a plain-text 404, and the web then
hides Comments. Go `internal/comments` holds the format (`version`, a random `epoch` from the
first write, the owner's `setting` all/edit/off, `threads` with `anchor`, `resolved`,
`messages` stamped with the poster's role and `authHash` = sha256(id|author key)), validation
(names 1–40 runes, text 1–1000 after trimming, no control or format characters but the
joiner and a flag's tags, labels tidied to 80, coordinates ±1000 m, ids `^[a-z0-9_-]{1,40}$`,
bodies ≤ 16 KB, 50 messages a thread, 300 a plan, 1 MB) and the operations as pure functions;
the view drops `authHash` and sets `mine`. `store.CommentStore` (memory, file
`data/comments/<id>.json`, R2 `comments/<id>.json` with If-Match/If-None-Match and a HEAD of
the project only when there are none). Handlers apply each write under a per-project lock with
up to 5 tries (503 `busy`); ETag `"<epoch>.<version>"`, 304 on If-None-Match; writes need
`X-Comment-Author` (32 base64url) and JSON. A project delete (holding the lock) copies them to
`deleted/<id>.comments.json` and deletes them before the project; a create clears leftovers.
Rights come from `X-Role` plus the setting (the client works them out, so a 304 never carries
stale rights); open (unclaimed) plans can't be moderated. Edge: `COMMENT_LIMIT` per address for
non-GET `/projects/*/comments`, and 300 posts a day per visitor through `allowDaily` in the same
`create_quota` table (the create key's input unchanged); both fail open and log. Core
`comments.ts`: zod `CommentsDoc` (tested on the Go fixture `internal/comments/testdata`),
`anchorFor` (the Select hit: item with `rel` in its frame, point, opening, wall with `t`/`off`,
room, else a spot; labels like "Wall · Living / Kitchen"), `anchorPosition` (follows moved and
turned pieces and grown walls; gone: `removed`, `removed-in-renovation`, `no-renovation`,
`no-level`), `threadsView`, `commentsText`. Web `comments/`: `useComments` (zustand; polling
30 s with the panel or a thread open, 2 min otherwise, paused while hidden, at once on focus,
5 min after errors; a 403 refetches), the Comment tool (K, second in the palette; viewers get
Select and Comment only), HTML pins over the plan (`data-export="skip"`, newest on top, no
grouping), the composer and thread as a popover or, on phones, a sheet above the keyboard
(`visualViewport`), the Comments panel in the details column (a 50dvh sheet on phones), "Who can
comment" in the share menu, `?c=<thread>` links, and the "Comments on the plan" switch in the
plan details. e2e `comments.spec.ts`. Cut from slice 1 (tech lead): grouping pins, "Comment on
this" in the Inspector, the hover chip, and the Worker answering 304s itself.

**Suggested electrical points (6 Nov, slice 2s PR 1, spec `docs/specs/slice-2s.md` A; no
schema change):** core `suggest.ts`: `roomKind(name)` (none, bathroom, kitchen, bedroom,
living, study, other; reuses `SHELTER_ROOM`, `WET_ROOM`, `LEDGE_ROOM`), `suggestPoints(level,
{statusOf})` → `{points, notes, rooms}` (cached per frozen level), `suggestionCost` (the sum of
`elecNew`; it matches `electricalLines` with the points minus without, to the $10 rounding of
each line) and `addPoints(levelId, points, label)` (ids and `ElecPoint.parse` outside the
recipe; a missing wall throws, so the batch is all or nothing; one undo step). A `Suggestion`
has a stable `key` (room, rule and what it hangs on: `rm_x:bedside:it_y:L`), `rule`, `point`,
`why` (the tooltip) and `where` ("Bedside, left"). Placement order: switches (bathrooms first,
theirs outside), furniture sockets (bed, desk, fridge, counter, hood, cooker, TV wall), aircon,
desk-or-dresser, lights and the compressor; rooms, items and doors sorted by id so the result
doesn't depend on record order. Every wall point goes through `clearAlong`, which now takes
`extra` (the batch) and `blocked` stretches (open door leaves via `doorSweep`, tall pieces and
built-ins), with a 0.3 m movement limit (a switch first tries 50 mm, then the other side, then
0.3 m). "Already there" is checked at the intended spot first: same face, within 0.4 m along
and 0.3 m in height (sockets of either kind count for each other), a light or fan in the room,
an aircon or water heater in the room, any compressor. Choices beyond the spec: an aircon
prefers a wall with 2 m of room in front of it (not across a corridor) and never sits over a
door; a TV wall with no console or sofa prefers a 2.4 m wall, then a non-structural one. The
door you enter by comes from `doorGraph`/`doorSearch`/`routeTo` (pulled out of `delivery.ts`);
kitchen runs from `touchingRuns` (pulled out of `clearance.ts`, base cabinets only, split per
face); `latchEnd(opening)` from `clearAlong`. Custom pieces carry their `shape` (bed, sofa).
Tests: `suggest.test.ts` (criteria 1–17, shuffled records, the renovation case; a furnished
sample in `fixtures/furnishedSample.ts`). Web `electrical/suggest.tsx`: [Suggest points] in the
Electrical tool's options and the plan details (disabled with "Draw rooms first.", not in view
links). The panel replaces the plan details (a selection still shows its own): rows by room in
plan order with Add N, count and cost at the viewer's rates, a summary, a "Show points" tick
list (the keyboard path), notes; a sticky foot with the total, Add all and Close; Esc closes
and focus goes back to the button; a polite live region counts the points. Ghosts
(`SuggestLayer`, `data-export="skip"`) use the `--suggest` and `--suggest-soft` tokens (full
strength, a dashed ring; left out: a grey ring with ×); a click or tap toggles one (routed
first in `PlanCanvas`) and the status line says what and why. Hovering a row outlines its room
and fades the rest; tapping its name fits the room. Suggestions are worked out again 150 ms
after an edit (the panel and plan share one run; a drag costs one run after it ends); Add
uses a fresh run, so it never sends a point on a deleted wall, and if that differs from what
is shown it shows it instead and waits for another click. An Add the store refuses (no edit
right, the renovation guard) neither rings nor closes. Counter sockets are counted per run
(only the shortfall is suggested, and "already there" is checked again where each lands); a
point with no clear spot is dropped with a note (`noRoomFor`). After QA: a wall drawn as several collinear records is one wall for
placement (`line`, `runStretches`; `there` compares by position); a switch never goes on a
door's hinge side (with no room by the latch, round the inside corner past it, the door's own
leaf ignored there); the room light sits 0.55 m up from the label point and plan labels step
aside for wall points too; rows note points on structural walls and the trunking an aircon
still needs, a room with no door, and a counter short of sockets; the Dry kitchen's counter
note is skipped when a joined kitchen has the counter. Web: the status line sits in the sticky
foot; a room's row leaves after Add (back on undo); "no charge" for the compressor; Click or
Tap by pointer; focus starts at the panel heading; ghosts shrink to at most 0.2 m zoomed out;
a one-line intro on phones. Toasts
"Added 6 points to Main bedroom." / "Added 23 points." with Undo (`toastFor`). Added points
ring in `--suggest` for 600 ms (none with reduced motion). Phone: the sheet is half the
screen, the plan refits the walls above it, buttons 44 px. In a renovation, points go in After
only: on Before the panel says so and offers "Switch to After". e2e
`electrical-suggest.spec.ts` covers criteria 18–24 on a desktop and a 390 px phone. Not yet:
ghosts show no warnings (an aircon will say "No compressor" once added); a bed or other
selection hides the panel until it is let go.

**The lift check and an editable sofa diagonal (6 Nov, slice 2s PR 2, spec
`docs/specs/slice-2s.md` B1 and B2; schema 10):** `Site.lift` is a `Lift` (`preset` typical,
older, large or measured; `door` width and height; `car` width across the door, depth and
height; the door no wider or taller than the car), `null` for no lift, absent for not checked.
Migration 9 to 10 is a no-op; Go `SchemaVersion` 10 (the server test uses the constant), and
`hdb4room.json` is regenerated. **Deploy the API before merging.** Core: `LIFT_PRESETS`;
`setLift(lift | null | undefined)` ("Set lift", makes `site` from `DEFAULT_SITE`, undefined
deletes the key); `rectFits` (Carver 1956; the internal `rectFit` also gives the slack, 0 at an
angle); `liftFit(size, diagonal, lift)` → `{fit, how, fails, need, spare, tilted, standUp}`:
the door's cross-section first (no turn: the lobby is open), then the poses as it stands, on its
back, on end, and tilted (only an angled fit in the B × H or A × H plane counts as tilted, so it
reads tight, spare 0). A pose taller than the door must come in lying along its carry and be
stood up: the carry's length ≤ `turnLimit(door height, room, carry v)`, where room is the car's
depth (or, for a tilt across the depth, its width). When a pose fits the car but can't be stood
up, `standUp` gives its length, the limit, the door height and that side (only when the limit
is above 0: a car shallower than the piece is thick just "doesn't fit"), and the verdict names
what the family measured: "Too long to stand up in the lift: at 2.10 m long, it can’t be turned
upright through a 2.00 m high door into a 1.40 m deep car." (criterion 2's 2.1 m sofa on a
0.80 m diagonal). `deliveryCheck(level, id, {from, lift})` puts the lift
first in `doors` (`openingId: 'lift'`) and in `worst`, and returns `lift`; `worstDoor` is
exported; `DoorOnTheWay.tilted` marks a door passed only on the diagonal carry ("(tilted on its
diagonal)" after the narrowest door, else "Tilted on its diagonal through …", and ", tilted"
on the plan label). A bed (catalogue `comesFlat: 'bed'`, or added by size as a bed) is checked
as its delivery parts (`deliveryParts`): the mattress w × d × 0.3 (folds in half along its
length, unless wider than 1.7 m: a king), a headboard panel w × 0.1 × h and side rails
d × 0.1 × 0.3; it fits when every part does (`DoorOnTheWay.parts`, `Delivery.parts`,
`liftFitParts`), and `partsNote(r)` says why ("Comes flat: the mattress (folded in half) and
frame panels each fit." / "Comes flat, but the mattress (too wide to fold) doesn’t fit; ask the
shop."). Freestanding wardrobes stay rigid; built-ins aren't checked. `updateModel` takes `diagonal: number | null` (null
removes it); `restoreVersion` copies the site with `structuredClone`. Web: the wording is in
`delivery/words.ts` (unit-tested). "Getting it in" has a `role="status"` block: the verdict and
one line under it (`liftStatus`: "Lift: not checked.", "No lift on the way in.", how it goes in,
or, when the lift fails, "Ask the shop whether it comes apart…"; a bed: "Lift: each part fits."),
so a change is always read out and the controls below move less. A bed shows its `partsNote`
first (`data-testid="parts-note"`), then the verdict as for any piece. Then [Add diagonal depth]
for an own sofa too wide for a door, unmeasured or saved out of range (scrolls to and focuses
the field, `behavior: auto` under reduced motion), From, and the Lift select with its hint (a
preset's numbers; on a view link the select is disabled but shown in `--text` on `--raised`,
with "Set by whoever can edit the plan."). A lift change scrolls the verdict back into view
(`block: 'nearest'`; on a phone's short sheet it's above the select). "My measurements…" saves
`preset: 'measured'` from the last lift in one step and shows five `LengthField`s (two to a
row, `enterkeyhint="done"`) whose `validate` prop gives each its own range ("Between 0.5 and
2.0 m.") or "The door can’t be wider/taller than the car.". `LengthField` now keeps focus and
selects the text when Enter is refused (every length field), and takes a `problem` for a saved
value that's wrong (a diagonal saved out of range shows its range error until re-entered).
`useDelivery` re-checks when the lift or the project's models change. Inspector "Your model"
for a sofa by size: "Diagonal depth" (placeholder "Not measured", range from `diagonalRange`,
empty plus Enter removes it, "Measured on the sofa at … scaled with this piece." once the piece
is resized). `.way-panel .btn-small` is at least 44 px on phones. Add by size and the item's
width and depth now go down to 0.01 m (an 18 mm panel). An import that fails shows
`loadErrorText` (core): "That file’s lift sizes aren’t valid (the door is wider or taller than
the car).", or the first invalid part, not zod's JSON. e2e `lift.spec.ts` covers B1 9–15 and
B2 3–5 on a desktop and a 390 px phone, plus the mattress, the 18 mm panel and a saved
out-of-range diagonal; criterion 16 (production accepts a
v10 save) is for the deploy. Not done: the lift has no place on the plan.

**Square aircon trunking, inside the flat (6–7 Nov, the owner's "it trunks at strange angles";
no schema change):** `trunkingPath` starts at `trunkingStart` (the unit's face point +
`TRUNK_OFF` 50 mm along its normal; render no longer adds its own offset). Product rule (PM,
7 Nov): **no trunking on the façade**; routes stay inside, through rooms and corridors, never
the shelter or a door opening, into the ledge only through a wall bordering it. Core
`trunking.ts`: `trunkAxes`/`unitAxes`/`axesOf` (squared to exact x/y within 1e-6);
`nextBend(level, from, cursor, {alt, target, axes})` picks the axis nearest the pointer's way
among the unit's, the last leg's and the nearest wall's, snaps to a face's hug line within
`TRUNK_SNAP` 0.3 m (before or past the wall) or level with the compressor, else 5 cm steps,
and `stopShort` keeps it 50 mm short of the first face in its way (any angle) unless the
pointer is past that wall; `legInto` (into a compressor: `alongWalls` routes it with
`wallRoute`, else an L corner that never doubles back); `tidyRoute` (legs square to the
last leg, the unit or the nearest wall kept; crooked ones projected exactly, so no jog;
`hugLegs` slides middle legs up to 1.5 m onto a parallel face when that crosses no new wall;
the way in routed); `fromLegs` (bends as the meeting points of legs that keep their
directions) behind `movePathEnd`, `followRuns` (called in `moveVertex`, `shiftWall` and
`moveRoom` recipes: legs that hugged a face follow it, the first leg follows the unit) and
`dragBend`/`draggedRoute` (with `snapToFaces`); `moveWithTrunking(level0, id, patch, geom)`
(compressor or unit dragged; the Select tool keeps the level from the drag's start in its
drag state and recomputes from it every move); `wallsCrossed`; `wallRoute`/`autoRoute`:
Dijkstra on a grid of hug lines square to the unit's wall, over rooms bucketed in 1 m cells
(first within 3 m of the unit's room and the ledge, then the whole plan); rooms allowed: all
but shelters and other ledges, never 'outside'; no door or shelter-wall crossings; costs
length ×(1 + 1.5 off a face + 0.3 away from the unit's room and the ledge), 0.2 a turn, 0.4
by a window or passage, 0.8 drilled; a 612-wall plan routes well under 400 ms (test).
`routeAlongWalls(level, unitId, geom)` → `{command, compressorId}` or `{error}` (`NO_LEDGE`,
`NO_INSIDE_ROUTE`); a new compressor goes towards the unit's end of the ledge, clear of the
name. `pointWarnings` adds `trunk-shelter` for a hand run through a shelter wall. Web: taps
go through `nextBend`/`legInto` and merge straight-on bends; the dashed preview (no fill)
shows from finger-down, clears on the tap; the bar reads "2.9 m + 1.2 m next"; Undo bend is an
icon and "Route along the walls" reads "Along walls" under 560 px (its name follows); the
details sheet folds during a run; a pinch that leaves the last bend under the bar is undone
once the plan settles; Inspector Route along the walls and Straighten (memoised); the
estimate prints trunking to one place. e2e `trunking.spec.ts` (desktop and a 390 px phone).
Checked: a renovation's After runs route the same way. QA round 2 (7 Nov): `legInto` squares
the way in to the unit's or the nearest wall, never to an Alt leg, so an Alt bend never moves;
Straighten falls back to `wallRoute` between the run's ends when the squared run isn't neat
(`neatRun`: every leg over 0.35 m on a hug line, no doorway) and takes out jogs under `JOG`
15 cm where that crosses no new wall (a jog the walls force, a face 0.2 m off the next, stays);
a route joins other units' trunking (`sharedLegs`, 0.25 a metre, holes free) and avoids
running over a door head (+0.6); "No inside route…" clears on success or another selection;
on phones a run starts zoomed to the unit's room and the ledge; a new compressor sits at the
ledge's far side towards the unit, and room labels keep clear of it (two circles along it; the
name alone if the name and area don't fit). Round 3: jogs (`hasJog`, `removeJogs`) are taken
out by `followRuns` after a wall moves, by `wallRoute`, and by Straighten, which counts any
jog under 15 cm as not straight; where the first leg can't move, the jog becomes a short stub
out from the unit and the run goes straight on (a leg a jog's width off a face still counts as
hugging it). Off a face costs ×4 a metre and a door head 3.5, so a route goes round a doorway
when that's within about 1.5× as long or it can share a trunk (it does, down the main
bedroom's left wall). On a phone a run starts with the unit's room and the ledge filling the
strip below the bar, refitted as the sheet folds (`phoneRunView`).

