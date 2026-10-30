# Dream Home Designer

Browser app: trace a floor plan, furnish it, walk through it in 3D. pnpm monorepo
(TypeScript) + Go API. **Read `HANDOVER.md` first** for the decisions, current state and
next steps. The product plan lives at https://claude.ai/artifact/Wu33FsPzhspwQJBwgxeaP5.

## Layout
- `packages/core`: zod schema, commands + undo (Immer patches), geometry. Pure TS: no React or three.js.
- `packages/render`: project → three.js meshes.
- `apps/web`: Vite + React 18 + React Three Fiber + Zustand.
- `apps/api`: Go standard library REST API; documents are opaque JSON with `If-Match` versioning.

## Rules
- Mutate the project only through a `Command` from `packages/core/src/commands.ts`; generate ids outside the recipe.
- Geometry goes in `packages/core` with Vitest tests; `render` only builds meshes.
- Metres and radians. Plan (x, y) maps to world (x, 0, y), +Y up. Walls share vertex ids.
- A schema change bumps `SCHEMA_VERSION` (TS) and `SchemaVersion` (Go) together, and regenerates `apps/api/internal/project/testdata/hdb4room.json`.
- Strict TS (`noUncheckedIndexedAccess`), Biome (single quotes, 100 cols), gofmt.

## Commands
```sh
pnpm install && pnpm dev          # web :5173, /api proxied to :8080
pnpm test && pnpm typecheck && pnpm lint
cd apps/api && go run ./cmd/api   # STORE=memory to skip disk
cd apps/api && go test -race ./...
```
