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

## 5. Owner to-dos

- **Before the repo goes public:** `apps/web/public/samples/hdb-3room-type4.pdf` (and its PNG
  crop) is a real HDB floor plan (Blk 39A, 3-room Type 4). HDB likely holds its copyright;
  the live app already serves it, but publishing the repo redistributes it. Decide whether
  to keep it, ask HDB, or swap in a plan drawn from scratch (the 4-room reference plan is
  original). No credentials are in the tracked files (only AWS's documentation example keys
  in a signing test).

0. **Before merging:** the production API must accept schema 6 and serve uploaded models
   (`/projects/{id}/models`). The preview API has it (30 Oct); the production deploy
   (`pnpm --filter @dhd/edge run deploy`) was held back for the owner's go-ahead.
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
   Variables and Secrets). This session isn't allowed to write secrets.
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
**Not yet:** a side-by-side 3D compare; listing changes room by room; applying an edit to
both versions at once (a trace fix in "before" shows as built wall in the after).

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
  carries on drawing from it. The drawing bar's Undo also takes back an end dragged.
- A tapped first corner shows as a marker. Measure ends can be dragged; a tap starts afresh.
- In the Door/Window/Opening and Furniture tools, a press on an existing piece of that kind
  goes to Select for the gesture (a drag moves it), via `placing()` in `PlanCanvas`.
- Delete room (`deleteRoom`, `roomOwnWalls`): takes down the walls only it has; a room whose
  walls are all shared says to delete one of them instead.
- Corners are 32 px targets on touch screens; the scale bar lets drags through; a swipe in a
  walk moves the scene with the finger; the guide is worded for phones too, keeps a fixed
  height, and step 1 offers "Draw instead".
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
inside the room clear of its label, door swings and furniture: `roomHandleAt` in
`plan/layers.tsx`; a press on the drawn handle beats a piece under it). Dragging it, by mouse
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
  not getting closer), no wall turned back or shrunk past its doors, and no room squeezed out
  or merged (`detectFaces` counts the rooms). About 0.3 ms a check on the sample.
  `moveTowards` checks every centimetre to the pointer and, moving freely, slides along a wall
  in the way.
- One undo step per drag; back where it began, nothing is kept; Escape, a cancelled touch or
  a second finger takes it back. The distance shows under the handle (`← 0.45 m   ↓ 0.10 m`).
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
   kept in the browser instead (`createFrom` in `store.ts`). **The migration needs applying** to
   `dhd-auth-preview` and `dhd-auth` (owner to-do: the permission check held it back).
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
pnpm --filter @dhd/edge deploy           # production: dhd-api
pnpm --filter @dhd/edge deploy:preview   # previews: dhd-api-preview
```

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
  capped per day once migration `0002` is applied). Google sign-in is built and off until the
  owner configures it.
- **One plan image per project on the server.** Replacing it drops the old one, so undoing a
  replacement shows the old image only in browsers that still have it locally.
- **Flaky phone e2e:** the first test in `mobile.spec.ts` still fails about one run in four
  locally (CI retries once): the Add tap or the finger-drawn room doesn't land when the run
  is slow. Four real causes were found and fixed on the way: Add was `disabled` until the
  typing re-rendered (a quick tap was dropped); a busy page merges a quick drag's moves into
  the lift (the plan and the walk now play the lift's position as a last move); and the orbit
  controls left `touch-action: auto` on the 3D canvas, so a phone cancelled sideways swipes
  in walk mode (the owner's "can't look around without moving"). Swipe-to-look turns half a
  circle per screen width on touch.
- **Wall tool snapping:** a point landing inside a door or window moves to the nearer jamb
  (`jambSnap` in `snap.ts`), so an angle-snapped wall drawn to a doorway slants by up to half
  the door's width. The alternative, ending the wall straight but short of the doorway and
  unjoined, leaves the room open; not decided.
- **Corner dimension lines** for walls that run into the room draw inside it; fine at plan scale,
  busy on short walls.
