# Dream Home Designer

Upload a floor plan, trace the walls, furnish the rooms, and walk through your home in
first person. Free, browser-based, and your project is plain JSON you own.

> Status: **Phase 0 (foundation)**. A reference 4-room HDB plan renders in 3D, edits go
> through an undoable command store, and projects save to and reload from the API.

## Layout

```
apps/
  web/        Vite + React + React Three Fiber single-page app
  api/        Go REST API (standard library only for now)
packages/
  core/       Project schema (zod), commands + undo/redo, geometry. Pure TS, no React/three
  render/     Project -> three.js meshes (walls split around openings, floors per room)
```

The rule: `core` knows nothing about React or three.js; everything else depends on it.

## Run it

Requires Node 22, pnpm 9 and Go 1.24.

```sh
pnpm install

# terminal 1: API on :8080, projects saved under apps/api/data/
cd apps/api && go run ./cmd/api

# terminal 2: web on :5173, /api proxied to :8080
pnpm dev
```

Open http://localhost:5173. Drag the slider, undo with Ctrl/⌘ Z, wait 2 s for the
autosave, then press **Reload** to confirm the edit came back from the server. Without
the API running the app works offline from the built-in reference plan.

## Test

```sh
pnpm test            # core + render (Vitest)
pnpm typecheck
cd apps/api && go test -race ./...
```

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | /projects | Summaries, newest first |
| POST | /projects | Full document; stored as version 1 |
| GET | /projects/{id} | Document, `ETag: "<version>"` |
| PUT | /projects/{id} | Requires `If-Match: "<version>"`; 409 with the current version if stale |
| DELETE | /projects/{id} | |

The API validates only the envelope (`schemaVersion`, `id`, `version`, `name`,
`levels`) and stores the rest as opaque JSON. The zod schema in `packages/core` is the
source of truth.

## Model notes

- Units are metres. Plan space is 2D (x right, y down as drawn); world space maps plan
  `(x, y)` to `(x, 0, y)` with +Y up.
- Walls reference shared vertex ids, so dragging a corner moves every wall that meets it.
- Openings are rectangular, so walls are built as boxes around them instead of CSG.
- Every edit is a command recorded as Immer patches; undo applies the inverse patches.
  Drags coalesce into one undo step via a `coalesceKey`.

## Next (Phase 1)

2D SVG plan editor with image underlay, scale calibration, wall and opening tools,
snapping, mitred corners, and room detection from closed wall loops.
