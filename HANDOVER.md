# Handover: Dream Home Designer

Written 2026-10-30 at the end of the first build session, for whoever picks this up next
(most likely a Claude Code session on the owner's machine). Read this once, then use
`CLAUDE.md` for day-to-day conventions.

- **Repo:** https://github.com/zeecm/dream-home-designer (private)
- **Product and technical plan (source of truth for scope and phases):**
  https://claude.ai/artifact/Wu33FsPzhspwQJBwgxeaP5
- **Owner:** zeecm. Backend engineer whose daily language is Go; also writes TypeScript.

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
| React version | 18, not 19 | The plan said 19. Stayed on 18 for R3F v8 / drei v9 compatibility. Upgrade together with R3F v9 later |
| Backend language | **Go** (confirmed by owner in a doc comment) | Owner's daily language. The API never touches geometry |
| Backend libraries | Plan: chi + pgx + sqlc + goose. **Current: standard library only** | The build sandbox couldn't download Go modules. Go 1.22+ `ServeMux` patterns cover routing today. Add chi only if middleware needs it |
| Hosting | **Cloudflare Pages + R2** (confirmed) for web and files; **Fly.io (Singapore)** for the Go API | Workers can't host Go |
| Database | Postgres on Neon, arriving in Phase 4 behind the existing `store.Store` interface | Dev uses a JSON file store |
| Document storage | The project is one JSON document, stored server-side as opaque JSON(B). The server validates only the envelope | Keeps the schema in one place (zod in `packages/core`) |
| Wall model | Walls reference **shared vertex ids** | Dragging a corner moves every wall that meets it. The owner was told not to overrule this one |
| Openings | Rectangular only, so walls are built as solid boxes around them. **No CSG** | Simpler and faster. The plan doc mentions CSG; the boxes approach replaced it |
| 2D editor | SVG, not canvas | Free hit-testing at this element count |
| Undo/redo | Immer patches per command; `coalesceKey` merges drag steps | No hand-written inverses |
| Units | Metres and radians everywhere. Plan (x, y) maps to world (x, 0, y), +Y up | |

Still open (from the plan doc): MIT open-sourcing at beta; whether "before/after"
variants go in v1; whether to ship HDB BTO layout presets as templates.

## 3. Repository tour

```
apps/
  web/                 Vite SPA. Phase 0 shell: 3D orbit view, rooms list, a slider
    src/App.tsx          that moves one wall (stand-in for the 2D editor), undo/redo,
    src/store.ts         Zustand store wrapping core's history + autosave/sync state
    src/api.ts           fetch client; ConflictError on 409, NotFoundError on 404
    src/Viewport.tsx     R3F canvas, lights, OrbitControls, renders buildLevel()
    vite.config.ts       dev proxy: /api/* -> http://localhost:8080/* (API_URL overrides)
  api/                 Go module github.com/zeecm/dream-home-designer/apps/api
    cmd/api/main.go      ADDR (default :8080), DATA_DIR (./data) or STORE=memory
    internal/project/    envelope validation (Parse), WithVersion, ID rules, 2 MB cap
      testdata/hdb4room.json   the TS fixture serialised to JSON (keeps Go and TS in step)
    internal/store/      Store interface; Memory (mutex) and File (Memory + atomic writes)
    internal/httpapi/    REST handlers + tests (round-trip, conflict, concurrency, validation)
    Dockerfile           distroless static image for Fly.io
packages/
  core/                Pure TS. No React, no three.js. Everything else depends on it
    src/schema.ts        zod schema: Project > Level > vertices/walls/openings/rooms/items/lights
    src/history.ts       Command, dispatch, undo, redo, coalescing, HISTORY_LIMIT = 200
    src/commands.ts      renameProject, moveVertex, addWall, setWallThickness, deleteWall,
                         addOpening, renameRoom
    src/geometry.ts      signedArea, roomArea, wallLine, wallPieces (split around openings),
                         levelBounds, centroid
    src/ids.ts           newId('w') -> "w_k3j9a0b2cd"
    src/fixtures/hdb4room.ts   reference plan: 5 rooms, 16 walls, 10 openings, 93.5 m²
  render/              Project -> three.js
    src/buildLevel.ts    walls merged into one mesh per material, glass panes, floor per room,
                         optional ceilings; disposeGroup()
    src/materials.ts     MaterialCache with flat colours per material id (PBR in Phase 3)
.github/workflows/ci.yml   web: biome lint, typecheck, vitest, vite build · api: gofmt, vet, race tests
```

### API (current)

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | /healthz | `{"status":"ok"}` |
| GET | /projects | Summaries, newest first |
| POST | /projects | Full document. Stored as version 1. 409 if the id exists |
| GET | /projects/{id} | Document. `ETag: "<version>"`. 400 for unsafe ids, 404 if missing |
| PUT | /projects/{id} | Requires `If-Match: "<n>"` (428 without it). 409 + `{"version": current}` if stale. Body id must match the URL. Returns `{"version": n+1}` |
| DELETE | /projects/{id} | 204 |

The server rewrites the document's `version` field so the stored JSON always matches the
server version. IDs must match `^[a-z0-9][a-z0-9_-]{0,63}$`.

### Client sync model

`store.ts` keeps `sync` as one of loading / offline / saved / dirty / saving / conflict /
error. Every committed edit marks it dirty and debounces a save by 2 s. On load the client
GETs the project, POSTs the fixture if it gets a 404, and re-GETs if that POST races and
gets a 409. If the API is unreachable it falls back to the local fixture in **offline**
mode, where saving is disabled. A save response bumps `doc.version` without touching undo
history. A conflict currently just shows a message: a "reload from server" prompt is
still to do.

## 4. State: what works and what hasn't been verified

**Verified in the build sandbox**
- Go: `gofmt`, `go vet` and `go test -race ./...` all pass. The live server passed a
  manual round trip: create (201, ETag "1"), PUT with If-Match "1" (200, v2), stale PUT
  (409 with version 2), GET (edited name and moved vertex at v2).
- The core fixture and geometry ran under tsx: room areas are 22.5 / 27 / 14 / 14 / 16 m²,
  `wallPieces` splits a door correctly, and the wall rotation maths is right.

**Not yet verified (the sandbox couldn't reach npm)**
- `pnpm install` has never run, so there's **no `pnpm-lock.yaml`**. CI uses
  `--no-frozen-lockfile` for that reason.
- TypeScript typecheck, Biome lint, Vitest for core/render, and the Vite build have never
  run. Expect a handful of type or lint fixes on the first run. The likeliest spots:
  - zod-inferred types vs Immer `Draft<>` in `commands.ts` (optional `height`, default fields)
  - the `three/examples/jsm/utils/BufferGeometryUtils.js` import path or its types in
    `buildLevel.ts`
  - Biome's recommended rules on `App.tsx` / `Viewport.tsx` (exhaustive deps, a11y on the
    range input)
  - `vitest` running `packages/render` tests in node: three.js core works headless, but
    check that nothing touches `document`
- The 3D view has never been seen in a browser. In particular, check that floor polygons
  sit inside the walls (the `-p.y` flip in `buildLevel.ts`), ceilings face down, and
  shadows look sane.

## 5. Do this first (in order)

1. `pnpm install`, then commit `pnpm-lock.yaml` and switch CI to `--frozen-lockfile`.
2. `pnpm typecheck && pnpm lint && pnpm test`: fix what breaks. Keep fixes minimal and
   don't restructure.
3. `cd apps/api && go run ./cmd/api` and `pnpm dev`, then open http://localhost:5173 and
   check it visually: the plan looks like the ASCII map in `fixtures/hdb4room.ts`, the
   slider moves the master-bedroom wall and both rooms' areas update, undo puts it back,
   and after 2 s the header reads "Saved · v2". **Reload** should bring the edit back.
   That is the Phase 0 gate: *a project JSON round-trips browser → API → browser.*
4. Push and get CI green.
5. Optional but cheap: a Playwright smoke test for step 3, and a Fly.io deploy of the API
   (`fly launch` from `apps/api`, region `sin`, a volume mounted at `/data` for the file
   store).

## 6. Next: Phase 1, plan editor (weeks 3–6 in the plan)

Gate: *the reference HDB plan traced from an image in under 10 minutes.*

Suggested order. Each step should land with tests in `packages/core` before UI.

1. **Layout.** Split screen with the 2D SVG editor on the left and 3D on the right, plus
   a tool state machine in an `editor` Zustand slice that is never persisted: `select`,
   `wall`, `opening`, `room`, `measure`, `calibrate`.
2. **Underlay.** Upload an image (and a PDF page via pdf.js) and show it under the SVG
   with opacity and rotation. Keep it as a local object URL until R2 signed uploads
   exist; `underlay.assetKey` can hold a placeholder.
3. **Calibration.** Click two points and type a distance:
   `scale = d / |p1 − p2|`, `origin` = the first point. Store only origin and scale.
4. **Wall tool.** Draw a click-to-place polyline. Snapping order: existing vertex
   (0.15 m) > projection onto a wall > 0/45/90° > 0.1 m grid. Clicking near an existing
   vertex reuses it (`addWall` already accepts `{vertexId}`).
5. **Wall edits.** Drag a vertex (`moveVertex` with a `coalesceKey`), split a wall at a
   point (new command), delete, change thickness.
6. **Mitred corners** in `core/geometry`: offset each wall by ±thickness/2, sort the
   walls at each vertex by angle, and intersect adjacent offset edges. This replaces the
   current "extend by half thickness" corner hack in `buildLevel.ts`. Write tests for L,
   T, X junctions and near-collinear walls.
7. **Room detection.** Build the planar graph (split at intersections), walk minimal
   faces, drop the outer face, then match new faces to existing rooms by centroid so
   names and materials survive edits.
8. **Openings tool.** Place an opening on a wall and drag it along `t`. Edit width,
   height, sill and swing in an inspector.
9. **Incremental rebuild.** Hash each wall (vertices, thickness, height, materials,
   openings) and rebuild only what changed. Target: a vertex drag rebuilds under 5 ms on
   a 40-wall plan.

After that, Phase 2 is the first-person walkthrough (PointerLockControls, capsule vs a
wall BVH via three-mesh-bvh, door passages excluded from collision, touch joystick). The
plan doc has the full algorithm notes and the Phase 3–5 checklists.

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

## 8. Commands

```sh
pnpm install
pnpm dev                       # web on :5173, proxies /api to :8080
pnpm test | pnpm typecheck | pnpm lint
cd apps/api && go run ./cmd/api            # file store in ./data
cd apps/api && STORE=memory go run ./cmd/api
cd apps/api && go test -race ./...
```

## 9. Known gaps and debts

- No auth. Everything is open; auth arrives in Phase 4.
- The web app hard-codes project id `prj_demo` and loads the fixture when it's missing.
- The conflict state shows a message but offers no reload button flow.
- Walls use `materialLeft` for both faces; per-side materials come in Phase 3.
- No `project_versions` history yet; it's planned with Postgres.
- `apps/api` has no request-size or rate limiting beyond the 2 MB document cap, and no CORS
  (the dev proxy makes it same-origin; production will route `/api` from Pages).
