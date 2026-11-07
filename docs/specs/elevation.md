# Spec: A wall seen straight on (elevation)

Project-manager, 7 Nov 2026. Roadmap "Planned" item 2. It builds on
[electrical](electrical.md) (points on a wall face at a height, `clearAlong`), [carpentry and
cost](carpentry-cost.md) (built-in pieces), the [contractor sheet](dimensioned-export.md)
(mm dimensions, `roundChain`, print from a hidden iframe) and the
[storage meter](storage-meter.md), which left "inside a wardrobe" to this view. Overall effort
**L**, in four PRs. **Slices 1, 1b and 2 need no schema change**; slice 3 (inside a wardrobe)
does.

**Problem.** A plan is drawn from above, so every height is invisible: the socket that ends
up behind the wardrobe, the wall cabinet that hangs too low over the counter, the wardrobe that
covers half the window, the aircon unit over the feature wall. Owners type "1150" into a field
and can't picture it. Carpenters and electricians in Singapore work from elevations ("TV wall",
"kitchen wall") with heights from the floor; today the owner sketches them by hand on site or
sends a photo with numbers scribbled on. The app already knows every height: openings have a
sill and a height, points a height, pieces an elevation and a size, walls a height and a finish.
This view draws one wall face as you would see it standing in the room, to scale, measured.

## User stories
- **Homeowner, feature wall.** I tap the living room wall I want in Sage with the TV on it and
  see it straight on: the paint or wallpaper, the console, the TV, the sockets and the aircon,
  so I can tell if it looks balanced and nothing sits in the wrong place.
- **Homeowner, bedroom.** I see whether the bedside sockets clear the bedside tables, and the
  app tells me a socket is hidden behind the wardrobe before the electrician chases it.
- **Homeowner, walking round.** I step from wall to wall round a room (A, B, C, D), like an
  interior designer's drawing set.
- **Homeowner, moving a socket.** I drag a socket up the wall and watch its height in mm
  (slice 1b).
- **Carpenter.** I get each carpentry wall with its lengths along the wall and the heights of
  the sill, the window head, the counter, the wall cabinet underside and the ceiling, in mm, and
  which sockets my carcass must leave a cut-out for (slice 2, on the contractor sheet).
- **Electrician.** Each point's height to its centre and its distance from the corner, on the
  wall it is on.
- **Family.** I send one wall as a picture to the family chat or to the carpenter on WhatsApp.

## Decisions

**Value order** (value to owners against effort and risk):

| # | Item | Value | Effort | Schema | PR |
|---|---|---|---|---|---|
| A | Faces of a room (straight runs, named A, B, C…) and the elevation of one face: wall, finish, openings, pieces, points, trunking; dimensions; notes (hidden socket, covered window, low wall cabinet, shelter fixings, too tall) | Highest. The whole point; every plan has it today. | M | none | 1 |
| B | Viewer: open from a wall, room, point, opening or piece; step round the room; other side; Before/After with changes; save as PNG | High. | S+ | none | 1 |
| C | Drag in the elevation: a point's height and place; a window's sill and head; a hung piece's height | Medium-high. Typing already works; dragging is how owners think. | S | none | 2 |
| D | Elevation pages on the contractor sheet, with markers on the plan page | High for the carpenter and electrician. | S+ | none | 3 |
| E | Inside a wardrobe: doors off, hanging, double hang, shelves, drawers; the storage meter counts rail length | Medium. Closes the storage meter's gap; carpenters quote drawers extra. | M | **next free** (12 if the ageing check's slice 2 has shipped as 11) | 4 |

**Split.**
1. **PR 1 (M+): slice 1, A + B.** Pure core geometry plus the viewer.
2. **PR 2 (S): slice 1b, C.** Uses the existing `updatePoint`, `updateOpening`, `updateItem`.
3. **PR 3 (S+): slice 2, D.** Print only; reuses PR 1's SVG.
4. **PR 4 (M): slice 3, E.** Schema bump: deploy the API first, then check that production
   accepts a save at the new version.

**Line drawing, not a 3D render.** The elevation is an SVG drawn from core geometry, like the
contractor sheet: crisp at any zoom, printable, measurable, fast on a phone, and the same
drawing on screen and on paper. Real (GLB) models are drawn as their outline with their name,
not their silhouette (see Out of scope). Box-built pieces are drawn from their parts.

**What is saved.** Nothing. Which face is open, the toggles and the sheet choices are editor
state (per browser). Face letters are derived, not stored.

## What a "face" is

Core `roomFaces(level, roomId) → Face[]`:
- A **face** is a maximal straight run of the room's outline: consecutive outline edges within
  1° of each other whose face lines are within 10 mm. So a wall split at a T junction on its far
  side (the neighbour's wall meets it from behind) is **one** face; an outside wall that steps
  in by 50 mm at a window is **three** (the 50 mm return is a face of its own).
- Each face lists its walls and boundary lines with the side and stretch of each; its two ends
  (inside corner to inside corner, from the frames' face spans), its length, the normal into the
  room, the room's ceiling (`room.ceilingHeight ?? level.ceilingHeight`) and the room.
- **Seen from inside the room, facing the wall:** what is on your left is on the left. `u` runs
  from the face's left end, `z` up from the floor.
- **Order and letters:** clockwise on the plan (as you turn to your right), starting at
  **A**, the face holding the door you enter by (as Suggest points finds it: the first door on
  the fewest-doors route from `entranceDoor`; with no main door, the room's widest door; with no
  door, the face nearest the top of the plan, then the leftmost). Room holes (a column) add
  their faces after the outline, clockwise.
- **Stepping** round the room skips faces under 0.30 m long that hold nothing (no opening,
  point or piece). They can still be opened from the wall itself.
- **A friendly name** after the letter, first match: has the entrance door "door wall"; a bed's
  head against it "bed wall"; a TV, TV console or built-in TV console "TV wall"; a kitchen sink
  "sink wall"; a hob "hob wall"; a built-in wardrobe "wardrobe wall"; a window "window wall";
  an open boundary "open to Dry kitchen". E.g. "Main bedroom · C · bed wall".
- `faceAt(level, wallId, side)` gives the face a wall side belongs to (null if no room faces
  it). Outside faces (the façade, the corridor side of the main door) have no elevation.

## What the elevation shows

Core `wallElevation(level, face, opts) → Elevation`, all in metres, `u` along and `z` up.

**The wall.**
- Floor line and ceiling line (the room's ceiling); the face's ends as the side walls cut
  through (a thin section band, filled grey; hatched for structural, cross-hatched for the
  shelter, as on the plan).
- **Solid wall:** filled with that side's finish (`materialLeft`/`materialRight` through
  `finish()`): its colour, or the wallpaper tiled at its real size (`TILE` 0.6 m, from
  `wallpaperCanvas`). The finish's name in the header, e.g. "Sage paint" or "Fluted wood
  wallpaper".
- **Half wall:** solid to its height, then "open above" (the ceiling line dashed over it), or
  fixed glass to the ceiling (`glassAbove`). Its height dimensioned.
- **Glass wall:** framed panes as `glassPartition` builds them (frame and mullions), light glass
  fill, label "Glass partition". No points can be on it (as today).
- **Boundary (open to another room):** no wall; dashed outline, label "Open to Living and
  dining". Pieces in front of it still draw.
- **Mixed runs** (a solid wall, then glass, in one straight line): each stretch drawn as itself.

**Openings** on the face's walls, at their `t`, `width`, `sill` and `height`:
- **Window:** frame and glass, sill and head lines.
- **Door:** the leaf closed, the handle on the latch side (`latchEnd`); a swing door adds the
  dashed chevron pointing to the hinge side (the drawing convention); sliding, pocket, bi-fold and
  folding doors draw their panels (`doorPanels`) with a small arrow or fold marks; glazed leaves
  in clear, frosted or fluted glass. A door opening into the room is drawn shut.
- **Passage:** an empty frame to its head; wall above it to the ceiling.

**Pieces** (`items`):
- **In front of the wall:** every piece of the room whose footprint comes within **0.65 m** of
  the face (just more than a wardrobe or a counter), drawn far to near, so a bedside table draws
  over the bed's side. A bed whose head touches the wall draws whole (its projection). Pieces on
  the side walls inside the band draw side-on at the edges, as an architect draws them.
- Toggle **Furniture: Against the wall (default) · Whole room · None**. "Whole room" draws every
  piece in the room, faint beyond 0.65 m.
- **Box-built pieces:** each part's box projected square onto the face (exact for a piece square
  to the wall; a piece turned more than 1° draws the outline of its projected parts, dashed).
- **Real models and uploaded `.glb`:** their outline (size × scale) with their name, soft fill.
- **Carpentry**, indicative fronts so it reads as carpentry: a wardrobe or tall cabinet has
  equal doors no wider than 0.60 m and, when over 2.2 m tall, a top-cabinet line at 2.10 m (the
  storage meter's `TOP_CABINET_FROM`); a kitchen base run has a 0.10 m plinth, a countertop line
  and 0.60 m door modules; a wall run's doors are 0.60 m. Note in the panel: "Doors are
  indicative: your carpenter's drawing sets them."
- People for scale draw like any piece: a good cue for how high 1150 is.

**Points** on this face (`points` whose `wall.wallId` is one of the face's walls, on its side):
plates at their real size (86 × 86, double and cooker 146 × 86, aircon unit 900 × 290) with the
plan's symbol inside, numbered 1…n left to right. Ceiling points (lights, fans) are not drawn.
**Trunking** legs that run along this face (within 0.3 m) draw as a dashed band 80 mm deep under
the ceiling, with their length. Points on the other side of the same wall are not drawn.

**Notes** (the panel, and a red outline on the drawing; advice only, never blocking). Exact copy:

| Note | When | Basis |
|---|---|---|
| "Socket 3 is behind the Built-in wardrobe: you won't reach it. Move it, or ask the carpenter for a cut-out." | A point's plate overlaps the outline of a piece with its back within 0.10 m of the face that is at least 1.5 m tall (wardrobes, tall cabinets, bookshelves) or a bed. Not for a fridge, a kitchen base, sink or hob cabinet, a TV console or a bedside table (points behind those are meant to be there). The word is the kind: "Switch 2", "TV point 4". | Common practice |
| "The Built-in wardrobe covers 0.50 m of Window 1." | A piece with its back within 0.10 m overlaps a window by more than 0.05 m along and its top is more than 0.05 m above the sill. | Common practice |
| "0.45 m between the counter and the wall cabinets: 0.60–0.70 m is usual, and at least 0.65 m over the hob for the hood." | A wall cabinet (carpentry `wall` or `kitchen-wall`) over a base, sink or hob piece on the same face with a gap under 0.55 m, or under 0.65 m over a hob. | **PM**, not verified; hood makers ask 650–750 mm |
| "The Kitchen wall run is fixed to the household shelter wall: HDB doesn't allow drilling it." | A piece hung on the wall (`furnitureLayer` 'high') on a face of a shelter wall (`wallStatus` shelter), either side. | HDB shelter rules (as the electrical warning) |
| "The Built-in wardrobe is 0.10 m taller than this room's ceiling." | A piece's top above the room's ceiling by more than 0.01 m (a built-in made to the level's ceiling in a room with a lower one). | Geometry |

Point warnings that already exist (shelter, structural, wet room) show on the point as on the
plan.

## Dimensions and heights

In mm, to 10 mm, through `roundChain` so pieces add up (as the contractor sheet); a point's
height to 1 mm, as typed.
- **Along the bottom**, up to three tiers: tier 0, the edges of openings and of pieces against
  the wall; tier 1, the openings only (piers and openings, what the builder needs); tier 2, the
  face's overall clear length (inside corner to inside corner). A tier equal to the next is
  dropped; stops within 5 mm merge; a piece under 20 mm joins its neighbour.
- **Heights**, vertical dimensions beside what they measure: the ceiling (left edge, floor to
  ceiling); each window's sill and head from the floor ("900", "2100"); a door's head; a half
  wall's top; the counter top and the wall cabinets' underside and top; a hung piece's underside.
  Two heights within 10 mm share one line.
- **Points:** each plate's tag reads "1 · h1150" (height to the plate's centre; an aircon unit
  to its top, as the Inspector says). A points chain above the floor line measures each point's
  centre from the face's left end.
- **Schedule** under the drawing: "1 · 13A double socket · h1150 · 450 from left · Kitchen B"
  per point, then the notes.
- Foot of the drawing: "Heights from the finished floor, to the centre of each plate (aircon: to
  the top of the unit). Check the floor finish on site."
- Toggle **Dimensions** (on). At a phone's fit zoom, tier 0 and the points chain hide until you
  zoom in, so labels stay 11 px or larger and never overlap.

## Choosing a wall and the viewer

**Entry.**
- **A wall selected** (plan, either view): Inspector row "See it straight on" with one button per
  side that faces a room, named by the room: [Main bedroom side] [Bedroom side].
- **A room selected:** "Walls of this room" [See walls] opens at A.
- **A point, opening or piece against a wall selected:** [See on its wall] opens that face with
  it selected.
- Keyboard: **L** ("look at it") opens the elevation of the selected wall (the side nearer the
  pointer, else the side that faces a room), room or thing. **E** is taken by the Electrical
  tool; ux-reviewer to confirm L.

**Desktop.** The elevation takes the right half of the stage (where 3D sits in split view), the
plan stays on the left, editable. A header: "Main bedroom · C · bed wall · 3 900 × 2 600 mm",
the finish, [‹] [›] (previous and next face round the room, also **[** and **]**), [Other side]
(only when the other side faces a room; it flips the face: what was on the left is now on the
right), the toggles (Furniture, Colour, Dimensions), [Save as image], [Close] (also Esc, back to
the view you were in). On the plan, the open face draws highlighted with an elevation marker (a
triangle with its letter) on the room side, `data-export="skip"`.

**Phone** (one view): the elevation fills the stage. A key plan (96 px, top left, as the walk
mini-map) shows the room with the face and its marker; tap another face there to jump to it, or
the key plan's corner to go back to the plan. A bottom bar: [‹] "C of 4" [›], [Other side], [⋯]
(toggles, Save as image), [Close]; all targets 44 px. Pinch to zoom and pan as on the plan;
double-tap fits. In portrait a one-time hint: "Turn your phone for a bigger view." The
Inspector sheet works as on the plan.

**Selecting.** Tapping a point, opening or piece in the elevation selects it (the same selection
as the plan, so the Inspector shows it and the plan highlights it). Every hit target is at least
44 px on phones (invisible padding round an 86 mm plate). Tapping the wall selects the wall.

**Live.** Any committed edit, undo and redo included, redraws the elevation in the same frame
(no search: a pass over the face's walls, openings, points and the room's items). If the face's
wall is deleted or merged away: "That wall is gone." with [Close]; Undo brings it back and the
view returns to it. Opening, closing and stepping add nothing to the undo history and don't save.

**Save as image.** A PNG of the drawing as shown (white background, dimensions and schedule),
named "Main bedroom – C bed wall.png". On a phone it uses the share sheet where the browser has
one (WhatsApp), else downloads.

**View links.** The elevation opens and steps; no drag; Save as image works.

**Colour.** Toggle **Colour** (on): finishes and soft piece fills. Off: a black line drawing, as
it prints. The drawing is dark on a white sheet in both themes (it shows real colours).

## Before and After

- The elevation shows the version shown, and follows the app's version switch. Switching version
  keeps the face: the face in the other version on the same line (within 10 mm and 1°) facing
  the same way.
- **After, with a renovation**, changes are coloured as on the electrical page: new openings,
  points and pieces (new or resized, by id) teal; closed openings, removed points and pieces
  red dashed; a moved point teal with its old place faint; a stretch of the face hacked
  (`renovationDiff.demolished` on this line) red dashed with "Hacked"; new wall on the face teal.
  Toggle off with Colour.
- **The whole wall hacked in After:** "This wall is taken down in the renovation." [See it as it
  is] switches to Before. In Before, the header says "Taken down in the renovation".
- **Rooms that merge in After** (a bedroom opened to the living room): the face now belongs to
  the bigger room and takes its letters.

## Edge cases
- **Slanted wall:** its own face (runs break at more than 1°); drawn true length, square to the
  face; pieces square to it draw exactly, others as projected outlines.
- **A wall with rooms on both sides:** each side is its own face; [Other side] flips between
  them. Paint is per side, so each shows its own finish.
- **A long wall shared by two rooms on one side** (the corridor wall past two bedrooms): each
  room has its own face; a whole run across rooms is out of scope.
- **Room outline steps and notches** (the air-con ledge recess): tiny returns are faces, skipped
  when stepping unless they hold something.
- **An L-shaped kitchen:** each leg is a face; the run on the side wall shows side-on at the
  corner.
- **A room with a column (hole):** its faces come after the outline's.
- **An opening wider than the face, or across a corner:** clamped to the face, as the plan does.
- **Different ceilings** (a bathroom at 2.4 m on a 2.6 m level): the room's ceiling; a wall
  taller than it draws to the room's ceiling.
- **Points above a half wall's top or on glass:** can't exist (the electrical rules); a point
  left on a wall that became glass shows a red mark and the existing warning.
- **Boundary faces:** "Open to …"; no points, no finish.
- **A face that is very long** (a 10 m corridor): fits the width; a phone suggests landscape.
- **Items crossing two faces:** each face draws what it sees.
- **Pieces stacked** (a lamp on a bedside, a TV on a console): drawn at their elevation.
- **Empty face:** wall, finish, ceiling, overall length; the panel: "Nothing on this wall yet."
- **Many points** (a kitchen with 10): tags are numbered; labels that would overlap move above
  with a leader line; the schedule always lists them all.
- **Multi-level homes:** the level shown.

## Slice 1 as built (PR 1)

Built 7 Nov 2026 from this spec, the tech-lead's design review and the ux-reviewer's
interaction design. Where they differ from the sections above, this section wins. On screen it
is the **wall view**: the word "elevation" is never shown.

**Core** (`packages/core`, Vitest beside each file):
- `chains.ts`: the plan's dimension chains moved out of `dimensions.ts` (stops merged within 5 mm,
  pieces under 20 mm joined, `tieredChains`), shared by the plan and the wall view.
- `faces.ts`: `roomFaces`, `faceAt`, `resolveFace`, `faceRef`, `stepFace`, `otherSide`,
  `itemFace`, `roomItems`. A face is `RoomFace` (designer code already exports a `Face`), with
  `kind` `'wall' | 'return' | 'hole'`, `dir`, `steppable` and possibly no stretches. A
  `FaceRef` `{ roomId, wallId, side, mid, normal }` replaces the string `key`: wall and side
  first, then the same line (10 mm, 1°) facing the same way, so a wall split by a T, an undo or
  the switch to After keeps the face. `roomShapes` keeps hole loops as vertex ids. Cached per
  frozen level (geometry, faces, items, entries). Faces under 5 mm (a wall side its mitres use
  up) are dropped.
- **Face A** is the face holding the door you come into the room by: the *last* door on the
  fewest-doors route from the main door (`roomEntries`, exported and cached in `delivery.ts`;
  Suggest uses it too), or for a room reached across a boundary, that boundary; then the
  room's widest door; then the face nearest the top, then the leftmost.
- `elevation.ts`: `wallElevation(level, face, { furniture, statusOf })` with one projection,
  `u` along and `v` into the room. A point's `z` is its plate's centre and `tagHeight` what its
  tag says (an aircon unit's top). Pieces are drawn far from you first (nearest the wall first,
  so a piece further into the room covers one behind it). A counter's height is its worktop
  (`top`), not a hob's glass on it. `elevationLabels(elev, pxPerM)` decides what fits:
  tier 0 only when all its figures fit at 11 px, tiers 1 and 2 always with the figures that
  fit, tags full ("1 · h1150"), short ("1") or none, and height figures that keep clear of
  each other across columns. `elevationChanges` uses `renovationDiff` and
  `electricalChanges`, cached per pair of levels.
- Shelter and structural checks use the flat as it is (`statusOf`, Before's status in After).
  A 'likely' structural wall is hatched like a structural one.

**Spec defects fixed:**
1. **AC3** is built the flush-face way: the top wall in three, all `side: 'left'`, 0.10 / 0.15 /
   0.10 thick, so the inside face steps 50 mm and the outside stays flush. Faces 0.95, 0.05,
   2.00, 0.05, 0.95; the 0.05 m steps are `kind: 'return'` (a junction's edge, no wall side),
   skipped when stepping; `faceAt` on the middle wall gives the 2.00 m face. A real 50 mm
   return wall is a `wall` face `faceAt` finds.
2. **Face A** as above (the last door on the route, or the boundary).
3. **The face key** is a `FaceRef` (above).
4. **Wall cabinet gap:** the note keeps its 0.55 m and 0.65 m thresholds, with one text for
   each: "0.45 m between the counter and the wall cabinets: 0.55 m or more is usual." and, over
   a hob (`assetId` `kitchen-hob`), "0.55 m from the hob to the wall cabinet above: a cooker
   hood needs at least 0.65 m." The catalogue's wall cabinet at 1.45 m over a 0.90 m counter
   (0.55 m, measured from the worktop) gets no note except over a hob. Windows are numbered left
   to right on the face ("Window 1").
5. **Stub walls** (dead ends pruned from room loops) draw as a section band across the face;
   points on them have no wall view.
6. **Wall status in After:** Before's (`statusOf`).

**Faces and pieces as built (after review).** Letters go only to the faces stepping stops at
(A, B, C… with none skipped); a tiny empty face between takes the letter before it, primed
("C′"). A side wall is cut through (a section band) only at an inside corner, its neighbours
taken from the face's own loop, so a column's faces and an L's outside corner have none. A
piece wholly behind a face (beyond a column, past a notch's side) isn't drawn on it. Only a
piece backed onto a wall names it ("wardrobe wall"); a piece in a corner backed onto the other
wall isn't drawn side-on (a bed still is, its length running along the wall).

**Notes as built.** "Hidden" counts a bed, or a piece at least 1.5 m tall in Bedroom, Living,
Dining, Storage or Built-in (so not a fridge, a lamp, a plant or a person). "Covers" leaves out
lamps, plants and people. Names mid-sentence are in lower case ("behind the built-in
wardrobe"). Each note is numbered with a "!" badge on its red outline, placed clear of the
tags; a note about a point rides on its tag instead ("3 · h300 !1"). The header's "N to check"
counts the notes and the points with their own warnings (shelter, structural, wet room), which
are listed with a ring and ringed on the drawing: a quieter kind than a note.

**The viewer** (`apps/web/src/elevation/`):
- `ElevationSvg.tsx` is pure (elevation, labels, scale), drawn in metres on paper colours, so
  slice 2 can `renderToStaticMarkup` it. `ElevationView.tsx` holds the header, the sheet and the
  list; `nav.ts` stepping and flipping; `open.ts` opening and closing; `PlanMarkers.tsx` the
  letters on the plan; `Entry.tsx` the Inspector's buttons; `saveImage.ts` the PNG.
- Editor state `elevation: { ref, returnTo }` (and `fitBox`, the room the plan fits to). Nothing
  goes in the undo history or the save. The 3D view is unmounted while the wall view is open.
- **Ways in:** a wall's Inspector row "See it straight on", right under its title, one button
  per side that faces a room, named by the room ("Main bedroom side"); a room's "See its walls"
  under its floor area; a point, door, window or piece on or against a wall: "See on its wall".
  **L** opens the selected wall (the side facing the room last selected, else its left side),
  room or thing. On a view link the way in sits above the locked Inspector fields.
- **Desktop:** the wall view takes the 3D half, about 60% of the stage, the plan beside it
  (fitted to the room) and the Inspector stay. Header line 1: "Main bedroom · D · wardrobe
  wall", then "2 916 × 2 600 mm · Plain paint" in grey and "2 to check". Line 2: [‹] D of 6
  [›] (also `[` and `]`), [See from Bedroom] (not "Other side", which the wall Inspector already
  uses; only when a room is on the other side), [Show ▾] (Furniture: Against the wall · None;
  Dimensions: Shown · None), [Save image]; Close is a × in the title row. With a renovation the
  app's own Before | After switch is the one (a phone shows the view's own and hides the app's),
  and in After a key: New · Moved · Removed · Hacked. Stepping or flipping with a wall selected
  moves the selection to the wall shown; the way in to the wall already open is hidden.
  Menus close on Esc (which goes no further), a press outside, and after choosing.
- **On the plan:** every steppable wall of the room gets its letter in a faint marker (24 px)
  pointing at it, the open one filled in the accent colour; clicking a letter opens that wall.
  A marker moves along its wall clear of the selected wall's length tag and the room names.
  The plan frames the room closely. Not in a saved picture of the plan.
- **Esc:** the first press clears the selection, the next closes, and focus goes back to the
  button the view was opened from. 1, 2 and 3 close it and show that view.
- **The drawing** is on a framed white sheet (white in both themes). Wheel or pinch to zoom,
  drag to pan, double tap to fit; labels are laid out again when a zoom ends. Tapping a point,
  opening, piece or the wall selects it (targets at least 24 px, 44 px on a phone).
- **The list** under the drawing is real text: what to check, then each point ("1 · 13A double
  socket — 1150 from floor · 450 from left corner", and its warnings), each row selecting its
  thing; "Nothing on this wall yet." for an empty face; "Doors are indicative…" when fronts are
  drawn; the heights note.
- **Phone:** the wall view fills the stage and its bar takes the tool bar's place: [‹] [D of 6]
  (a menu of the room's walls, which replaces the key plan) [›] [See from / room name] (two
  lines; its place kept empty when no room is behind) [⋯] (furniture, dimensions, Save image,
  and on its side Hide list / Show list) [Close], 44 px targets. Opening folds the details sheet
  (the selection is kept; its handle reads "Show wall details"), and with nothing selected the
  handle goes; tapping something opens the sheet. Upright, the view is one scrolling column:
  the sheet full width and as tall as the drawing needs, the list under it. On its side the
  list is a panel beside the drawing. Labels are compact there: short tags, every height in one
  column at the right. Back closes the view; the history entry goes however it closes, and a
  reload strips it.
- **Save image:** a PNG of the drawing (white, its dimensions) with its title, the notes and
  the points drawn in, named "Main bedroom - D wardrobe wall.png" (a plain hyphen: Chrome
  drops a download name with an en dash). A phone shares it where the browser can.
- **That wall is gone.** with [Close]; Undo brings the view back. In After, a wall the
  renovation takes down: "This wall is taken down in the renovation." [See it as it is]; in
  Before its header adds "Taken down in the renovation".

**Cut from slice 1** (ux-reviewer): Furniture "Whole room", the Colour toggle (the drawing is
always in colour on screen; black-and-white comes with slice 2), side-on pieces at the edges,
the points chain (the list gives each point's distance), label leaders (tags hide instead),
the faint old place of a moved point, the merge rule for rooms joined in After, the phone's key
plan and its portrait hint. AC7's `furniture: 'room'` check became `furniture: 'none'`.

**Gestures:** a pinch or pan changes only the drawing's transform (the fit and the drawing are
memoized); a cancelled pointer only ends the gesture; a double tap that fits leaves the
selection as it was before its first tap.

**Performance:** every face of the furnished sample in about 12 ms with caches cold (a fresh
frozen level, as each edit makes), 3–6 ms warm (`PERF=1` bound 20 ms).

## Slice 1b: dragging in the elevation (PR 2)
- **A point:** drag up and down for its height, left and right along the face (and past the
  face's end onto the next face, which the view then follows). A live label beside the finger
  or pointer: "h1150 · 450 from left". It snaps within 30 mm of the usual heights 300, 700, 900,
  1050, 1150, 1200, and of the counter top + 250 when over a counter; Alt (desktop) or a second
  finger held down (phone) turns snapping off. Clamped to `minHeight`/`maxHeight`; along the
  face through `clearAlong` (never in a door, under a window only below its sill). One undo step
  per drag (`updatePoint`, coalesced). With the ageing check on, the reach band 0.45–1.20 m is
  shaded while dragging a switch or socket.
- **A window:** handles on its sill and head drag them (`updateOpening` `sill` and `height`),
  snapping to 100 mm steps and to the other windows' sills and heads on the face; head at most
  50 mm under the ceiling; sill at least 0. A door's head drags; its sill stays 0.
- **A hung piece** (`furnitureLayer` 'high', e.g. a wall cabinet): drag up and down for its
  height (`updateItem` position), snapping to 1.45, 1.50 and counter top + 0.60. Floor pieces
  don't move up and down.
- Phone: feedback shows before the finger lifts; a tap without moving only selects.

## Slice 2: elevations on the contractor sheet (PR 3)
- Contractor dialog: **Elevations** (on when any face has carpentry or a wall point) with a list
  of faces grouped by room, each with a checkbox. Ticked by default: faces with carpentry, wall
  points or a hung piece. [All] [None].
- **Pages:** after the plan and electrical pages, same paper and orientation; each elevation at
  **1:50** (1:100 for a face over 9 m), up to four per A4 page and six per A3, in room order then
  letter. Title per elevation: "Kitchen · B · sink wall", scale, finish. Black line drawing; in
  After, the changes coloured as on screen; dimensions and schedule as on screen; notes listed.
  Title column as on page 1, with a 1 m scale bar and the heights note.
- **Markers on page 1:** each printed face gets a marker (triangle and "Kitchen B") on the plan,
  so the carpenter can find it. Not on the screen plan.
- No new core geometry: `wallElevation` and PR 1's SVG, through `renderToStaticMarkup`.

## Slice 3: inside a wardrobe (PR 4, schema)
- Select a wardrobe or tall cabinet in the elevation: [Inside] shows it with its doors off. The
  owner splits it into columns (drag dividers, 0.30–1.00 m) and fills each with: long hang
  (1.60 m), double hang (two rails), shelves (every 0.30 m), drawers (0.20 m each, up to 4), top
  cabinet. Defaults for a new built-in: one long hang, one double hang, the rest shelves.
- Schema: `Item.fit?: { columns: { width: number; parts: FitPart[] }[] }` (tech-lead to
  refine). Bump `SCHEMA_VERSION` and Go `SchemaVersion` together, a no-op migration, regenerate
  `testdata/hdb4room.json`, deploy the API before merge.
- The storage meter counts hanging rail length when a wardrobe has a fit (double hang counts
  its two rails), else its width as today. The estimate adds internal drawers as a carpentry
  line at an editable rate (**PM**, not verified, $80–150 each).
- Out of scope here: drawer clearance in front (the clearance checks already have wardrobe
  doors), accessories (pull-out baskets, tie racks).

## Out of scope
1. Outside elevations: the façade (HDB doesn't let owners change it) and the corridor side of
   the main door and gate.
2. Sections cut through the flat (both walls of a room at once) and perspective views.
3. The ceiling: false ceilings, L-boxes for trunking, cove lights, a reflected ceiling plan.
4. Wall tiles and their heights (bathroom full height, the kitchen backsplash), skirting,
   cornices, curtains and blinds.
5. True silhouettes of real models; seeing through glass, half walls or boundaries into the
   room beyond.
6. Paint on part of a face (a feature panel): paint is per wall side today; needs a schema field.
7. Editing wall lengths, adding openings or adding pieces in the elevation (slice 1b moves
   heights only).
8. Points on the other side of the same wall (back-to-back sockets).
9. DXF export.

## Core API (shape; tech-lead may refine)
```ts
interface FaceStretch { wallId: string; side: 'left' | 'right'; from: number; to: number } // along the wall
interface Face {
  key: string;               // stable: room id + first wall id + side
  roomId: string; letter: string; label?: string;   // 'C', 'bed wall'
  stretches: FaceStretch[]; left: Vec2; right: Vec2; length: number;
  normal: Vec2;              // into the room
  ceiling: number;
}
roomFaces(level: Level, roomId: string): Face[];
faceAt(level: Level, wallId: string, side: 'left' | 'right'): Face | null;
faceIn(other: Level, face: Face): Face | null;           // the same line in the other version
interface Elevation {
  width: number; ceiling: number;
  walls: { u0: number; u1: number; top: number; build: 'solid' | 'glass' | 'half' | 'open';
           glassAbove?: boolean; material?: string; status?: WallStatus; ends?: boolean }[];
  openings: { id: string; kind: OpeningKind; u0: number; u1: number; sill: number; head: number;
              style?: DoorStyle; panels?: number; latch?: 'left' | 'right'; glazed?: string }[];
  items: { id: string; name: string; parts: Rect[]; outline: Rect; square: boolean;
           depth: number; against: boolean; fronts?: Rect[] }[];  // far to near
  points: { id: string; n: number; kind: ElecKind; u: number; z: number; w: number; h: number }[];
  trunking: { u0: number; u1: number; length: number }[];
  dims: { chains: { tier: 0 | 1 | 2 | 'points'; stops: number[] }[];
          heights: { u: number; from: number; to: number }[] };
  notes: { kind: 'hidden' | 'covers' | 'lowCabinet' | 'shelterFixing' | 'tooTall';
           ids: string[]; text: string }[];
}
wallElevation(level: Level, face: Face, opts?: { depth?: number; furniture?: 'wall' | 'room' | 'none' }): Elevation;
elevationChanges(before: Level, after: Level, face: Face): {
  added: string[]; removed: string[]; moved: { id: string; from: { u: number; z: number } }[];
  hacked: [number, number][]; built: [number, number][];
};
```
Constants in one place: `FACE_ANGLE` 1°, `FACE_OFFSET` 0.01, `MIN_STEP_FACE` 0.30, `DEPTH` 0.65,
`AGAINST` 0.10, `DOOR_MAX` 0.60, `GAP_USUAL` 0.55, `GAP_HOB` 0.65.

## Acceptance criteria

Test room R: a 4 × 3 m room on wall centre lines (0,0)–(4,3), 100 mm walls, level ceiling
2.60 m, the top wall drawn (0,0)→(4,0) (the room on its left), a 0.90 swing door centred on the
bottom wall.

### Slice 1 (PR 1)

Core (Vitest):
1. `roomFaces(R)`: four faces in the order bottom (A, door wall), left (B), top (C), right (D);
   lengths 3.90, 2.90, 3.90, 2.90 (± 1 mm); A's label "door wall".
2. The top wall split at x = 2 by a wall meeting it from above (outside R): still one face C,
   3.90 m, two stretches.
3. The top wall's inside face stepped 50 mm for x 1–3 (as built: the flush-face way, see "Slice
   1 as built"): faces of 0.95, 0.05, 2.00, 0.05, 0.95 m; stepping skips the two 0.05 m
   returns; `faceAt` on the middle wall returns the 2.00 m face.
4. A wall at 45° across R's corner (a cut corner): its own face, length its true face length.
5. Orientation: a double socket at t 0.25 on the top wall's left side, 0.30 high: in C at
   u 0.95, z 0.30. The door on the bottom wall in A: u 1.50–2.40; A's tier-1 chain 1500 / 900
   / 1500, overall 3900.
6. A 1.20 window centred on the top wall, sill 0.90, height 1.20: in C u 1.35–2.55, sill 0.90,
   head 2.10; tier 1 1350 / 1200 / 1350; heights 900 and 2100; ceiling 2600.
7. A built-in wardrobe 1.80 × 0.60 × 2.60 against the right wall, centred at y 1.50: in D a piece
   at u 0.55–2.35, z 0–2.60, three fronts of 0.60 and a line at 2.10. A coffee table 1.5 m out:
   not in D; in D with `furniture: 'room'`.
8. Hidden: a socket on the right wall at y 1.00, 0.30 high, behind that wardrobe: one 'hidden'
   note with both ids. The same socket behind a fridge, a TV console or a bedside table: none.
   A cooker point behind a hob cabinet: none.
9. Covers: the wardrobe moved onto the top wall over 0.50 m of the window: "covers 0.50 m of
   Window 1". A desk under the sill: none.
10. A kitchen wall run 0.45 m above a base run on the same face: a 'lowCabinet' note; at 0.60
    m, none; at 0.60 m over a hob, a note.
11. A kitchen wall run on a shelter wall face: a 'shelterFixing' note. On a structural wall:
    none.
12. A built-in 2.60 m tall in a room with a 2.50 m ceiling: 'tooTall', "0.10 m taller".
13. A half wall 1.05 m with glass above: a 'half' stretch to 1.05 and glass to the ceiling. A
    glass wall: a 'glass' stretch and no points. A boundary: an 'open' stretch, label "open to"
    the other room.
14. A free-standing wall with rooms on both sides and both faces spanning the same stretch: two
    faces, one per room, mirrored (a stop at u on one is at length − u on the other).
15. Trunking with a 2.0 m leg along the top wall's face: in C a band 2.00 m long.
16. `elevationChanges`: a window added in After → added; a socket moved 1 m along → moved with
    its old u; half the top wall hacked → `hacked` covers that stretch; the whole wall hacked →
    `faceIn(after, C)` is null.
17. Every chain adds up to its overall; the furnished sample's every face: same result twice, in
    the same order; all faces of the sample under 20 ms (median of 7, `PERF=1`; 3× otherwise).

E2e (desktop, and a 390 px phone by finger):
18. Select a bedroom wall with a window: the Inspector shows "See it straight on" with a button
    per room side. Open it: the plan stays, the elevation shows the window with "900" and its
    head, the overall length, and the plan draws the marker on that face.
19. [›] steps to the next face clockwise; the header letter changes; [‹] back; on desktop
    **]** and **[** do the same.
20. [Other side] shows the face from the other room, mirrored; it is absent on an outside wall.
21. Tap a socket in the elevation: the Inspector shows it; set 1150 in the Inspector: the tag
    reads "h1150" without a reload; Undo restores it.
22. Paint the wall Sage in the Inspector: the elevation's fill changes; pick a wallpaper: the
    pattern tiles at 0.6 m (measure two repeats against the overall dimension).
23. A socket placed behind a built-in wardrobe: the note shows, with the red outline.
24. [Save as image] gives a PNG named after the room and face, with the dimensions.
25. Esc or [Close] returns to the previous view; the undo history and save state are unchanged
    by opening, stepping and closing.
26. Delete the open face's wall: "That wall is gone."; Undo: the elevation is back.
27. Renovation: a window added in After draws teal; switching to Before keeps the same face and
    the window is not there. The whole wall hacked: "This wall is taken down in the renovation."
28. View link: opens and steps, nothing drags.
29. Phone: opened from the Inspector sheet; fills the stage with the key plan; pinch zoom, double
    tap fits; bottom bar targets at least 44 px; no sideways page scroll; tapping a face on the
    key plan jumps to it; Close returns to the plan.
30. Dark theme: the drawing stays dark on white.

### Slice 1b (PR 2)
31. Drag a socket up: the label shows its height while the pointer or finger is down; it snaps
    at 1150 within 30 mm; Alt (or a held second finger) doesn't; it stops at `maxHeight`;
    one undo step.
32. Drag a socket along into a door: it lands beside the jamb, as on the plan.
33. Drag a window's sill from 900 to 1000: the Inspector reads 1000 and the 3D view updates;
    Undo restores it. A door's sill has no handle.
34. Drag a wall cabinet down: it snaps to counter + 0.60; a floor piece won't move up.
35. Phone, by finger with CPU throttled 4×: feedback before the lift; no lost or merged moves.

### Slice 2 (PR 3)
36. Contractor dialog on the furnished sample: "Elevations" is on, ticking the faces with
    carpentry or points; unticking all removes the pages.
37. Pages at 1:50: the 1 m scale bar measures 20 mm in Chrome's PDF; each elevation's title,
    dimensions and schedule match the screen; up to four per A4 page.
38. Page 1 has a marker for each printed face, labelled as its title.
39. After: changes coloured as on screen; dark on white in a dark theme; the view and undo
    history unchanged afterwards.

### Slice 3 (PR 4)
40. A document at the previous version parses with no `fit`. A wardrobe split into a long hang
    0.60 m and a double hang 0.60 m saves, undoes and shows in a share link.
41. The storage meter counts that wardrobe's rails as 1.80 m (0.60 + 2 × 0.60); without a fit,
    its width, as today. Two drawers add one estimate line of 2 at the drawer rate.
42. Production accepts a save at the new version (after the API deploy, before the merge).

## New ideas this spec suggests (for `ideas.md`)
| Problem | Idea | Value | Effort |
|---|---|---|---|
| Tiling is a big wet-works cost owners can't count | Wall tiles by height per face (bathroom to ceiling, kitchen backsplash 0.6 m), in the elevation and priced per m² | High | S+ (schema) |
| A feature wall is often a panel, not the whole wall | Paint or wallpaper on part of a face (a rectangle in the elevation) | Medium-high | S+ (schema) |
| L-boxes and false ceilings for trunking surprise owners | Ceiling plan: L-box and false-ceiling strips, cove lights, drawn in the elevation's ceiling line and priced | Medium | M |
| Owners hang art, mirrors and shelves by guesswork | Wall pieces (art, mirror, floating shelf) with eye-height guidance (centre about 1.5 m) in the elevation | Medium | S |
| Carpenters re-measure everything on site | Elevation on site: tap a dimension on the phone, type the laser reading, and the plan corrects (with idea 13) | High | M |
