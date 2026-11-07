# Spec: Slice 2s (four leftovers)

Project-manager, 6 Nov 2026. Roadmap "Planned" item 2. It finishes four specs:
[my furniture](my-furniture.md), [plan for contractors](dimensioned-export.md),
[carpentry and cost](carpentry-cost.md) and [electrical](electrical.md).

## Decisions

**Value order** (value to owners against effort and risk):

| # | Item | Value | Effort | Schema |
|---|---|---|---|---|
| A | Suggested electrical points per room | High. A missing bedside or counter socket is the most common regret after plastering. Thirty taps become one. | M | none |
| B1 | Lift check | High for HDB. Every delivery above the ground floor goes through the lift, and "will it fit the lift?" is the top delivery question. | S+ | **10** |
| B2 | Editable diagonal | Medium. Unlocks the tilt check for pieces already added. Small. | S− | none |
| C1 | Notch depths on the contractor sheet | Medium. The sample has one (the recess beside the air-con ledge). Contractors measure it anyway. | S+ | none |
| C2 | Estimate on every level | Low today. The app shows and edits only `levels[0]`, so only an imported multi-level file has a second level. It is a correctness fix for later maisonettes. | S− | none |

**Split: three PRs.** All four in one PR would be L and would mix a schema bump with unrelated work.
1. **PR 1, now (M): A, electrical suggestions.** One coherent feature, no schema change,
   and the most value.
2. **PR 2 (S+ to M−): B1 + B2, "My furniture, slice 2".** Schema 10: deploy the API first,
   then check that production accepts a v10 save.
3. **PR 3 (S+): C1 + C2, "Sheet and estimate fixes".** Both are core geometry or sums with
   small web changes. No schema change.

**Schema.** Only B1 changes it: `site.lift` → `SCHEMA_VERSION` 10 and Go `SchemaVersion` 10
together, a no-op 9→10 migration, regenerated `apps/api/internal/project/testdata/hdb4room.json`.
Comments on the plan are a separate resource (docs/specs/plan-comments.md) and don't bump the
schema, so 10 is free. Why the lift goes in the project and not the browser: it is a fact
about the block, like north. The family member who orders the sofa from a share link needs
the same answer. The main door choice ("From") stays per browser, because it is a view choice.

---

## A. Suggested electrical points per room (PR 1)

**Problem.** Owners place points one by one and forget the obvious ones: the second bedside
socket, counter sockets, the hood. They don't know the usual heights.

### User stories
- As an owner, I press one button and see the usual points for every room, placed by my
  furniture, before I commit to any of them.
- I keep a room's suggestions or all of them, and leave out single points I don't want.
- I see what the suggestions add to the estimate before I add them.

### Room kinds (core `roomKind(name)`, first match wins)
| Kind | Name pattern (case-insensitive) | Examples |
|---|---|---|
| none | `shelter\|bomb\|\bh\.?s\.?\b`, `ledge\|air-?con\|balcony\|planter\|outside` | Household shelter, Air-con ledge |
| bathroom | `bath\|toilet\|\bwc\b\|shower` | Bath/WC 1, Master bathroom |
| kitchen | `kitchen\|pantry` | Kitchen, Dry kitchen |
| bedroom | `bed\|master\|guest` | Main bedroom, Master bedroom |
| living | `living\|family\|lounge\|hall` | Living and dining |
| study | `study\|office` | Study |
| other | anything else | Dining, Foyer, Store, Service yard, Room 3 |

Bathroom is checked before bedroom, so "Master bathroom" is a bathroom.

### Rules (core `suggestPoints(level) → { points: Suggestion[], notes: Note[] }`)
`Suggestion { key, roomId, rule, point: NewPoint, why }`. `key` is stable (room id + rule +
index), so a point the user left out stays out when the plan changes. Each point is placed
with `clearAlong` against the level **and the suggestions already made**, so no two plates
overlap and none sits in an opening. A point `clearAlong` can't place is dropped, with a note.
Never on a shelter wall face. Structural walls are allowed (the usual warning shows), but
where a rule has a choice of face, a face that isn't structural (or likely structural) wins.

| Rule | Where | Height (mm) | Why it is there (ghost tooltip and Inspector) | Basis |
|---|---|---|---|---|
| **Every room except "none"** | | | | |
| Light | `light` at the room's label point. Plus one centred over each dining table (`DINING_TABLES`) in the room. | ceiling | "Ceiling light." / "Light over the dining table." | Common practice |
| Switch | Room side of the door you enter by (the first door on the fewest-doors route from `entranceDoor`; with no main door, the widest door). On the latch side of a swing door. On the side the leaves don't stack on for sliding or folding doors. On the side with the longer clear wall for a passage, pocket or double door. Plate edge 150 mm from the opening's edge. 1 gang, plus 1 per extra light (max 3; past that, a second plate beside it). | 1050 | "Switch by the door, on the handle side." | App default 1050. 150 mm keeps the plate off the architrave. |
| **Bathroom** | Switch **outside**, on the room it opens from, latch side. No sockets. | 1050 | "Bathroom switch outside the door: no switches in a wet room." | BS 7671 s.701 (SS 638) zones; HDB practice |
| Water heater | `water-heater` on the face furthest from the door, centred in its clear stretch | 2000 | "Water heater point, above the shower." | App default; storage heater over the shower |
| **Bedroom** | | | | |
| Bedside sockets | Per bed (`bed-*`, own `bed` shape) whose head is within 0.15 m of a face. One 13A **double** socket on that face per open long side, its centre 0.25 m beyond the bed's side. A side within 0.10 m of a wall is not open. | 700 | "Bedside socket, above the bedside table." | Catalogue bedside table is 0.50 m high, plus 200 mm for the plug and lamp lead. The owner's "2 sockets per bed side" is read as one double socket (two outlets): constant `BEDSIDE_SOCKETS = 1` double. |
| Desk socket | Per desk (`desk`, `metal-desk`) with its back within 0.15 m of a face: a double socket centred behind it | 900 | "Desk socket, above the desk top." | Desk top 0.75 m plus 150 mm |
| Desk or dresser | No desk in the room: a double socket in the middle of the longest clear face that isn't the bed-head face or behind a wardrobe or built-in | 300 | "Socket for a desk or dresser." | App default |
| Aircon | One `aircon` per room. First choice: the bed-head face, centred on the bed. Otherwise the best face with 0.9 m clear at unit height, by (1) not behind a full-height built-in, (2) not structural or likely structural, (3) nearest the air-con ledge's label point, (4) longest. | top 200 below ceiling | "Aircon over the bed head: it blows over you, not onto you." / "Aircon on the wall nearest the ledge: shortest trunking." | App default; installers' advice |
| **Study** | Desk socket or desk-or-dresser socket, as for a bedroom. Light, switch. | | | |
| **Kitchen** | | | | |
| Counter sockets | Per counter run (connected `kitchen-base`, `kitchen-sink`, `kitchen-hob`, `built-in-kitchen-base`, as clearance groups them) whose back is within 0.15 m of a face. Length L along the face: n = max(1, round(L / 1.2)) double sockets, nominal centres L·(i + ½)/n. Each moves to the nearest spot clear of the sink (no plate within 0.55 m of the sink module's centre: a 0.5 m bowl plus 300 mm) and the hob (no plate over the hob module or within 150 mm of it). A socket with no clear spot inside the run is dropped. | 1150 (`overCounter`) | "Counter socket, above the backsplash." | Owner: about every 1.2 m. IET guidance: 300 mm from a sink. Hob gap: common practice. |
| Hood | Single socket centred over the hob, max ceiling − 150 | 2100 | "Hood socket, hidden by the hood's chimney." | The hood bottom is 650–750 mm over a 900 mm hob, so its chimney covers about 1.7–2.4 m. |
| Hob | `cooker` centred under the hob | 600 | "Hob point, in the cabinet under the hob. Leave it out for a gas hob." | App default |
| Fridge | Per `fridge` against a face: single socket centred behind it | 300 | "Fridge socket, behind it." | The plug leaves the bottom of the back. Cords are 1.5–2 m. |
| **Living** | | | | |
| TV wall | Face: behind a `tv-console`, `built-in-tv-console` or `tv` (within 0.15 m). Else the face a sofa (`sofa-*`, own `sofa` shape) looks at: the first face of the room hit by a ray from its front centre, within 6 m. Else the longest face with no opening. On it, from the console's centre (or the face's clear middle): double sockets at −0.45 and +0.45, `tv` at −0.15, `data` at +0.15. | 300 | "TV wall: sockets, TV and data behind the console." | App defaults; router and set-top box live there |
| Aircon | As for a bedroom, with no bed choice, and never the TV wall | top 200 below ceiling | as above | |
| **Ledge** | One `compressor` at the ledge's label point. Only if an aircon is suggested and the level has no compressor. Units are **not** linked: trunking stays the owner's choice (Run trunking). | plan | "Compressor on the air-con ledge." | HDB: compressors go on the ledge |

**Already there.** A suggestion is dropped when there is already:
- a socket of either kind (for a socket) or the same kind on the same face within 0.40 m;
- any light or fan in the room (for the room light), or any light within 0.6 m of a table's centre (for a table light);
- a switch within 0.6 m of that door's jamb, on that side;
- an aircon unit or water heater in the room;
- any compressor.

**Rooms with no door.** A room reached only across a room boundary (the sample's dry
kitchen) has no switch of its own. Its light adds a gang to the switch of the room it is
open to.

**Notes** (shown under the room, muted). Exact copy:
- "Draw the counter (Built-in ▸ Kitchen base run) to get counter sockets."
- "The bed isn't against a wall, so there are no bedside sockets."
- "No wall has 0.9 m clear for an aircon unit."
- "Name the room (Bedroom, Kitchen…) for more than a light and a switch."
- "No wall for a switch by this door."

### Behaviour
**Entry.**
- Plan details, Electrical row: [Suggest points].
- Electrical tool: [Suggest points] above the kind palette.
- The button is disabled with no rooms, titled "Draw rooms first.". It is hidden in view links.
- Suggestions go in the version shown. On Before, when a renovation exists, the panel adds
  "These go in the flat as it is. Switch to After to plan new points."

**Showing.**
- The Electrical view turns on and the selection clears.
- Ghost points draw in the electrical symbols at 50% opacity with a dashed outline, using
  the `--suggest` token. They are `data-export="skip"`: not in the PNG, 3D or the contractor sheet.
- Click or tap a ghost to leave it out (a hollow dashed ring with ×). Tap again to bring it back.
- Hover, or tap on a phone, shows its `why` (a title on desktop, the panel's status line on phones).

**Panel.**
- Desktop: in the right-hand panel. Phone: a bottom sheet at half height with the plan above it.
- Title "Suggested points". Intro: "Typical points for each room of an HDB flat, placed by your
  furniture. Tap any you don't want, then add them. Check them with your electrician."
- One row per room with points, in plan order: "Main bedroom · 6 points · about $480–880"
  [Add], with "2 bedside sockets, desk or dresser socket, switch, light, aircon" muted below,
  then that room's notes.
- The cost is what the suggestions add to the estimate's Electrical group
  (`electricalLines` with them, minus without them, at the viewer's rates).
- Hovering a row (or tapping it on a phone) highlights that room's ghosts. A tap also pans
  and zooms to fit the room.
- Foot: "23 points in 6 rooms · about $1,700–3,200" [Add all] [Close].
- Nothing left: "Every room has its points: nothing to suggest." [Close].

**Adding.**
- [Add] is one undo step, "Add 6 points to Main bedroom". The room leaves the list.
  Toast: "Added 6 points to Main bedroom." [Undo].
- [Add all] is one undo step, "Add 23 suggested points". The panel closes. Toast: "Added 23 points." [Undo].
- Added points are ordinary points (drag, Inspector, estimate, contractor page).
- New core command `addPoints(levelId, points[])`, with ids made outside the recipe.

**While the panel is open.**
- Any committed edit (undo included) reruns `suggestPoints` (150 ms trailing). Left-out keys are kept.
- Esc or [Close] removes the ghosts and adds nothing.

### Edge cases
- Furniture moved after adding: the points stay where they are (they are not linked to it).
- A bed head on a glass wall or half wall: the face is refused by `clearAlong`, so no bedside sockets, with a note.
- A door at a corner with no wall on the latch side: the switch goes on the other side; with neither side, there is a note.
- Two beds in one room: sockets for each. Bed sides closer than 0.4 m share one socket (the "already there" rule applied in the batch).
- A short counter run (0.6 m): one socket, or none if the sink or hob fills the run, with no note.
- A huge plan: 40 rooms must still finish in under 150 ms.

### Out of scope (slice 3)
Linking switches to lights, fan points, washer and yard sockets, a doorbell, a socket behind
a wall-mounted TV at 1.2 m, data at the desk, circuits and the DB box, trunking routes,
suggestions that follow furniture, condo rules.

### Acceptance criteria
Core (Vitest):
1. `roomKind`: Main bedroom → bedroom; Master bathroom and Bath/WC 1 → bathroom; Dry kitchen → kitchen; Living and dining → living; Household shelter and Air-con ledge → none; Study → study; Room 3 → other.
2. Empty 4 × 3 m "Bedroom", 100 mm walls, 2.6 m ceiling, one 0.9 m swing door. Exactly four points:
   - a light at the label point;
   - a 1-gang switch at 1.05 m on the room side, on the latch side, its plate edge 0.150 ± 0.005 m from the opening;
   - a double socket at 0.30 m;
   - an aircon unit with its top at 2.40 m.
3. Plus a queen bed with its head on the top wall: two double sockets on that face at 0.70 m, their centres 0.25 ± 0.005 m beyond each long side; the aircon is centred on the bed (± 0.01) on that face.
4. A single bed against the left wall: one bedside socket, on the open side.
5. A desk against a wall: a double socket centred behind it at 0.90 m, and no desk-or-dresser socket.
6. Kitchen, 3.0 m counter on one face (sink module 0.6–1.2 m, hob module 1.8–2.4 m along the run):
   - three double sockets at 1.15 m, centred at 0.277, 1.523 and 2.623 ± 0.005 m;
   - a single socket at 2.10 m and a cooker point at 0.60 m, both centred at 2.10 m;
   - a fridge against a face: a single socket centred behind it at 0.30 m.
7. Counter runs: 1.2 m → 1 socket; 2.4 m → 2; no counter → none, and the counter note.
8. Living with a TV console: double sockets at ±0.45, TV at −0.15, data at +0.15 (± 0.005) from the console's centre, all at 0.30 m; the aircon is on another face.
9. Living with a sofa and no console: the TV wall is the face the sofa looks at.
10. Bathroom: a water heater at 2.00 m, a light inside, a switch outside on the latch side, no sockets.
11. Shelter: nothing on its faces or in it. Ledge: one compressor at its label point only when an aircon is suggested and no compressor exists.
12. Sample flat: the dry kitchen has no switch, and the living room's switch by the main door has one gang more.
13. Already there:
    - an existing socket within 0.4 m, a light in the room, or an aircon in the room drops that suggestion;
    - applying every suggestion and running again gives no points.
14. Every suggestion passes `clearAlong` against the level plus the batch. None is on a shelter face, in an opening, or overlapping another plate.
15. The same level twice gives the same suggestions and keys, in the same order.
16. `addPoints` is one undo step; undo restores the level exactly.
17. Sample with 40 pieces: median of 7 runs under 50 ms (`PERF=1`; 3× otherwise).

E2e (desktop, and a 390 px phone by finger):

18. Sample, [Suggest points]:
    - ghosts appear and the Electrical view is on;
    - each room's row has a count and a cost;
    - the plan details' point count is unchanged.
19. Tap a ghost: that room's count drops by 1 and the ring shows ×. Tap again: it comes back.
20. [Add] on Main bedroom:
    - its points are real (select the light: the Inspector shows "Light point");
    - the row is gone;
    - one Undo removes them all.
21. [Add all]:
    - the estimate's Electrical subtotal rises by the panel's total (± $10);
    - [Suggest points] again shows "Every room has its points: nothing to suggest."
22. [Close] or Esc adds nothing. The plan PNG has no ghosts while the panel is open. A view link has no [Suggest points].
23. Phone:
    - the bottom sheet is at half height with no sideways scroll;
    - tapping a row fits that room in view;
    - every button is at least 44 px;
    - a ghost tap shows its reason in the status line.
24. With a bed added in Main bedroom while the panel is open, bedside ghosts appear after the drop.

QA by hand: the sample with furniture from the catalogue looks like a plan an electrician
would accept: no socket behind a wardrobe, and none in a door swing at 300 mm behind a
leaf that is open.

---

## B1. The lift (PR 2, schema 10)

**Problem.** In HDB blocks the lift, not the main door, is often what stops a sofa. Plans
don't record the lift, and lifts differ from block to block.

### User stories
- I pick my block's lift from a few typical ones, or type what I measured.
- I see whether the piece goes in the lift and how: as it stands, on its back, on end or tilted.
- My family sees the same answer from the share link.

### Storage (schema 10)
```
Lift = { preset: 'typical' | 'older' | 'large' | 'measured',
         door: { width: 0.5–2.0, height: 1.8–2.6 },
         car:  { width: 0.8–3.0, depth: 0.8–3.0, height: 1.9–3.0 } }   // metres
Site.lift?: Lift | null      // absent: not set yet; null: no lift (ground floor, a house)
```
- Presets store their numbers too, so a later change to a preset never changes a saved answer.
- `setLift(lift | null)` is one undo step. It creates `site` from `DEFAULT_SITE` when the project has none.
- A v9 document parses unchanged.

### Presets
| Choice | Door w × h | Car width (across the door) × depth × height | Basis |
|---|---|---|---|
| Typical HDB lift | 0.90 × 2.00 | 1.10 × 1.40 × 2.30 | Owner's 1.4 × 1.1 × 2.3 m. Matches the ISO 4190-1 8-person (630 kg) car of 1100 × 1400 mm. 900 mm is BCA Code on Accessibility 2019 cl. 4.9.3.1's minimum clear lift door. 2000 mm is ISO 4190's door height. |
| Older, smaller lift | 0.80 × 2.00 | 1.00 × 1.25 × 2.20 | ISO 4190-1 6-person (450 kg) car with 800 mm door and 2200 mm car. Retailers quote "about 0.8 m" HDB lift doors. |
| Large (stretcher) lift | 0.90 × 2.10 | 1.10 × 2.10 × 2.30 | ISO 4190-1 1000 kg bed or stretcher car, 1100 × 2100 mm |
| My measurements | typed | typed | |
| No lift (ground floor or a house) | none | | |

### The check (core)
- `deliveryCheck(level, itemId, { lift })` with a full `Lift` adds the lift as the first step
  on the route, before the main door.
- The result gains `lift?: { fit, how?, fails?: 'door' | 'car', need?, spare }`.
- **Lift door:** cross-section only. Some carry (the 6 orders, plus the sofa diagonal) has
  t ≤ door width and v ≤ door height. Spare is door width − t. There is no turn check: the
  lift lobby is open (BCA cl. 4.9.1.3: at least 1.2 × 1.5 m), and movers stand a piece up
  inside the car.
- **Car**, with the piece rigid and the car's floor A × B and height H:
  - As it stands (vertical h), on its back (vertical d), on end (vertical w): vertical ≤ H,
    and the other two fit the floor A × B, angled if need be.
  - Tilted: one dimension c across the car (c ≤ A, with the other two fitting B × H; or
    c ≤ B, with them fitting A × H).
  - The fit test is core `rectFits(p, q, a, b)` (p ≥ q, a ≥ b): fits if p ≤ a and q ≤ b, or
    if p > a, q ≤ b and ((a + b)/(p + q))² + ((a − b)/(p − q))² ≥ 2 (Carver 1956; p = q > a
    never fits).
  - Spare: the smallest slack of the best orientation.
  - **Standing it up.** A pose taller than the lift door comes in lying along its carry and is
    stood up in the car, turning in the plane of the door: the carry's `l` (which becomes the
    height) must be ≤ `turnLimit(door height, car depth B, carry v)`. A 2.1 m sofa on a 0.80 m
    diagonal is 1.38 m thick that way, and turnLimit(2.0, 1.4, 1.38) = 1.92 < 2.1, so it
    clears a typical lift door but can't be stood up in the car.
- **Fit.**
  - tight: under 20 mm spare, at the door or in the car;
  - too big: the door or the car fails;
  - `how` is the first orientation that passes in the order: as it stands, on its back, on
    end, tilted. Among those that pass, one with spare ≥ 20 mm is preferred.
  - The diagonal counts at the door only.
- Floor pieces only, as now (`deliverable`). The lift joins the route's `worst`.

### Behaviour (Inspector "Getting it in", desktop panel and phone sheet)
**Lift choice.**
- Under From, a select: "Lift: Not checked / Typical HDB lift / Older, smaller lift / Large
  (stretcher) lift / My measurements… / No lift (ground floor or a house)".
- A preset shows its numbers as a hint: "Door 0.90 × 2.00 m · car 1.10 wide × 1.40 deep × 2.30 m high".
- My measurements shows five length fields (Door width, Door height, Car width, Car depth,
  Car height; `inputmode="decimal"`). The hint is "Car width is across the door; depth is
  from the door to the back wall."
- Each field commits on blur or Enter. Out of range: "Between 0.5 and 2.0 m."
- A door wider than the car: "The door can't be wider than the car." (nothing is saved).

**Not checked.** The old hint is replaced by: "Which lift does your block have? Most HDB lift
doors are 0.8–0.9 m wide."

**Verdict.**
- When the lift is the worst step, the main sentence names it:
  - "Too big for the lift door: 0.90 m wide; it needs 0.95 m on its side."
  - "Doesn't fit in the lift (1.10 × 1.40 m, 2.30 m high), even on end or tilted."
  - It fits the car only stood up, and can't be stood up through the door (after QA, naming
    what was measured): "Too long to stand up in the lift: at 2.10 m long, it can’t be turned
    upright through a 2.00 m high door into a 1.40 m deep car."
- Otherwise the main sentence is as now, followed by a Lift line:
  - "Lift: fits as it stands." / "on its back." / "stood on end." / "tilted."
  - Tight: "Lift: just fits, stood on end."
- A too-big lift also adds: "Ask the shop whether it comes apart, or measure your lift: these
  sizes are typical."

**Plan.** The lift has no place on the plan, so nothing new is drawn. The route still starts
at the main door.

**View link.** Shows the Lift line. The select is disabled, with "Set by whoever can edit the plan".

### Edge cases
- No main door: "Add the main door first." as now. The lift is not judged.
- No lift: no lift step and no Lift line.
- Plan without a renovation, and After: one lift for the project.
- A bed is checked in its delivery parts (my-furniture.md, "Beds come flat"): the mattress may fold in half, unless it's a king; everything else is rigid.
- The car's corner-to-corner diagonals aren't used, so the check can say no to a thin piece that movers could angle in.

### Out of scope
Stairs, the gate, the common corridor's width, a lift drawn on the plan, per-block lift data.

### Acceptance criteria
Core:
1. `rectFits`:
   - 1.6 × 0.05 in 1.2 × 1.2: true;
   - 1.6 × 0.2 in 1.2 × 1.2: false;
   - 1.0 × 0.95 in 1.1 × 1.4: true;
   - 1.3 × 1.3 in 2.0 × 1.2: false.
2. Typical lift, sofa 2.1 × 1.0 × 0.95: too big, fails `door`, need 0.95. With diagonal 0.80:
   still too big, fails `car` (it clears the door tilted but can't be stood up: 2.1 > 1.92).
   A 1.8 × 1.0 × 0.95 sofa: too big at the door without its diagonal; with 0.80: fits, `how` on
   end, spare 0.10 ± 0.005 (the door: 0.90 − 0.80).
3. Sofa 2.0 × 0.9 × 0.85: older lift: too big at the door, need 0.85. Typical lift: fits on end.
4. Sofa 2.4 × 0.95 × 0.9, typical lift: too big, fails `car`.
5. Box 0.6 × 0.6 × 2.4: typical lift: too big (car). Large lift: fits, tilted.
6. Box 0.7 × 0.7 × 1.8, older lift: fits as it stands.
7. The lift is first in `doors` and counts in `worst`. Without `lift`, results are unchanged (the slice 1 tests pass).
8. A v9 document parses with no `site.lift`. Car width 0.5 fails. `setLift` undoes, including the `site` it created.

E2e (desktop, and a 390 px phone by finger):

9. "My sofa" 2.1 × 1.0 × 0.95 in the living room, Typical HDB lift: "Too big for the lift door: 0.90 m wide; it needs 0.95 m on its side."
10. Set its diagonal to 0.80 (B2): it now clears the door but can't be stood up in the car:
    "Too long to stand up in the lift: at 2.10 m long, it can’t be turned upright through a
    2.00 m high door into a 1.40 m deep car." (the stand-up rule under **Car**). A 1.8 × 1.0 × 0.95 "Short sofa" with diagonal 0.80: "Lift: fits stood on end."
11. Reload: Typical is still chosen. A view link shows the same Lift line, with the select disabled.
12. My measurements with car height 2.00: "Doesn't fit in the lift (1.10 × 1.40 m, 2.00 m high), even on end or tilted."
13. Undo goes back to Typical.
14. No lift: no Lift line.
15. Phone: the decimal keypad, and no sideways scroll in the sheet.
16. The production API accepts a v10 save (after deploy, before merge).

---

## B2. A diagonal you can edit (PR 2)

**Problem.** The diagonal can only be typed when a piece is added. Someone who measures it
later, or after a "too big" verdict, has no way to add it.

### Behaviour
**The field.**
- Inspector "Your model" for a piece added by size with shape sofa: a "Diagonal depth"
  length field (placeholder "Not measured") with the Add form's hint.
- Empty plus Enter removes the diagonal.
- Valid range: core `diagonalRange(d, h)`, from d·h / √(d² + h²) up to the shorter of the
  model's depth and height, with 5 mm either side (`diagonalFits`). The diagonal is the sofa's
  width across when tipped on its back, so it is never more than its depth or height.
  Otherwise: "Between 0.69 and 0.95 m for this sofa." (the numbers come from the model; these
  are for 1.0 × 0.95).
- When the piece is resized away from the model's size (by more than 5 mm), add: "Measured on the
  sofa at 2.10 × 1.00 × 0.95 m; scaled with this piece."

**Command.** `updateModel(id, { diagonal: number | null })` is one undo step, "Edit model". It
changes every piece made from that model, in both versions.

**Getting it in.**
- An own sofa with no diagonal that is too big on width (`need`) adds "Measured its diagonal
  depth? Tilted, it may get through." [Add diagonal depth]. The button scrolls to the field
  and focuses it.
- `DoorOnTheWay.tilted` is true when only the diagonal carry passes. The verdict then adds
  "(tilted on its diagonal)" after the narrowest door, and the plan's label reads "0.86 m, tilted".

### Out of scope
Diagonals for catalogue sofas (that would need a per-item field, so a schema change),
editing an own piece's width, depth and height after adding it.

### Acceptance criteria
1. Core: `updateModel` sets 0.80, removes with `null`, and undo restores. Pieces of the model re-check.
2. Core: a door passed only by the diagonal carry reports `tilted: true`.
3. E2e: "My sofa" in the Bedroom (slice 1, criterion 10) shows [Add diagonal depth]. Typing 0.80 gives a fits message with "(tilted on its diagonal)". Undo brings the old message back.
4. E2e: 1.5 gives the range error, and nothing changes.
5. E2e: resize the sofa by its handle: the "Measured on…" line appears.

---

## C1. Notch depths on the contractor sheet (PR 3)

**Problem.** An outside face hidden in a notch (a recess the flat wraps round, such as the
slot between the sample's air-con ledge and kitchen) gets no chain. So the notch's depth is
nowhere on the sheet, and contractors need it for grilles, windows and ledge works. Its
width and the openings' positions are already on the side chains.

*Revised in PR 3 after the tech-lead's design review and the UX design (7 Nov). Where they
differ from the first draft, the UX design wins on the drawing; the tech-lead's review on
the rules. The changes are marked "(revised)".*

### Behaviour
**Core** (`packages/core/src/dimensions.ts`).
- `planDimensions` returns `notches: NotchDim[]`. A notch dimension is
  `{ a, b, gap, notch, corners }` in metres: `a` the inner end (at the notch's back), `b` the
  mouth, on the line the depth is drawn on; `gap` the clear width across the notch (the
  narrowest, where it tapers); `notch` a group index (two dimensions of one notch share it);
  `corners` where each flank measured turns at the mouth, for the extension line. The
  direction is `b − a`. (revised: no `out`)
- `outsideStretches` tells each point of a face that looks out as not looking out, seen, or
  hidden (its front ray meets the flat). The chains use the seen stretches only, as before.
- **A flank** (revised) is the whole run of face that looks out (seen or hidden) and has a
  hidden part, carried on to where the face turns, also through a joint where a wall meets it
  from behind. If the face carries on in view for more than the gap past the hidden part (a
  long outside wall past the notch, which the side chain measures), the flank stops where it
  comes into view. That gives the U below two depths (2.00 and 1.70) and the sample one (1.00,
  not the kitchen's whole 2.8 m west face).
- **Mouth and inner end** (revised): probed just past each end of the flank, a little in front
  (5 cm, or `gap / 2` if less). Free space: the mouth. A wall or a room: the inner end.
  - Neither end free (a shaft, or a slot closed at its mouth): no depth.
  - Both ends free (a slot right through, between two wings): no depth. **Gap in this spec:**
    a through-slot's length isn't measured anywhere yet; decide later whether it wants one.
- **Pairing:** two flanks face each other when each one's front rays land within 1 mm of the
  other's face (a window in a flank counts as its face). A flank broken by a pier, facing one
  flank: paired by the largest overlap; anything left is a lone flank.
- **Dimensions:**
  - a pair facing within 1° with ends that agree within 5 mm: one dimension on the centre line
    between them;
  - otherwise (mouths that differ, or tapered or stepped flanks): one along each flank, inset
    `gap / 4` from its face, each with its own gap;
  - a lone flank: one, inset `gap / 2`.
- Flanks under 0.10 m are left out.

**Sheet** (`apps/web/src/print/contractorSheet.tsx`, placement in the pure
`apps/web/src/print/notches.ts`). (revised, UX design)
- Drawn like the outside chains: a 0.15 ink line, 0.22 ticks at both ends, the figure in mm to
  10 mm at the chains' 2.2 mm size, reading along the line (an upright line reads upwards).
- A grey 0.1 extension line from the corner where the flank turns at the mouth to just past
  the mouth tick, so the reader sees what the depth runs to.
- The figure (with its white halo):
  - gap on paper 5 mm or more: beside the line, on a side with room for it and, of two, the
    one no chain extension line or chain crosses (in the sample, the ledge side);
  - 2.8 mm to 5 mm: in a break in the line;
  - under 2.8 mm: beyond the mouth along the line, moved out until it touches no chain line,
    extension line or chain figure row.
- Two dimensions of one notch under 8 mm apart on paper: one short chain on the centre line
  (back face, nearer mouth, further mouth) with a figure per piece ("1700 | 300"), and an
  extension line from each flank's mouth corner. Nothing is dropped.
- Each is a `g.dim-notch` with `data-notch` (the group) and `data-depth` (the figures printed,
  space-separated). Not `.dim-chain`: the e2e suite counts `.dim-chain[data-tier="2"]` as the
  four overalls.
- Page 1 only, never on the electrical page. The word "notch" appears nowhere on the sheet.

**Dialog.** Unchanged.

### Edge cases
- A notch with a window in a flank: the depth is unchanged and the window keeps its tag. No
  side chain changes (today such a window is on no side chain; notch chains with opening stops
  are out of scope). (revised)
- A slanted notch: the line follows the flanks.
- Tapered or stepped flanks: a dimension along each flank (above).
- After: hacked walls don't make notches; new walls do (the sheet measures the shown level).
- A courtyard closed on all sides is a room or a hole, so it is not a notch; the end probe
  guarantees it even if one weren't.

### Out of scope
Notch chains with opening stops, notches in rooms' insides, a through-slot's length, DXF.

### Acceptance criteria
1. U fixture (notch x 2–4, y 2–4, open to the bottom, 100 mm walls):
   - one notch dimension, 2.00 m long (y 2.05 → 4.05), on x = 3.00, gap 1.90;
   - the side chains are unchanged (the existing test still passes).
2. The same U with a 0.6 m window centred on the left flank: depth 2.00; the window keeps its
   tag; no side chain changes. (revised)
3. A U whose right arm is 0.3 m shorter: two notch dimensions in one group, 2.00 and 1.70,
   each `gap / 4` from its flank. (revised: flanks are whole runs)
4. A 4 × 3 box and an L: no notches.
5. Sample flat: one notch, between the air-con ledge and the kitchen. Depth 0.999 ± 0.002
   (prints "1000"), gap 0.647 ± 0.002.
6. Sheet (web Vitest, `notchFigure`): a gap of 6.5 mm puts the figure beside the line; 3.2 mm
   in a break; under 2.8 mm beyond the mouth. Two depths under 8 mm apart make one chain.
   (revised)
7. E2e: sample, A4 (1:100): page 1 has one `.dim-notch` with `data-depth="1000"`, inside the
   outline's bounds, and still four tier-2 chains.
8. Core: each end case (inner end, mouth, closed slot, through-slot), a slanted notch, a
   tapered notch and a notch made by new walls in After. (added)

---

## C2. The estimate on every level (PR 3)

**Problem.** `useEstimate` prices `levels[0]` only. A project with more levels (imported
today, maisonettes later) is under-priced without saying so.

*Revised in PR 3 after the tech-lead's design review and the UX design (7 Nov).*

### Behaviour
**Core** (`packages/core/src/cost.ts`).
- `levelParts(before, after, rates)` returns one level's `{ changes, painting, carpentry,
  electrical }` lines, without debris and contingency. (revised)
- `projectEstimate(project, rates) → CostEstimate` pairs each level in `project.levels` with
  its After copy (`id + AFTER_SUFFIX`), then assembles, in the one-level order: every level's
  changes, debris once for the home (if any level hacks, cuts or widens), then painting,
  carpentry and electrical, each level by level, then contingency once over every line.
  `costEstimate(before, after)` is the one-level case, so the line order (which Copy uses)
  is identical. (revised)
- Each line carries `levelId` and `levelName` (computed, no schema change); debris and
  contingency, which are the whole home's, carry none. (revised, UX design)
- With 2 or more levels, each line's `place` starts with its level's name: "Upper · Bedroom";
  a line in no room is placed on the level itself ("Upper", not "Flat"). Debris stays "Flat".
- `levels: { id, name, low, high }[]`: each level's subtotal (the sum of its lines). These and
  the whole home's lines add up to the sum of all lines. (added)
- Level names: a blank one is "Level n"; names shared by two levels get their number
  ("Level 1", "Level 2"). (added)
- With a renovation, a level that has no After copy isn't priced and is listed by name in
  `unpriced` (never dropped silently). (revised)
- `renovation` is whether the project has one. Totals rounded as now.
- One level: deep-equal to `costEstimate(levels[0], after)`.

**Web** (`apps/web/src/cost/estimate.tsx`, words in `apps/web/src/cost/text.ts`).
- `useEstimate` uses `projectEstimate`, cached on `doc.levels`, `doc.renovation` and rates
  (Immer keeps those the same objects through unrelated edits).
- The trade groups stay; within each, lines go level by level.
- With 2 or more levels (revised, UX design):
  - a **By level** block above the groups: each level's subtotal, "Whole home (debris,
    contingency)" (naming what is there), then "Total, about $x–y";
  - summary hint: "Covers both levels: Ground and Upper." ("all 3 levels: …" for more);
  - dialog note: "Upper is priced from the file. It can't be shown or edited here yet." There is
    no level switcher, so no level is highlighted as current.
- A level with no renovation plan, in the summary and the dialog: "Upper has no renovation
  plan, so it isn't priced."
- Phone: each line keeps two rows; the place moves to the second row beside the quantity
  ("Upper · Living · 71.9 m²", the price on the right).
- Copy and Print: the lines in the same order with their prefixes, then "By level" with the
  subtotals, before the Total; the unpriced note after it.

### Out of scope
A level switcher or adding levels in the UI. Built-ins sized to the level's ceiling when
placed (still open in carpentry-cost.md).

### Acceptance criteria
1. One-level sample, with and without a renovation: `projectEstimate` deep-equals `costEstimate`.
2. Two levels, each with a built-in wardrobe, no renovation: two wardrobe lines, places starting "Ground ·" and "Upper ·" (the level names).
3. A wall hacked on each level: one debris line. Contingency is 10% of all lines.
4. A renovation with an After copy for level 1 only: level 2 adds no lines and is in
   `unpriced`. (revised)
5. E2e: open a two-level project file (`apps/web/e2e/two-levels.dreamhome.json`, written from
   core's `twoLevelProject`; a web unit test keeps it in step and fixes its total). The
   estimate dialog lists both levels' lines and the By level rows, and the total matches the
   core value. (revised)
6. Blank and repeated level names fall back to "Level n". The By level rows add up to the
   lines. On a phone, each line's place sits beside its quantity. (added)
