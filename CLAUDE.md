# Dream Home Designer

Browser app: trace a floor plan, furnish it, walk through it in 3D. pnpm monorepo
(TypeScript) + Go API. **Read `HANDOVER.md` first** for the decisions, current state and
next steps. The product plan lives at https://claude.ai/artifact/Wu33FsPzhspwQJBwgxeaP5.

## Layout
- `packages/core`: zod schema, commands + undo (Immer patches), geometry. Pure TS: no React or three.js.
- `packages/render`: project → three.js meshes.
- `apps/web`: Vite + React 18 + React Three Fiber + Zustand.
- `apps/api`: Go standard library REST API; documents are opaque JSON with `If-Match` versioning.
- `apps/edge`: Cloudflare Worker running `apps/api` as a Container (R2 storage); `functions/` is the
  Pages Function that routes `/api` to it.

## Rules
- Mutate the project only through a `Command` from `packages/core/src/commands.ts`; generate ids outside the recipe.
- Geometry goes in `packages/core` with Vitest tests; `render` only builds meshes.
- Metres and radians. Plan (x, y) maps to world (x, 0, y), +Y up. Walls share vertex ids.
- A schema change bumps `SCHEMA_VERSION` (TS) and `SchemaVersion` (Go) together, and regenerates `apps/api/internal/project/testdata/hdb4room.json`.
- Strict TS (`noUncheckedIndexedAccess`), Biome (single quotes, 100 cols), gofmt.
- Front-end design follows the vendored `design-taste-frontend` skill (app-screen rules, framed-sheet
  style); check UI changes with its inspector and by looking at screenshots.

## Commands
```sh
pnpm install && pnpm dev          # web :5173, /api proxied to :8080
pnpm test && pnpm typecheck && pnpm lint
pnpm --filter @dhd/web e2e        # Playwright against the build + Go API
cd apps/api && go run ./cmd/api   # STORE=memory to skip disk
cd apps/api && go test -race ./...
```

## Workflow (owner's standing instructions, 5 Nov 2026)
Work autonomously until the owner says stop: plan features, build them, review and squash-merge
your own PRs once CI is green, and keep going. The owner checks in now and then with bugs.
- **Agents** (`.claude/agents/`), used on every feature:
  - `project-manager` (also an expert architect and interior designer): specs with acceptance
    criteria, priorities, and a steady stream of new feature ideas; keeps the README roadmap.
  - `ux-reviewer`: designs interactions first, then reviews the built UI from screenshots on
    desktop and phone.
  - `qa-acceptance`: tests every flow end to end like a user, on all layouts, for bugs, edge
    cases and visual issues.
  - `tech-lead`: reviews the technical design before building and every diff before merging.
- **Flow per feature:** spec (project-manager) → design (ux-reviewer, tech-lead for anything
  structural) → build with tests → reviews (tech-lead on the diff, ux-reviewer and
  qa-acceptance on the running app) → fix findings → PR → merge when green.
- **Human-only actions** (secrets, accounts, billing, legal) and decisions only the owner can
  make: open a GitHub issue labelled `owner` (or say so in chat if issues can't be made), and
  carry on with other work. Stop only for an urgent blocker, with an issue saying so.
- Keep README.md's **Roadmap** (planned / in progress / done, and the production link) current.
- Don't make the repository public.
