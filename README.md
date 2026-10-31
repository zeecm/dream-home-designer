# Dream Home Designer

A free home planner in the browser: trace the floor plan you already have, furnish it, plan
the renovation, and walk through it in 3D. Made with Singapore HDB flats in mind, and works
for any plan.

**Try it:** <https://dream-home-designer.pages.dev> (the app opens on a sample 3-room flat)
· what it does: <https://dream-home-designer.pages.dev/welcome/>

> Status: **beta.** Everything below works and is tested; accounts (Google sign-in) are built
> and switched off until the server is configured. `HANDOVER.md` has the full state, the
> decisions behind it and what comes next.

## What it does

- **Trace a plan.** Upload an image or PDF of a floor plan, mark one length you know to set
  the scale, and draw walls over it (by mouse, keyboard or finger, with snapping and typed
  lengths). Rooms are found from the walls and measured as you go.
- **Doors, windows and openings**, with clearances to the corners shown as you place them.
- **Furnish** from a catalogue of box-built pieces and real models (CC0, from Poly Haven), or
  upload your own `.glb`. Pieces back onto walls, resize and turn by their handles.
- **Before and after.** Plan the renovation beside the flat as it is: hacked walls show
  dashed, and the changes are totalled.
- **3D and a walk-through.** Every edit appears in 3D at once, lit by the sun at the hour
  and orientation you choose. Walk through in first person; doors open as you reach them.
- **Share, download, history.** View-only or editable links, plan PNG/print, 3D PNG, GLB and
  project-file downloads, and earlier versions to restore.
- **Phones too:** finger drawing with a magnifier, pinch zoom, a thumb stick for walking, and
  a layout for phones on their side.

## Layout

```
apps/
  web/        Vite + React 18 + React Three Fiber + Zustand: the app (/) and the welcome page (/welcome/)
  api/        Go (standard library only): projects as opaque JSON with If-Match versioning;
              plan images, uploaded models and version history in R2
  edge/       Cloudflare Worker that runs apps/api as a Container; rate limits, sign-in (D1)
packages/
  core/       zod schema, commands with undo (Immer patches), all geometry. Pure TypeScript
  render/     project -> three.js meshes, rebuilt incrementally
functions/    the Pages Function that routes /api to the Worker
tools/models/ the pipeline that builds the furniture models from Poly Haven
```

`core` knows nothing about React or three.js; everything else depends on it. Every change to
a project goes through a `Command` in `packages/core`, so everything can be undone.

## Run it

Requires Node 22, pnpm 9 and Go 1.24.

```sh
pnpm install
cd apps/api && go run ./cmd/api      # terminal 1: API on :8080 (STORE=memory to skip disk)
pnpm dev                             # terminal 2: web on :5173, /api proxied to :8080
```

Open <http://localhost:5173>. Without the API the app still works, keeping plans in the
browser.

## Test

```sh
pnpm test && pnpm typecheck && pnpm lint   # Vitest (core, render, web, edge), tsc, Biome
pnpm --filter @dhd/web e2e                 # Playwright against the production build + Go API
cd apps/api && go test -race ./...
```

CI runs all of these on every pull request. The end-to-end suite includes touch gestures on
phone-sized screens, checked mid-gesture.

## Conventions

Metres and radians. Plan `(x, y)` is world `(x, 0, y)`, with +Y up. Walls share vertex ids, so
moving a corner moves every wall at it. Strict TypeScript, Biome (single quotes, 100
columns), gofmt. A schema change bumps `SCHEMA_VERSION` (TypeScript) and `SchemaVersion`
(Go) together. More in `CLAUDE.md` and `HANDOVER.md` §7.

## Licence and credits

MIT (see `LICENSE`).

- Furniture models: [Poly Haven](https://polyhaven.com), CC0. Each model's source page is in
  `packages/core/src/modelKinds.generated.ts`.
- Typeface: IBM Plex Sans, SIL Open Font License.
- Welcome page photograph: [“Kovan HDB flats”](https://commons.wikimedia.org/w/index.php?curid=3495359)
  by Angcr, CC BY 3.0, via Wikimedia Commons.
