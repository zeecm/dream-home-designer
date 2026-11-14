# Dream Home Designer

A free home planner in the browser: trace the floor plan you already have, furnish it, plan
the renovation, and walk through it in 3D. Made with Singapore HDB flats in mind, and works
for any plan.

**Try it:** <https://dream-home-designer.pages.dev> (the app opens on a sample 3-room flat)
· what it does: <https://dream-home-designer.pages.dev/welcome/>

> Status: **beta.** Everything below works and is tested; accounts (Google sign-in) are built
> and switched off until the server is configured. `HANDOVER.md` has the full state, the
> decisions behind it and what comes next.

## Roadmap and status

**Production:** <https://dream-home-designer.pages.dev> (deploys from `main`). Specs are in
[`docs/specs/`](docs/specs/); things that need the owner are GitHub issues labelled `owner`.

### Done
- Trace a plan over an uploaded image or PDF: scale, snapping, typed lengths; rooms found
  and measured from the walls.
- Walls with mitred corners, one-sided walls, room boundaries; drag, split and move walls and
  whole rooms. Doors, windows and openings with HDB widths and corner clearances.
- Furniture: box-built pieces and 51 real models (Poly Haven, CC0); upload your own `.glb`;
  handles to resize and turn; pieces stand on tables and desks.
- Floor finishes, wall paint per side, lamps; sun and sky for any hour and orientation.
- Before and after: a renovation version, hacked and new walls, a room-by-room change list,
  side-by-side 3D compare.
- 3D view and first-person walk with collision, opening doors, footsteps and a mini-map.
- Phones: finger drawing with a magnifier, pinch and coasting pan, thumb sticks, landscape.
- Sharing (view or edit links), downloads (PNG, print, GLB, project file), version history.
- Go API on Cloudflare Containers with R2 storage, rate limits and a daily cap; Google
  sign-in built, waiting for the owner's keys.
- Walk-through: a 110° field of view on every screen (60–120°), touch look that turns the
  way you swipe, and a look stick.
- Glass walls, half walls (with fixed glass above), and doors that slide, fold, go into a
  pocket or open double, animated in the walk-through.
  [spec](docs/specs/wall-and-door-types.md)
- People for scale (a person and a child) in the furniture catalogue.
- Any wall colour (a colour picker) and eight wallpapers.
- AI with your own key (Claude, OpenAI or Gemini): trace walls from a plan image, looked over
  before it goes in. [spec](docs/specs/ai-layouts.md)
- Photo-real renders of any 3D or walk-through view (phones too), with your own OpenAI or Gemini key,
  told the true room sizes and the furniture in view; from above they start at eye height.
- AI suggested layouts from a short brief: up to three, checked against what HDB lets you
  change, one click to make one the renovation.
- Structural and household-shelter walls marked (hatched), with hacking warnings: shelter
  walls can't be changed in a renovation, structural ones warn.
  [spec](docs/specs/structural-walls.md)
- Clearance checks: room to open wardrobes, drawers, fridge and cabinets, to sit at a desk
  and get into bed; door swings, overlaps and pieces in walls, shown in red as you arrange.
  [spec](docs/specs/clearance-checks.md)
- Built-in carpentry (wardrobes, shoe cabinet, TV console, kitchen runs) and a renovation cost
  estimate from typical Singapore prices, with your own rates, Copy and Print.
  [spec](docs/specs/carpentry-cost.md)
- Your own furniture by its measured size, and whether it gets in: every door from the main
  door, turning included, drawn on the plan. [spec](docs/specs/my-furniture.md)
- A dimensioned plan for contractors: to scale on A4 or A3, chain dimensions, door and window
  widths, room sizes, the hacking plan and change list; print or save as PDF.
  [spec](docs/specs/dimensioned-export.md)
- An electrical and lighting plan: sockets, switches, lights, data points and aircon with its
  trunking (square to the walls and hugging them, or routed along the walls to the ledge in
  one tap), at their heights, kept clear of doors and windows; counted into the estimate and
  drawn on the contractor sheet with a schedule. [spec](docs/specs/electrical.md)
- Clearance checks, slice 2: walkways from the main door to every room and bed side, their
  narrowest point drawn and measured; room to pull out dining chairs; door clashes (doors that
  hit each other or a wardrobe's or fridge's doors); shortfall labels on the plan, and the
  first problem read out on a drop. [spec](docs/specs/clearance-checks.md#slice-2)
- Comments on the plan: pins anyone with the share link can leave, reply to and resolve, for
  family decisions; the owner chooses who can comment. [spec](docs/specs/plan-comments.md)
- Suggested electrical points: one button gives the usual points for each room, placed by your
  furniture and priced before you add them. [spec](docs/specs/slice-2s.md)
- The lift on the way in: pick your block's lift (typical HDB, older, stretcher, your own
  measurements or none) and see whether a piece goes in as it stands, on its back, on end or
  tilted; a sofa's diagonal depth can be added or changed later.
  [spec](docs/specs/slice-2s.md#b1-the-lift-pr-2-schema-10)

- AI interior designer, slice 1: with your own key, a whole renovation proposed for the flat
  (walls HDB allows, room uses, furniture, carpentry, paint, a cost), checked like your own
  edits; versions to preview, accept in parts with Undo, and change room by room with feedback;
  a cost check before every run and a spending limit. [spec](docs/specs/ai-interior-designer.md)
- AI interior designer, slice 1c: compare Before and two versions side by side (one at a time
  on a phone), and what you change by hand after accepting is kept by the next version and
  by accepting again. [spec](docs/specs/ai-interior-designer.md#6-compare)
- Contractor sheet: the depth of each recess in the outside walls (the air-con ledge slot and
  the like). The estimate covers every level of a multi-level home, with a subtotal for each
  and a plain note when a level isn't priced. [spec](docs/specs/slice-2s.md#c1-notch-depths-on-the-contractor-sheet-pr-3)
- Exact render, slice 1: a photo-real picture drawn on your device from the 3D model itself
  (daylight through the windows, lamps, soft shadows), so nothing is added or moved; free, no
  key. [spec](docs/specs/exact-render.md)
- AI interior designer v2, slice 2: a designer you talk to. A conversation panel (a sheet on
  the phone) that greets you from your plan, asks who lives here and who sleeps where, and
  proposes room by room at a price shown first; you type to it and it streams its reply, asks
  back, pushes back with the app's own measurements, and says what it plans before a paid run;
  Decisions you can edit; each change accepted on its own with Undo; alternatives A/B/C, a
  Versions list, Bring this back, Put it back, Copy, Download and Start over. The layout work runs
  in a background worker. [spec](docs/specs/ai-designer-v2.md)
- Storage meter, slice 1: clothes, shoes, kitchen and everything else against who lives here,
  room by room, with shortfalls priced as built-in carpentry. [spec](docs/specs/storage-meter.md)
- A wall seen straight on (elevation), slice 1: any wall drawn to scale with its finish, openings,
  pieces and points, dimensions in mm and notes, Before and After, saved as a picture.
  [spec](docs/specs/elevation.md)
- AI interior designer v2, slice 1: layouts that pass the app's checks. The designer says what
  it intends (against which wall, facing what, near what) and a solver places the pieces; a bed
  for everyone, seating that faces the room, 0.60 m between dining and lounge, clear walkways,
  smaller pieces swapped in when a room is tight, with regression cases.
  [spec](docs/specs/ai-designer-v2.md)
- Smooth dragging on big plans: room labels, wall statuses and the walkway check work out only
  what a drag changed (a 70-room plan went from about 1 s to under 0.15 s a step).
- The 3D view draws only when something changes (it redrew 60 times a second while idle), and on a
  phone a new designer proposal is in sight on the plan before you accept it.
- AI interior designer v2, slice 3a part A: house rules ("no bed facing the door", "keep the
  corridor clear") kept from the conversation, checked on every proposal and accept, shown on the
  plan, renamed, edited and deleted with Undo. [spec](docs/specs/ai-designer-v2.md)
- AI interior designer v2, slice 3b part 1: the storage lens. Each proposal is scored on the storage
  meter for who sleeps where and how much they own; a short room keeps its storage pieces where a
  layout can, and never at the cost of a check. [spec](docs/specs/ai-designer-v2.md)
- AI runs that survive a locked phone, part 1: a designer run saves its progress after each step
  and carries on where it stopped when you come back, never past the figure you approved; a step
  cut off is sent again at most twice before it asks. [spec](docs/specs/locked-phone-runs.md)
- AI costs always have a figure (#67): prices for every Gemini 3 model, checked against Google's
  page; a model with no price is refused rather than run unpriced; Gemini 3 thinks less when an
  answer runs too long, and fix rounds start at low thinking.

### In progress
- Reviews of the AI features with real keys (owner) and a recorded real reading as a test.
- AI designer after an Accept (issue #66): redesigns keep the pieces you accepted (the bed, the
  sofa, the fridge) where they stand, and checks missed by a centimetre or two are mended by a
  small move (PR 1); the model told why a piece couldn't be kept, and the card offering the
  free fix when the same failures come back (PR 2).
- The designer listens (issue #66 part 2, PR A): every failure on the card named, a missing bed
  included, in your names; the card says when it sent a room back to be fixed and how that went;
  the designer is told what the app found and why a piece was left out, never says it can't
  check, and says which problems a plan fixes. Next: free fixes, fix rounds while progressing,
  room vetting, no paying twice for the same failures. [spec](docs/specs/designer-listens.md)
- AI interior designer v2, slice 3a part B: point at the plan (a piece or a spot, "keep this",
  "why here?", "something else here") with the pointers sent with your message.
- AI interior designer v2, slice 3b part 2: a second look at each proposal (a picture of the plan
  the model checks for flow, focal point, too empty or too full), acted on only where the app's
  checks agree, and house rules it suggests offered to keep.
- AI runs that survive a locked phone, part 2: opt-in cloud runs that keep going while the phone is
  locked, with a push when done; off in production until the owner has tried it with a real key.
  Keys stored on the server are built next but stay off until Google sign-in is set up.

### Planned
1. Levels you can switch between in the editor: today it shows only the first level of a
   multi-level home (a maisonette), so the upper floor can't be drawn or designed.
2. AI interior designer v2, slice 3b part 3: regression cases from the second look, and asking the
   designer on a comment; slice 3a part C: the solver aims for house rules, not only checks them.
3. Elevations on the contractor sheet (elevation slice 2), with piece labels, the saved
   picture's font and the iPhone canvas size. [spec](docs/specs/elevation.md)
4. Storage meter 1b: storage beds, a pantry and a bay seat. [spec](docs/specs/storage-meter.md)
5. AI interior designer v2, slice 4: sharing a conversation.
6. Exact render, slice 2: quality settings, real textures, AI polish; daylight bounced up off
   the ground outside, and dark dots seen through a far window.
7. Elevation 1b: dragging heights in the wall view.
8. Storage meter slice 2: the household saved in the project.

### Waiting on the owner
- Google sign-in keys ([#21](https://github.com/zeecm/dream-home-designer/issues/21)) and the
  desk socket height ([#42](https://github.com/zeecm/dream-home-designer/issues/42)).

### On hold (owner, 7 Nov)
- Ageing parents check (the "Older person" check): slice 1 is built and shipped; grab bars
  (1b) and steps and ramps (2) are paused, and so is the designer's Older person lens.
  [spec](docs/specs/ageing-parents.md)

More ideas: [`docs/specs/ideas.md`](docs/specs/ideas.md).

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
