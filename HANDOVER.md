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
| Project storage (until Postgres) | **R2**, one object per project, conditional writes for optimistic concurrency | Containers have no persistent disk. Postgres on Neon still arrives in Phase 4 behind the same `store.Store` interface |
| Document storage | The project is one JSON document; the server validates only the envelope | Keeps the schema in one place (zod in `packages/core`) |
| Wall model | Walls reference **shared vertex ids**; the wall tool splits walls where they meet or cross | Dragging a corner moves every wall at it, and rooms can be found from the wall graph |
| Rooms | **Detected** from the wall graph's faces inside each topology-changing command | Rooms can't drift from walls; names survive edits by matching faces to old rooms |
| Openings | Rectangular only; walls are solid prisms around them. **No CSG** | Simpler and faster |
| Wall corners | Mitred in `core/footprints.ts`; a hub polygon fills T and X junctions | One outline feeds both the 2D plan and the 3D extrusion |
| 2D editor | SVG, not canvas | Free hit-testing at this element count |
| Undo/redo | Immer patches per command; `coalesceKey` merges drags and multi-wall tools | No hand-written inverses |
| Units | Metres and radians everywhere. Plan (x, y) maps to world (x, 0, y), +Y up | |
| Visual style | taste-skill "framed sheet" app style (seed 69376578), IBM Plex Sans, colour on data only | Owner asked to use taste-skill; it is vendored in `.claude/skills/design-taste-frontend` |

Still open (from the plan doc): MIT open-sourcing at beta; whether "before/after"
variants go in v1; whether to ship HDB BTO layout presets as templates.

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
- 124 core and 12 render unit tests, plus 22 web unit tests.
- A 9-test end-to-end suite.
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

**Sample flat:** `sampleFlatProject` (core fixtures) is a 96 m² HDB-style 4-room flat with a
service yard, kitchen, household shelter, two bathrooms, three bedrooms and an L-shaped
living and dining room. It is built with the editor's own commands, then given readable ids
(`w_bedroom-2_corridor`). `hdb4room` stays as the test fixture.

**Plan images on the server (built):** `PUT /projects/{id}/image` stores one PNG, JPEG or WebP
of up to 10 MB per project, checked by sniffing the content, and returns its SHA-256.
`GET /projects/{id}/image/{hash}` serves it, immutable and sandboxed, only while that hash is
current. Deleting a project deletes its image. The memory, file and R2 stores implement
`store.ImageStore`; in R2 it is `images/<id>`. In the web app, `underlay.assetKey` is
`sha256:<hex>`. The image is kept in IndexedDB and uploaded in the background, and a browser
without it fetches it from the server. Other formats and very large photos are re-encoded as
JPEG first. Older `img_…` keys are uploaded and re-keyed the next time their plan opens in the
browser that has them.

## 5. Owner to-dos

0. **Before merging:** the production API must accept schema 2. It was deployed from this branch
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
2. **Domain:** point it at the Pages project. The `/api` routing comes with it.
3. **Merge** the open PR when happy.

## 6. Next

**Finish Phase 1**, in order:
1. **Public-deployment safety (needs the owner's call):** a write token separate from the share
   link changes sharing: a plain link would become view-only, and editing on another device would
   need an edit link. Also a previous-version copy on PUT and DELETE, and a limit or lifecycle
   rule on stored projects.
2. **Room matching by overlap:** rooms are matched across edits by label point and corners. Matching
   by overlapping area would be sturdier for large reshapes.

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
- **Mini-map:** a small plan in the corner while walking shows where you are and which way you
  face (`walk/MiniMap.tsx`).
- **Next:**
  - door leaves;
  - stopping the walker from leaving through the front door into empty space;
  - head bob and footstep feel, kept subtle;
  - remembering the last walk position.

`LevelMeshes` already gives one mesh per wall, with `userData.wallId`. The plan doc has the
algorithm notes and the checklists for Phases 3 to 5.

## 7. Conventions

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

- **No auth.** A project is reachable by anyone with its link, so ids are the capability. Listing
  is off in production, and writes are rate-limited. Auth arrives in Phase 4.
- **One plan image per project on the server.** Replacing it drops the old one, so undoing a
  replacement shows the old image only in browsers that still have it locally.
- **Walls use one material for both faces.** `materialLeft` covers both, and per-side materials
  come in Phase 3.
- **No `project_versions` history yet.** It's planned with Postgres.
- **Corner dimension lines** for walls that run into the room draw inside it; fine at plan scale,
  busy on short walls.
