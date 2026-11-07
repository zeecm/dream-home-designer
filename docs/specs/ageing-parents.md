# Spec: Ageing parents check

Project-manager, 7 Nov 2026. Roadmap "Planned" item 2. It builds on the
[clearance checks](clearance-checks.md): the same 50 mm grid, distance field and widest-way
search (`walkway.ts`, `grid.ts`), the same red-on-the-plan style and Inspector lines.
Overall effort **M+**, in three PRs. Only slice 2 changes the schema (**11**).

**Slice 1 is built (7 Nov 2026).** The tech-lead and UX design notes bound where they
refined this spec, and this text now says what was built. The eight defects the tech lead found
are fixed in place (marked *fixed*), the wording is the UX design's, and AC7 is corrected. See
[Slice 1 as built](#slice-1-as-built) for the implementation notes.

**Problem.** Families renovate for a parent who walks with a stick or a frame today and may
use a wheelchair in a few years. They find out too late, often after the carpentry is
built, that the wheelchair doesn't fit:
- the bathroom door is 0.70 m and opens inwards;
- there is a kerb at the bathroom door;
- the shoe cabinet blocks the space by the main door's handle;
- the bedroom has no room to turn;
- nobody knows where the grab bars go.

HDB pays up to 95% of the EASE fittings, but owners don't know what to ask for. Wheelchair
rules are written for architects. This check turns them into one plain list for the flat
being planned.

## Decisions

**Value order** (value to owners against effort and risk):

| # | Item | Value | Effort | Schema | PR |
|---|---|---|---|---|---|
| A | Doors, routes and space by the main door, for a wheelchair or a walking aid | Highest. Door widths and a blocked way in are the costliest to fix after renovation. | M− | none | 1 |
| B | Room to turn (1.50 m) in their bedroom, bathroom, kitchen and living room | High. You can't judge it by eye on a plan. | S | none | 1 |
| C | Their bathroom: door, toilet front and side space, way to the basin | High. The bathroom is where falls happen. | S | none | 1 |
| D | Switches and sockets within reach (0.45–1.20 m) | Medium. Cheap to get right before wiring. | S− | none | 1 |
| E | Grab bars, shower and shower seat pieces, "Suggest grab bars", the cost | High. EASE's main items. Owners don't know where the bars go. | S+ | none | 2 |
| F | Steps and kerbs at doorways, ramps, step-free routes. Saved choices. | High for older flats; most BTOs are level (see note). Needs data the plan doesn't have yet. | S+ | **11** | 3 |

**Split: three PRs.**
1. **PR 1 (M): slice 1, A to D.** One report, no new data, no catalogue change.
2. **PR 2 (S+): slice 1b, E.** New catalogue pieces and suggestions. No schema change: a
   catalogue id is not a schema field.
3. **PR 3 (S+): slice 2, F.** Schema 11. Deploy the API first, then check that production
   accepts a v11 save.

**Who it is for (the profile).** One select, "Check for", with three choices:
- **Off** (the default).
- **Walking aid**: a stick, a walking frame, or someone unsteady.
- **Wheelchair**: the stricter rules, and the ones in the Singapore code.

Owners planning ahead should choose Wheelchair. The intro says so.

**Where the choices live.**
- **Slice 1:** per browser, per project (localStorage `dhd-ageing-<projectId>`): the profile,
  their bedroom and their bathroom. These are view choices, like "From" in My furniture.
- **Slice 2:** the choices move into the project, so a sibling opening the share link sees
  the same check. Slice 2 is a schema bump anyway. The browser value is used once to seed it.

**Severity.** Every line is advice and never blocks an edit, as with clearance checks. Each
line has one of two labels:
- **Needed**: from the code's rules for homes (Chapter 7) or a hard size, e.g. a door
  narrower than the chair. Drawn red.
- **Recommended**: good practice, e.g. room to turn in a bedroom, or a door that opens out.
  Drawn amber with a new `--advise` token (light #a16207, dark #eab308), apart from the
  comment orange and the clearance red. In the list the words "Needed" and "Recommended" carry
  the meaning, so colour is never the only signal.
- Walking aid lines: door widths and the way through are Needed (a hard size); the toilet's
  front and side are Recommended.

## Sources

| Code | Source | Checked |
|---|---|---|
| **COA 2025** | BCA, *Code on Accessibility in the Built Environment 2025*, v1.1 (1 Mar 2026), <https://go.gov.sg/bca-coa2025> | Read, 7 Nov 2026 |
| **COA 2019** | BCA, the 2019 edition (the one before), [PDF](https://isomer-user-content.by.gov.sg/338/57384a60-c5ce-4c3e-a621-1709f60ce428/accessibilitycode2019.pdf) | Read, for clauses the 2025 text moved |
| **EASE 2026** | HDB, Annex C, "Background of the EASE programme" (2026 HIP release), [PDF](https://www.hdb.gov.sg/-/media/hdb-pulse/news/2026/18000-more-homes-to-be-upgraded-under-hdb-home-improvement-programme/Annex-C.pdf) | Read |
| **EASE page** | HDB, [EASE](https://www.hdb.gov.sg/cs/infoweb/residential/living-in-an-hdb-flat/for-our-seniors/ease); [HealthHub summary](https://healthhub.sg/a-z/costs-and-financing/enhancement_active_seniors) | HDB's page gave a 404 on 7 Nov; eligibility comes from summaries, **not verified** |
| **M4** | UK Approved Document M, vol. 1, M4(2) and M4(3) | **From memory, not re-checked** |

COA's Chapter 7 applies to new homes (plans submitted after it took effect). Older HDB flats
weren't built to it, so it is a target for the renovation, not a judgement on the flat. The
intro says so.

## Rules

All widths are clear widths. Door clear width is `accessClearWidth(opening)` in `delivery.ts`
(*fixed*: `clearWidth` counts both leaves of a double door, so it isn't reused), **rounded to the
millimetre** before any step lookup (*fixed*: 0.94 − 0.04 is 0.8999… in floating point, which
would land in the 1.10 row):
- swing door: width − 0.04;
- double door: one leaf, (width − 0.08) / 2 (*fixed*);
- sliding door: width × (1 − 1/panels); a single sliding (barn) door slides clear, its full width;
- pocket door or passage: the full width;
- bi-fold and folding door: width − 0.04 per panel, with the panels as drawn (`doorPanels`: a
  bi-fold up to 1.2 m has 2).

COA measures clear width from the face of the open door to the stop (4.4.2.1).

### A. Doors, routes and the main door (slice 1)

**Their routes.** These start at the main door (`entranceDoor`, the same door as the
walkways). They go to every room of kind living, kitchen and bathroom (`roomKind`), to their
bedroom, and to their bathroom.

Until they choose a bedroom, routes go to every bedroom. Each bedroom then shows a count
only ("Main bedroom: 3 to change"), not its room checks.

| Check | Wheelchair | Walking aid | Source |
|---|---|---|---|
| Main door clear width | **0.85 m** (one active leaf if double) | 0.75 m | COA 2025 7.2.1 (850). Walking aid: M4(2) 750 *(not re-checked)* |
| Inside the main door | Clear floor space **1.25 m wide × 1.50 m deep**, and **0.45 m** beside the leading (handle) edge of a swing door, inside | 0.45 m beside the handle edge only | COA 2025 7.2.2 (a); Fig. 66 |
| Every other door on their routes | **0.80 m** at least. Then the clear square outside it, centred on the doorway, must be at least: **1.00 m** for 0.90 m and wider, **1.10 m** for 0.85 m, **1.20 m** for 0.80 m | 0.75 m; no square | COA 2025 7.3.3, Table 7. The code sets Table 7 for the way to the retrofit bathroom (7.1.7); we apply it to every door on their routes. Under 0.80 it fails, as Table 7 stops at 800. |
| Route width to their bathroom (and through their bedroom, if the bathroom opens off it) | **1.00 m** | 0.90 m | COA 2025 7.1.7 (1000) |
| Route width to every other room | 0.90 m | 0.90 m | COA 2025 1.3.4.3 (a wheelchair in a straight line, 900 × 1200). Same as slice 2 walkways |

- **Table 7 squares** are measured on the side the route comes from. Each is an s × s square,
  centred on the doorway, its near edge on the wall face. **Have** is the largest s that
  fits. It is free of:
  - solid, glass and half walls, and room holes;
  - outside the flat;
  - floor pieces that `blocks()`.

  Door leaves are ignored and room boundaries are free. A door that fails only its square
  says which way out works: "Or fit a wider door: a 0.90 m opening needs only 1.00 m in front."
- **Table 7 steps** (*fixed*, written down): clear width 0.90 and over needs 1.00; 0.85 up to
  0.90 needs 1.10; 0.80 up to 0.85 needs 1.20; under 0.80 the door fails its width instead.
- **Inside the main door:**
  - The 1.25 × 1.50 m box is aligned to the door. It starts at the inside wall face and is
    centred on the clear opening, but slides along the wall up to 0.30 m toward the handle
    side to fit (Fig. 66 puts it off-centre).
  - The 0.45 m strip is 0.45 m wide and up to 1.50 m deep (no deeper than the space in front of
    the door goes), beside the latch jamb. It applies only to a single swing door that swings
    **into the flat** (*fixed*): an out-swinging door is pulled from the common corridor, which
    isn't drawn, and a double door has no handle end (its other leaf gives the room).
  - `entrance-space`'s `have` is the best depth of the 1.25 m wide box over its slides, against
    a need of 1.50 (*fixed*).
  - The usual blocker is the shoe cabinet, which is then named.
- **Routes:** these use the slice 2 walkway search with the needs above, but **not capped**
  at the flat's own width.
  - A pinch with furniture is blamed on the piece, as in slice 2.
  - A pinch between walls is a **flat** issue with nothing blamed: "The corridor itself is
    0.95 m wide." It is drawn as a dashed amber bar, so owners don't hunt for furniture to
    move.
  - Doorway throats are free, as in slice 2. Door widths are checked by the rows above.
- Slice 2's clearance walkway issues are unchanged and still shown. The ageing list adds
  only what is stricter. The same pinch is not drawn twice: the ageing bar replaces the
  clearance bar there.

### B. Room to turn (slice 1, wheelchair only)

- **Need:** a **1.50 m** circle clear of every obstacle (COA 2025 1.3.4.2, a wheelchair
  turning "within a confined space"; 1.80 m is for turning freely, 1.3.4.1).
- **Rooms:**
  - their bedroom and their bathroom;
  - every living room and kitchen on their routes;
  - rooms joined by room boundaries count as one space (Living and dining + Dry kitchen).
- **Severity:** Recommended. The homes chapter requires the toilet and route spaces in C
  instead. COA 2019 Appendix B.6.7.1 recommends turning space in bathrooms, kitchens and
  living rooms. That appendix wasn't checked in the 2025 edition.
- **Have:** twice the largest distance from a free cell inside the room(s) to an obstacle
  (the same obstacles as the routes). It is refined on the polygons as walkway pinches are,
  so it is good to ±10 mm. The circle is drawn where it is largest.
- **Blamed:** the one or two floor pieces nearest that circle, if any. Otherwise it is the
  room's size: "Bath/WC 2 is 1.42 m across inside, too small for a 1.50 m turn."
- **Bathroom wording** (honest for HDB, where most common bathrooms are about 1.5 × 2 m): "No
  room to turn a wheelchair inside: 1.20 m (1.50 m recommended). Many HDB bathrooms can't.
  A wheelchair can go in forwards and come out backwards if the door and the 1.00 m way to
  the toilet are clear."

### C. Their bathroom (slice 1)

Their bathroom by default:
- the bathroom whose door opens from their bedroom, if there is one;
- otherwise the bathroom nearest their bedroom door along the route;
- before a bedroom is chosen, the bathroom nearest the main door.

The owner can change it.

| Check | Wheelchair | Walking aid | Source |
|---|---|---|---|
| Door width and square outside | As A (Table 7) | 0.75 m | COA 2025 7.3.3 |
| Door that swings into the bathroom (swing or double, opening in) | Recommended: "If they fall against it, it can't be opened. A folding or sliding door, or one that opens out, is safer." | Same | COA 2025 5.8.1.1 (a) (accessible washrooms: swing out, sliding or folding) |
| In front of the toilet | **1.00 × 1.00 m** square at the front edge, centred (it may shift up to 0.05 m sideways) | 0.60 m deep (as slice 1) | COA 2025 7.3.4 (c) and the 2019 note to 7.3.5 |
| Beside the toilet | **0.45 m** from the toilet's centre line to any obstacle on one side, along the toilet's depth | 0.45 m (room for a grab bar) | COA 2025 7.3.4 (d) |
| Door to the toilet and basin | **1.00 m** way from the door throat to the toilet's front square and to the basin's front zone | none | COA 2025 7.3.4 (b) |
| Level at the door | slice 2 | slice 2 | COA 2025 7.3.4 (a) |

- The toilet is `toilet` and the basin is `vanity`. With more than one toilet, the one
  nearest the door is checked.
- No toilet piece: no toilet checks, and the note "Add the toilet and basin (Bathroom in the
  catalogue) to check the bathroom."
- No bathroom room (by `roomKind`): "Name a room Bath or WC to check the bathroom."

### D. Switches and sockets (slice 1, both profiles)

- **Rule:** every `switch`, `socket-single` and `socket-double` must be between **0.45 and
  1.20 m** to its centre (COA 2025 7.4.1).
- **Not checked** (COA 2025 note to 7.4):
  - points in rooms of kind kitchen (appliances stay plugged in);
  - points that aren't readily reached: a floor piece stands within 0.15 m in front of the
    point, across its plate, e.g. behind a TV console, fridge or bed.
- **Shown as one line:** "3 sockets below 0.45 m and 1 switch above 1.20 m: hard to reach
  from a wheelchair or for someone who can't bend down." [Show] selects the first one and
  steps through them.
- **Finding for later (not this spec):** slice 2s suggests the desk-or-dresser socket and the
  TV wall at 0.30 m. COA 7.4.1 (2019 and 2025) says 0.45–1.20 m for new homes. The TV wall
  is exempt here (it sits behind the console); the dresser socket isn't. Raise it to 0.45 m
  in the suggestions in a later small PR (the owner's call, since 0.30 m is common SG
  practice).

### E. Grab bars, shower and seat (slice 1b)

**New catalogue pieces** (category Bathroom; catalogue only, no schema change):

| id | Name | Size w × d × h (m) | Mounted | Basis |
|---|---|---|---|---|
| `shower` | Shower area | 0.90 × 0.90 × 0.02 (resizable) | floor; you walk on it | gives the check a shower to find |
| `grab-bar` | Grab bar, straight | 0.60 × 0.08 × 0.04 (length 0.30–1.20) | wall, centre 0.72 high | COA 2025 9.4.1: 32–45 mm bar, 40 mm off the wall |
| `grab-bar-l` | Grab bar, L-shaped | 0.80 × 0.08 × 0.75 | wall, bottom 0.70 high | COA 2025 5.8.2.2 (b): at least 750 high × 800 wide, 700–800 above the shower floor |
| `grab-bar-folding` | Fold-down grab bar | 0.10 × 0.75 × 0.10 (0.75 out from the wall when down) | back wall beside the toilet, 0.72 high | COA 2025 5.8.2.1 (e): 380–400 mm from the toilet's centre line, ≤ 100 mm past the seat front. EASE "foldable U-profile" |
| `shower-seat` | Fold-down shower seat | 0.45 × 0.40 × 0.05 | wall, top 0.47 high | Height as a toilet seat, 450–480 (COA 2019 5.6.6.1 (b)). Shower seat height in COA 2025 **not checked**. EASE item |

- Tech-lead: these need a "wall fixture" kind. They back onto a wall at their own height,
  never stand on a piece, and don't block walkways, turning or zones (`walkThrough`).
  `HUNG` (1.2 m) is too high for them.
- The fold-down bar's plan footprint shows it lowered (dashed). It counts as an obstacle for
  "beside the toilet" only on the side it is on.

**Checks** (their bathroom, and every bathroom with grab bars or a shower):

| Check | Line | Source |
|---|---|---|
| A bar beside the toilet | Needed: a `grab-bar` or `grab-bar-l` on the side wall nearest the toilet, overlapping the toilet's depth, with that wall ≤ **0.50 m** from the toilet's centre line; **or** a `grab-bar-folding` beside it on the open side | COA 2025 5.8.2.1 (c), (e). The 0.50 m reach is our rule, from COA 2019 5.6.6.1 (a): an accessible toilet sits 460–480 mm from the wall |
| Side wall too far | "The wall is 0.62 m from the toilet's centre: too far to reach a bar on it. Add a fold-down bar on the open side, or move the toilet nearer the wall." | as above |
| A bar in the shower | Needed (if there's a `shower`): an L-shaped or straight bar on a wall touching the shower area | COA 2025 5.8.2.2 |
| A seat in the shower | Recommended: a `shower-seat` on a wall of the shower area, within 0.45 m of a bar | COA 2025 5.8.2.2 (b)(iii); EASE |
| No shower piece | Note: "Add the shower area (Bathroom ▸ Shower area) to check bars and a seat there." | |

**[Suggest grab bars]** goes in their bathroom's section of the report. It works like
[Suggest points]: ghosts drawn with `--suggest`, tap one to leave it out, [Add] as one undo
step "Add 4 grab bars to Bath/WC 2". The ghosts:
- **Beside the toilet, side wall ≤ 0.50 m:** an L-shaped bar on that wall. Its horizontal
  part runs from 0.30 m behind the toilet's front edge to 0.45 m in front of it, bottom at
  0.70 m. The vertical part rises from its front end.
  - Basis: COA 5.8.2.1 (c) and (d), adapted for a home. The code wants the horizontal bar
    from the back wall, which an HDB toilet's cistern and pipes usually prevent. **Our
    choice**: tech-lead and ux-reviewer to look at it in 3D.
- **Beside the toilet, side wall > 0.50 m:** a fold-down bar on the back wall, its centre
  0.39 m from the toilet's centre line, on the open side.
- **Behind the toilet:** a straight 0.70 m bar on the back wall, centred, 0.72 m high (COA
  2025 5.8.2.1 (f): at least 700 long). Always offered, since the plan can't tell a
  concealed cistern; tap it to leave it out.
- **Shower:** an L-shaped bar on the shower wall furthest from the door, bottom at 0.70 m,
  plus a fold-down seat on the same wall, 0.10 m from the bar's vertical part.
- Pieces already there of the same kind on the same wall within 0.30 m stop a ghost, as
  "already there" does for electrical points.

**Cost** (estimate, slice 1b):
- Grab bars and seats added in the renovation are counted: "Grab bars (4)" and "Fold-down
  shower seat (1)".
- Default private rates, editable with the other rates (**not verified**, PM estimates):
  - grab bar, supplied and fixed: $60–150 each;
  - fold-down shower seat: $150–350.
- One muted line under them: "Under HDB's EASE, the government pays up to 95%. Your share
  for a 4-room flat: $39.20 for the first toilet's set of 8 or 10 bars." The flat type comes
  from the EASE panel (below).

### F. Steps, kerbs and ramps (slice 2, schema 11)

**Storage (schema 11)**, the shape the tech lead proposed (7 Nov), shared with the storage
meter:
- `Opening.step?: number`: the height in metres (0–0.60; 0 is level) of the step or kerb
  crossed at the doorway. Missing means not entered.
- `Opening.ramp?: 'left' | 'right'`: a ramp is fitted, on that side of the wall (the plan
  can't tell which floor is lower), as an `ElecPoint`'s side.
- One household object for both features:
  ```ts
  Project.household?: {
    flatType?: '1-3' | '4' | '5' | 'exec' | 'none';   // shared by EASE and the storage meter
    ageing?: { profile: 'walking' | 'wheelchair'; bedroomId?: string; bathroomId?: string };
    storage?: { … };                                    // the storage meter's
  }
  ```
  Absent `ageing` means Off. The slice 1 browser setting (`AgeingSetting`: `profile` 'off' |
  'walking' | 'wheelchair', `bedroomId`, `bathroomId`, `flatType`) maps onto it directly:
  `flatType` to `household.flatType`, the rest to `household.ageing` unless the profile is
  'off'. It seeds the project once, with one Command, only when the project can be edited
  (never on view links), and the key is then deleted.
- `SCHEMA_VERSION` 11 and Go `SchemaVersion` 11 together, with a no-op 10→11 migration and
  a regenerated `testdata/hdb4room.json`.

**Door Inspector** (doors and passages): "Step or kerb" length field (blank = not entered,
0 = level), and a "Ramp fitted" switch when the step is over 0. Hint text: "Older HDB flats
often have a step at the main door and a kerb at the bathroom door. Measure the top of the
kerb above the lower floor."

| Check | Wheelchair | Walking aid | Source |
|---|---|---|---|
| Their bathroom door | Needed: step ≤ **0.025 m** | Recommended: ≤ 0.015 m, or a ramp | COA 2025 7.3.4 (a) (25 mm); EASE 2.0 "lowering of toilet/bathroom entrance kerb" |
| Main door | Needed: ≤ **0.05 m**, and over 0.025 m it needs a ramp | Over 0.015 m: a ramp or a handrail | COA 2025 7.2.3 (50 max; over 25, ramp-ready), 7.2.4; EASE "handrail at main entrance with step(s)" |
| Any other door on their routes | Over 0.015 m without a ramp: Needed | Over 0.015 m without a ramp: Recommended | COA 2025 Table 4; COA 2019 B.7.1 (1) "without steps, thresholds or kerbs" |
| Ramp length (drawn) | rise × 2 (≤ 15 mm), × 5 (≤ 50 mm), × 10 (≤ 175 mm), × 12 (over); at the main door, within **0.25 m** of the door face | same | COA 2025 Table 4; 7.2.4 |
| Ramp space | The ramp's footprint (clear width × length) must be free of blocking pieces | same | |

- **Ramp sides:** at the main door the ramp is drawn outside, so a 0.05 m step at 1:5 is
  0.25 m, which matches 7.2.4. At inside doors it goes on the route's lower side. With no
  side known, it is drawn on the side the route comes from (tech-lead may refine).
- **Not entered:** the report says "Steps: not entered for 6 doors. Older HDB flats often
  have a step at the main door and a kerb at the bathroom door." [Show] selects the first
  door on their routes. This is never counted as a problem.
- **Renovation:** a step lowered in After shows in the change list ("Bath/WC 2 door: kerb
  0.05 → 0.01 m"). The estimate adds "Lower a bathroom kerb", default **$300–800, not
  verified**, with the EASE line: "Your share under EASE (4-room): $71.90."

### EASE panel (slice 1, prices from EASE 2026)

The report ends with "What HDB's EASE can fit here". It opens with a flat type select:
- **1, 2 or 3-room**: the default with 2 bedrooms or fewer;
- **4-room**: the default with 3 bedrooms;
- **5-room**: the default with 4 or more;
- **Executive**.

The flat type is per browser, then `household.flatType` in slice 2 (shared with the storage
meter).

It lists the items that apply to this plan, with the owner's share for that flat type:

| Item (EASE 2026, S/N) | 1/2/3-rm | 4-rm | 5-rm | Exec | Shown when |
|---|---|---|---|---|---|
| Grab bars, first toilet, 8 or 10 bars (1) | 26.15 | 39.20 | 52.30 | 65.40 | always |
| Grab bars, second toilet, 6 bars (1) | 15.25 | 22.85 | 30.50 | 38.15 | 2+ bathrooms |
| Slip-resistant treatment, up to 2 toilets (2) | 23.95 | 35.95 | 47.95 | 59.95 | always |
| Lower the toilet entrance kerb (3 i) | 47.95 | 71.90 | 95.90 | 119.90 | slice 2: a kerb over 0.025 m |
| Widen the toilet entrance (3 ii) | 65.40 | 98.10 | 130.80 | 163.50 | their bathroom door fails A |
| Widen and lower (3 i + ii) | 77.35 | 116.05 | 154.75 | 193.45 | both |
| Wall-mounted foldable shower seat (4) | 15.25 | 22.85 | 30.50 | 38.15 | always |
| Handrail at a main entrance with steps (5) | 31.60 | 47.40 | 63.20 | 79.00 | slice 2: a main door step |
| Single-step ramp / portable ramp (6 a, b) | 14.15 / 38.15 | 21.25 / 57.20 | 28.30 / 76.30 | 35.40 / 95.35 | slice 2: a step |
| Rocker switches, set of 12 (8) | 13.60 | 20.40 | 27.25 | 34.05 | always |

- Not listed: bidet spray (7), home fire alarm device (9), customised ramps (6 c, d), and the
  wheelchair lifter (6 e). They can't be judged from a plan; the panel says "and more" with
  a link.
- **Copy:**
  - "HDB pays up to 95% for Singapore Citizen households with someone 65 or over, or 60 to
    64 who needs help with daily activities. Apply through HIP if your block is due, or
    directly on HDB's e-Service. Prices: HDB, 2026; check HDB for today's."
  - Eligibility is **not verified** on HDB's own page (see Sources). It is kept in one
    constant, so it is easy to fix.
- **Condo owners:** "EASE is for HDB flats. The checks above apply to any home."
- **Widening a door in a structural or shelter wall** (`wallStatus`): add "This wall is
  structural: widening it needs HDB's approval and may not be allowed. A sliding or pocket
  door gains the most width in the same opening." For a shelter wall: "This is a household
  shelter wall: it can't be changed."

## Behaviour

**Entry.**
- Plan details: a section "Older person" (not "Ageing parents": the older person may be
  planning for themselves), after Clearance checks, with a segmented control "Check for: Off |
  Walking aid | Wheelchair" (44 px on touch).
- When the select isn't Off:
  - the summary "5 to look at for a wheelchair: 2 needed, 3 recommended" [See the list]
    [Show next];
  - at 0: "Nothing to change in what's checked: doors, the way through, turning, bathroom,
    switches." (not "Ready for a wheelchair": steps and grab bars aren't checked yet);
  - the "Bedroom" (Choose…) and "Bathroom" (Auto: Bath/WC 2) pickers are at the top of the
    list, not in Plan details.
- Intro (the first time it is turned on in this browser, muted): "Checks doors, the way
  through, room to turn, the bathroom and switch heights for a walking aid or wheelchair, now or
  later. Choose Wheelchair to plan ahead. Older flats weren't built to today's code: treat this
  as a goal for the renovation."
- View links: the check can be turned on to look, but [Suggest grab bars] is hidden.

**Report** (desktop: right-hand panel; phone: bottom sheet at half height, plan above).
- Groups in this order, each line with its label (Needed / Recommended), its numbers in the
  app's length format, and what to do. Tapping a line selects the piece or door and pans to
  it.
  1. Getting in
  2. Getting around
  3. Their bedroom (name)
  4. Their bathroom (name)
  5. Switches and sockets
  6. Steps (slice 2)
  7. What EASE can fit here
- Under each group: "Also checked: main door width, space inside the door (all fine)." This
  reassures without listing every pass.
- Before a bedroom is chosen, "Their bedroom" is replaced by "Which bedroom will they use?",
  listing each bedroom with its count ("Bedroom 2: 1 to change", "Main bedroom: 3 to
  change"). A tap chooses it.

**Example lines** (exact copy; numbers vary):
- "Main door: 0.81 m clear (the gap with the door open); a wheelchair needs 0.85 m." (what
  "clear" means is said on the first door line only)
- "Inside the main door: the shoe cabinet leaves 0.30 m beside the handle; a wheelchair needs
  0.45 m to reach it, and 1.25 × 1.50 m to turn in."
- "Bedroom 2 door: 0.76 m clear; a wheelchair needs at least 0.80 m."
- "Bath/WC 2 door: 0.86 m clear needs 1.10 m of space in front; 0.95 m here. A 0.90 m clear
  door would need only 1.00 m."
- "The way to Bath/WC 2 is 0.92 m at the Dining table; 1.00 m needed to the bathroom."
- "The corridor itself is 0.95 m wide; 1.00 m needed to the bathroom." (flat issue)
- "No room to turn a wheelchair: 1.32 m between the Queen bed and the Wardrobe (1.50 m
  recommended)."
- "Getting into bed from a wheelchair needs 1.00 m along one side; 0.70 m on the better
  side."
- "In front of the toilet: 0.82 × 0.82 m clear; 1.00 × 1.00 m needed to pull up beside it."
  (*fixed*: `have` is the side of the largest clear square, so a toilet too narrow a space
  says so as well as one too shallow)
- "Beside the toilet: 0.38 m from its centre to the Basin and vanity; 0.45 m needed on one
  side for a grab bar."
- "From the door to the toilet and basin: 0.85 m; 1.00 m needed."

**Bed rule** (in "Their bedroom"):
- Wheelchair: **1.00 m** along one long side of their bed. Walking aid:
  **0.75 m**.
- Source: M4(3) and M4(2) *(from memory, not re-checked)*. Our rule for HDB bedrooms, not
  in COA.
- Measured as slice 1's bed side zone, from the foot to the bedside table (*fixed*: head to
  foot puts the bedside table in the zone, so almost every bed failed). The better side counts.

**Plan** (desktop and phone), only while the select isn't Off:
- **Turning circles:** dashed, at their best spot in each room checked. Faint grey with
  "1.50 m" when fine; amber with "1.32 / 1.50 m" when short.
- **Door labels on their routes:** "0.76 / 0.80 m" (red) at the doorway when short. Table 7
  squares and the main door boxes are drawn only when short.
- **Toilet:** the front square and the side zone, drawn when their bathroom is selected or a
  line in it is tapped.
- **Route pinches:** the ageing need (red bar, or dashed amber for a flat issue).
- Grab bar and seat ghosts (1b); steps and ramps (2): a small step mark with "25 mm" at the
  doorway and the ramp as a wedge.
- **While moving a piece:** recompute at most every 100 ms and on release, as walkways do.
- **Exports:** none of it in the PNG, print, contractor sheet, 3D or walk
  (`data-export="skip"`). Grab bars and seats, being pieces, do appear in 3D and on the
  contractor sheet like any piece.
- **Phone:** labels 11 px; the report and selects on the sheet; [Show next] pans the plan
  above the sheet; nothing scrolls sideways.

**Inspector** (selected piece or door): a new "For a wheelchair" (or "For a walking aid")
section listing that piece's or door's lines, after Clearances. It is hidden when the check
is Off or there are none.

**Live region:** a drop or move adds the first ageing line for that piece, after the
clearance one.

## Core API (shape; tech-lead may refine)

```ts
type AgeingProfile = 'walking' | 'wheelchair';
interface AgeingChoice { profile: AgeingProfile; bedroomId?: string; bathroomId?: string }
type AgeingIssue = {
  key: string;                               // stable, for Show next and the live region
  group: 'in' | 'around' | 'bedroom' | 'bathroom' | 'points' | 'steps';
  level: 'needed' | 'recommended';
  kind: 'door-width' | 'door-space' | 'entrance-space' | 'latch-side' | 'route' | 'turn'
      | 'bed' | 'door-in' | 'wc-front' | 'wc-side' | 'wc-way' | 'reach' | 'grab-bar'
      | 'shower-bar' | 'shower-seat' | 'step' | 'ramp-space';
  need: number; have: number;
  itemIds: string[]; openingId?: string; roomId?: string; pointIds?: string[];
  flat?: boolean;                            // the flat's own walls, nothing to move
  draw: { circle?: { c: Vec2; r: number }; poly?: Vec2[]; bar?: [Vec2, Vec2] };
};
ageingReport(level, choice): {
  status: 'ok' | 'no-main-door' | 'issues';
  bedroom?: string; bathroom?: string;        // resolved (auto or chosen)
  bedrooms: { roomId: string; count: number }[];
  issues: AgeingIssue[]; passed: string[];     // for "Also checked"
  notes: string[];
};
suggestGrabBars(level, bathroomId): Suggestion[]   // 1b, same shape as suggestPoints
```

## Edge cases
- **No main door:** door, route and entrance checks are skipped, with "Add the main door to
  check the way in." Turning, bathroom, bed and switch checks still run.
- **No bedrooms** (a studio): "Their bedroom" is the room the bed is in, or skipped if there
  is no bed.
- **Their bedroom or bathroom renamed or deleted, or missing in this version:** fall back to
  Choose or Auto, with no error.
- **Before and After** are checked separately. The choice is by room id. A room that is new
  in After isn't chosen until picked.
- **Their bathroom inside another room (the master bath):**
  - The bedroom's own door is checked with Table 7 (COA 2025 7.1.7 and Fig. 68).
  - The route through the bedroom needs 1.00 m.
- **Double main door:** the active leaf's clear width, (width − 0.08) / 2. A 1.60 m double
  door gives 0.76 and fails. Owners with one fixed leaf use two doors, or accept the line.
- **A sliding or pocket bathroom door:** no "opens in" line. Its clear width follows
  `clearWidth`.
- **A passage (no door):** its full width; no swing line; steps still apply (slice 2).
- **A bi-fold door counts as folding too** (*fixed*).
- **A folding door counts as folding:** COA allows it, so no "opens in" line, even folding
  inwards.
- **A bathroom with two toilets, or a toilet in the middle of the floor:** the toilet nearest
  the door; the side space is measured to whatever is there.
- **Rugs, people, wall cabinets, grab bars and seats** don't block. Uploaded models do.
- **Round tables:** their square footprint, as in slice 2.
- **Glass and half walls** block, as in slice 2.
- **Very small or no-door rooms** (A/C ledge, shelter): never checked. The household shelter
  is not their bathroom or bedroom even if named so (`SHELTER_ROOM`).
- **Performance:** the sample with 40 pieces under 30 ms on a laptop (CI bound 60 ms). Plan
  at 60 fps while dragging (the 100 ms throttle).

## Out of scope
- **Seen from a wheelchair:** the walk-through at seated eye height (1.15–1.20 m) with a
  0.75 m wide body for collision. Cheap and vivid. Proposed as the next small item.
- Editable numbers per rule (clearance slice 3); this check replaces its "For a wheelchair"
  preset.
- Kitchen: counter height, knee space under the sink or hob, reach to wall cabinets. The
  kitchen work triangle.
- Heights: wardrobe rails and shelves, window handles, door hardware (lever handles), peep
  holes, the intercom.
- Bathtubs; shower thresholds and screens (draw a glass wall); wall-hung basins with knee
  space (the vanity always counts as solid).
- Rocker switches, bidet sprays, fire alarms, call bells, night lights and motion sensors
  (listed in the EASE panel only where noted).
- Slip-resistant floors as a finish property (EASE line only).
- Two doors in series (COA 4.4.7), leading-edge offsets (4.4.6.2), the push side outside the
  main door (the common corridor isn't drawn).
- Stairs and maisonettes, stair lifts, ceiling hoists.
- The check on the contractor sheet (a later "accessibility notes" box); steps in 3D.
- Automatic fixes (move this piece, widen this door) beyond the text hints.

## Acceptance criteria

### Slice 1 (PR 1)

Core (Vitest):
1. Wheelchair, a 0.90 m swing door (clear 0.86) off a bare 1.20 m corridor: no issue. Off a
   1.05 m corridor: `door-space`, `need` 1.10, `have` 1.05 ± 0.01. The same opening as a
   0.90 m pocket door (clear 0.90): no issue (needs 1.00).
2. A 0.80 m swing door (clear 0.76): wheelchair `door-width`, `need` 0.80, `have` 0.76.
   Walking aid: no issue. A 0.75 m swing door (clear 0.71), walking aid: `need` 0.75.
3. Main door 1.0 m swing: no issue. 0.85 m swing (clear 0.81): `door-width`, `need` 0.85. A
   1.60 m double door: `have` 0.76.
4. A 0.35 m deep shoe cabinet inside the main door, on the handle side, leaving 0.30 m from
   the latch jamb: `latch-side`, `need` 0.45, `have` 0.30 ± 0.01, blamed on the cabinet. The
   same cabinet 1.0 m along on the hinge side: no `latch-side`. A box filling the 1.25 × 1.50
   m space: `entrance-space`.
5. A bare 0.95 m corridor to the bathroom, wheelchair: one `route` issue, `flat` true,
   `need` 1.00, `have` 0.95 ± 0.02, no pieces blamed (the bathroom door's own `door-space`
   is a separate issue). The slice 2 walkway report for the same
   plan: no issue. The same corridor to a bedroom: no ageing issue (0.90).
6. A dining table narrowing the way to the bathroom to 0.92 m: `route` on the table, `need`
   1.00. Walking aid: none.
7. Room 3.0 × 2.0 m inside, empty: `turn` none (`have` ≥ 1.50). A 1.0 m wide, 2.0 m long bed
   along a long wall: `turn`, `have` **1.17** ± 0.01 (the L-shaped space left), blamed on the
   bed (*fixed*: not 1.00). The bed 3.0 m long, wall to wall: `have` 1.00 ± 0.01. Room 2.0 × 1.42 m, empty: `turn`,
   `have` 1.42 ± 0.01, no pieces blamed. Walking aid: no `turn` issues at all.
8. Living and dry kitchen joined by a room boundary: checked as one space (one `turn` result).
9. Queen bed, wheelchair, 0.80 m left and 0.70 m right: `bed`, `need` 1.00, `have` 0.80. With
   1.05 m left: none. Walking aid with 0.70 m both sides: `bed`, `need` 0.75.
10. Toilet facing a wall 0.90 m from its front edge: `wc-front`, `have` 0.90 ± 0.01. 1.05 m:
    none. A vanity 0.38 m from the toilet's centre line and a wall 0.40 m the other side:
    `wc-side`, `have` 0.40. The wall at 0.47 m: none.
11. Bathroom door swing opening in: `door-in`, recommended. Opening out, folding, sliding,
    pocket or a passage: none.
12. A 0.85 m gap between the vanity and a wall on the only way from the bathroom door to the
    toilet: `wc-way`, `need` 1.00, `have` 0.85 ± 0.02. Walking aid: none.
13. Sockets: at 0.30 m in a bedroom → `reach`; the same behind a TV console → none; at 0.30
    m in a Kitchen → none; a switch at 1.35 m → `reach`; at 1.05 m → none.
14. No bedroom chosen: no `bed` or bedroom `turn` issues. `bedrooms` lists each bedroom with
    its count. Bedroom chosen: its checks run.
15. Their bathroom auto: the master bedroom's attached bath when chosen; otherwise the
    nearest by route; a chosen bathroom overrides.
16. No outside door: `status` 'no-main-door'; no door, route or entrance issues; `turn` and
    bathroom issues still found.
17. No toilet piece in their bathroom: no `wc-*` issues and the toilet note.
18. Furnished sample, wheelchair, each bedroom in turn: the report matches a reviewed snapshot
    (PM and tech-lead read it once for false alarms). The unfurnished sample has no `route`
    issues blamed on pieces.
19. Same level twice: the same issues and keys in the same order.
20. Furnished sample with 40 pieces: `ageingReport` under 60 ms in CI.

E2e (desktop, and a 390 px phone by finger):
21. Plan details ▸ Ageing parents ▸ Wheelchair: the intro shows. "Which bedroom will they
    use?" lists the bedrooms with counts. Choosing Bedroom 2 shows "Their bedroom (Bedroom
    2)" and "Their bathroom (Bath/WC …)".
22. Drag the wardrobe in their bedroom toward the bed: the turning circle turns amber with
    "1.xx / 1.50 m" before release. The Inspector's "For a wheelchair" line names the
    wardrobe. Undo restores it.
23. Change their bathroom door's width in the Inspector from 0.70 to 0.90: its door line
    goes (or turns into a `door-space` line if the corridor is under 1.00 m).
24. A shoe cabinet dropped by the main door's handle: the live region reads its first
    ageing line. The 0.45 m strip is red.
25. [Show next] visits every line in report order, then wraps. Tapping a report line selects
    and pans.
26. The EASE panel: flat type defaults from the bedroom count. Prices match EASE 2026 for
    each type. Widening is listed only when their bathroom door fails.
27. Off hides every circle, label, square and section. The choice survives a reload (per
    browser).
28. PNG, print and the contractor sheet show none of it; 3D unchanged.
29. Before and After show their own reports.
30. Phone: 21 and 22 by finger; the report on the sheet; labels readable; no sideways
    scroll.

### Slice 1b (PR 2)
31. The five new pieces are in Bathroom, and back onto walls at their heights. They don't
    block walkways, turning or zones. They draw in 3D.
32. Toilet with its side wall 0.46 m from its centre and no bar: `grab-bar` needed. An
    L-shaped bar on that wall over the toilet's depth: none. The wall at 0.62 m: the "too
    far" line. A fold-down bar on the open side: none.
33. A shower area with no bar: `shower-bar`. An L bar on its wall: none. No seat: recommended
    `shower-seat`.
34. `suggestGrabBars` on a bathroom with the toilet 0.46 m from a side wall and a 0.9 m
    shower in the far corner gives exactly:
    - an L bar on the toilet's side wall;
    - a back bar, centred behind the toilet;
    - an L bar and a seat in the shower;
    - all at the heights in E, each within ±0.005 m of its position.

    With the side wall at 0.62 m: a fold-down bar 0.39 ± 0.005 m from the centre line, on
    the open side, instead of the side bar.
35. [Add] is one undo step ("Add 4 grab bars to Bath/WC 2"). A tapped-out ghost isn't added.
    Afterwards the bathroom's grab bar lines are gone.
36. In After, 4 bars and a seat give estimate lines "Grab bars (4)" and "Fold-down shower
    seat (1)" at the default rates, with the EASE share line for the chosen flat type.
37. Phone: the ghosts can be tapped and [Add] reached on the sheet.

### Slice 2 (PR 3, schema 11)
38. A v10 document parses with no `step`, `ramp` or `household`. `setOpening` with a step
    undoes. The Go API accepts v11 and the regenerated fixture.
39. Their bathroom door with a 0.05 m step: wheelchair `step`, needed, `need` 0.025. With a
    ramp: the ramp is drawn 0.25 m long (1:5), and no `step` issue. A blocking piece on the
    ramp gives `ramp-space`. Walking aid with 0.02 m: recommended.
40. Main door with 0.04 m: needs a ramp. With a ramp: none, and the ramp is drawn outside at
    0.20 m. 0.10 m: `step` needed (over 0.05 m); the EASE panel lists the handrail and ramps.
41. No steps entered: "Steps: not entered for N doors" with no issue counted; [Show] selects
    the first door on their routes.
42. A kerb lowered in After: the change list line and the estimate line "Lower a bathroom
    kerb" with its EASE share.
43. The profile, bedroom and bathroom are saved in the project. A share link shows the same
    report. The old browser value seeds it once.
44. Production accepts a v11 save (after the API deploy, before the merge).

## Slice 1 as built

Core (`packages/core`):
- `ageing.ts`: `ageingFacts(level, profile)` (cached per frozen level and profile) does
  everything that doesn't depend on the choice: the main door, every door on a route (by the
  side the route comes from), every route at 0.90 and, for bathrooms, 1.00, every turning space,
  every bathroom's toilet checks, every bedroom's bed, the points, and the auto bathroom for
  each bedroom. `ageingReport(level, choice)` only puts the chosen bedroom and bathroom
  together, so the "Which bedroom?" counts and a change of choice are nearly free.
  `ageingSupersedes(walk, age)` names the walkway pinches the ageing bars replace;
  `AgeingSetting`/`parseAgeingSetting` the per-browser setting.
- `walkway.ts`: one shared `furnishedPass(level)` (the furnished raster, widths and widest ways
  from the main door), recomputed whenever the level isn't the last one (*stale-cache guard*:
  walkways on After, then ageing on Before, read Before's), built even with no main door.
  Ageing re-measures the walkway paths at its needs with no cap at the flat's own width; a bare
  path short of the need is a `flat` issue with nothing blamed; a furnished one more than 0.02
  below the bare width is blamed on the pieces as walkways are.
- Turning: the raster of the room group only (rooms joined by boundaries; cells outside are
  solid, so the circle can't bulge out through a doorway: a 1.42 m bathroom with its door on
  the long wall measured 1.526 before), then a pattern search on the polygons (walls with their
  doorways closed, columns, pieces, boundaries out of the group) to about a millimetre. Turning
  spaces are cached by the pieces near them, so a drag redoes only its own room's.
- `ageing-zones.ts`: `depthOff`, `largestSquare` (Table 7 squares, the toilet's front),
  `squareAt`. `delivery.ts`: `accessClearWidth`. `clearance.ts` exports `fixedParts`,
  `ruleSide`. `ease.ts`: prices in cents, `defaultFlatType`, `easeItems`, the copy.
- Timing (sample, 40 pieces, a drag): walkways about 8 ms, ageing on top of them about 6 ms,
  ageing alone (clearance checks off) about 15 ms on a laptop. The bounds are in the timing
  note below.

Web (`apps/web/src/ageing/`):
- `store.ts`: per browser and project (`dhd-ageing-<projectId>`: profile, bedroom, bathroom,
  flat type), unreadable data is Off; the list's state.
- The runner (`clearance/walkways.ts`) runs ageing in the same throttled pass as walkways, and
  runs it when ageing is on even with clearance checks off.
- `ageing.tsx`: the Plan details section; the list replacing Plan details (a half-height sheet
  on a phone with a one-line top "Wheelchair · Bedroom 2 · Bath/WC 2 [Change]"; the right-hand
  column on a phone on its side), each line a full-width button with a Needed or Recommended
  tag; a tap selects its door, piece, room or point and pans, and the details then open with
  "‹ Back to the list (3 of 7)"; group headings "Getting in", "Getting around", "Bedroom: …",
  "Bathroom: …", "Switches and sockets"; "Also checked: … (all fine)."; the EASE panel (flat
  type select with "Not an HDB flat", the item and "You pay", a grey "Because …" line for items
  this plan brings in, no total, the eligibility sentence and the link); the plan layer (only
  what's short, unless its room is selected: then passing turning circles and the toilet zones
  show, grey; dashed bars for the flat's own walls, labelled "· walls"); the Inspector's "For a
  wheelchair" section; the live region's line after a drop.
- Phone: list rows 44 px, labels 11 px, nothing scrolls sideways.

Review fixes (tech lead, UX, QA; 7 Nov):
- **Bedrooms:** a room named as one, or with a bed in it ("Ah Ma's room", a studio), is a
  bedroom for "Which bedroom to check?". Any habitable room (not a bathroom, kitchen, yard,
  shelter or ledge) can be chosen, so a renamed room stays chosen. With one bedroom it is
  chosen already. Until one is chosen the phone's top reads "Wheelchair · Which bedroom? ·
  Bath/WC 2", the choice comes first in the list, and the desktop's Bedroom select is hidden.
- **One line per pinch:** the ageing list keeps every route line, 0.90 m ones included (a
  walking aid's routes are all 0.90 m, and clearance checks may be off). Where the walkways
  have the same pinch (the same pieces, on the way to the same rooms), the clearance list and
  its bar leave theirs out (`ageingSupersedes`). A route is never "also checked" while a way
  to one of the group's rooms is short.
- **Bedrooms, again:** a living room with a bed in it isn't a bedroom (it can still be chosen,
  and its own lines stay in the list). Corridors, foyers, stores and utility rooms are never
  offered. With no bedroom found (rooms still "Room 1", no beds), every room that can be chosen
  is offered in "Which bedroom to check?". A bedroom found for them is saved once shown, so a
  bed dragged into another room later doesn't switch it. A bed made by size in the bed shape
  counts as a bed. The toilet's zones are drawn inside the room's wall faces.
- **The bathroom line** says the room is too small even empty ("many HDB bathrooms can't")
  whenever it is, furniture or not (`empty` on a `turn`).
- **Show next** (from the plan details too) opens the line's details with "‹ Back to the list
  (n of N)" focused, and the line's reason straight under it. The list's top is sticky. Marks
  are drawn needed last (on top); outlines are solid, and only the flat's walls are dashed. A
  view link can use the check (it changes nothing). A blank plan says what to add; with no
  bathroom EASE lists none of the toilet's items. The toilet's front square is drawn inside
  its room.
- Wording: "someone with a walking aid", "… needs 0.45 m there to open it", "if someone falls
  behind it, it can't be opened from outside", "Bedroom to check: …", "Bathroom to check: …",
  "its door width", "from Furniture › Bathroom", EASE spelled out once.
- The timing tests run by themselves after the rest (`src/perf.test.ts`), and what ageing adds
  is bounded against walkways in the same run: at most max(15 ms, the walkways' time), three
  times that off a laptop.
