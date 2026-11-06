# Spec: live clearance and furniture-fit checks

Roadmap item 1. Spec by the project-manager agent, 5 Nov 2026. Slice 1 effort S+. No schema
change.

**Problem.** Wardrobe doors hit the bed, the fridge can't open: found at handover.

## Checks (core `clearanceIssues(level, moving?)`)
`clearanceRules`: a table keyed by catalogue id. A zone is a rectangle off a side of the piece
(front = item +y), its width, turning with it. **Have** = distance to the nearest obstacle in
the zone; short when have < need.

| Pieces | Zone | Need (mm) | Basis |
|---|---|---|---|
| Wardrobe | front | 600 | leaf + standing (Neufert) |
| Chest of drawers, Shelf with drawers | front | 750 | drawer out + standing (Neufert) |
| Desk, Metal desk | front | 800 | chair pulled out (common practice) |
| Fridge; base, sink, hob cabinets | front | 900 | NKBA walkway 915; HDB galleys |
| Washing machine | front | 700 | common practice |
| Toilet / Vanity | front | 600 / 700 | BS 6465-2 activity spaces |
| Queen, King bed | each long side | 600 | Neufert 600–700 |
| Single, Super single bed | better long side | 600 | other side may be a wall |

- **Obstacles:** wall footprints (openings count as wall), floor pieces. Not: `walkThrough`
  (rugs), people, tabletop/high/ceiling layers, room boundaries, zones. Seats don't block a
  desk; kitchen cabinets touching at a corner don't block each other.
- **Door swing:** a floor piece meets the area its leaves sweep (`doorSweep`: `doorLeaves`
  sampled 0..1), any style.
- **Overlap:** floor pieces overlapping > 20 mm; seats under tables and desks allowed.
- **Into a wall:** a non-ceiling piece > 10 mm into a wall.
- Uploaded models: door, overlap, wall only. Runs on the version shown.

## Plan (desktop and phone)
- Problems tinted red under furniture: a short zone to its full need, a blocked swing, an
  overlap.
- Selected or moving piece labels its short zones "0.32 / 0.60 m".
- While moving (preview, drag, arrows, resize, turn), live every frame: its zones faint grey
  when fine, red when short.
- Plan details: switch "Clearance checks" (default on, remembered per browser); "3 clearance
  problems" [Show next] selects the next; hidden at 0.
- Never blocks an edit. Not in PNG, print, 3D or walk.

## Inspector (selected piece; phone sheet too)
"Clearances", app length format:
- "Wardrobe doors need 0.60 m in front; 0.32 m here."
- "Needs 0.60 m beside the bed; 0.42 m left, 0.38 m right."
- "Blocks the Bedroom 2 door." / "Overlaps the Bedside table." / "Goes 0.04 m into a wall."
- None: "Room to use it." Switch off: hidden. A drop's announcement adds the first problem.

## Out of scope (slice 1)
Moved to [Slice 2](#slice-2) (walkways, dining chairs, door clashes, plan labels, the drop
announcement) and [Slice 3](#out-of-scope-slice-3) (everything else).

## Acceptance criteria
Unit (core):
1. Wardrobe 0.32 m from a wall: one issue, need 0.60, have 0.32 (±1 mm); at 0.60: none;
   turned 90°, the zone turns.
2. A bedside table in the zone blocks; a rug or person doesn't.
3. Queen bed 0.40 m off a wall: one issue; single bed on a wall, 0.70 m on the other side: none.
4. Sofa in the swing of a swing, double or bi-fold door: issue; beside a sliding door clear of
   its leaves: none.
5. Sofas overlapping 50 mm: issue; 15 mm: none; dining chair under a table: none.
6. Wardrobe 40 mm into a wall: issue; backed by `placeFurniture`: none.
7. L kitchen corner: none; galley 0.85 m between runs: one per facing cabinet.
8. Uploaded model: only door, overlap, wall issues.
9. 80 pieces: under 2 ms.

E2e (desktop, and 390 px phone by finger):
10. Wardrobe dragged to face a wall 0.3 m away: red zone before release; Inspector "... 0.30 m
    here."
11. Dragged clear: grey while moving, gone after; "Room to use it."
12. Sofa dropped in a door swing: swing red; Undo clears it.
13. Count matches; [Show next] cycles; switch off hides all and survives reload.
14. Plan PNG has no zones; 3D unchanged.
15. Before and After count separately.

---

## Slice 2

Spec by the project-manager agent, 6 Nov 2026. Effort **M** (walkways M; the rest S each).
**No schema change**, no API change, no deploy needed.

**Problem.** Slice 1 checks each piece on its own. What HDB owners actually get wrong is the
flat as a whole: the sofa and dining table squeeze the way to the bedrooms, the chairs can't
be pulled out because the table is pushed to the wall, and the bathroom door hits the bedroom
door in the 1 m corridor. These are found on handover day, after the carpentry is built.

### User stories
1. As an owner arranging the living and dining, I see at once if my furniture narrows the
   way from the main door to any room, where the narrowest point is, and by how much.
2. As an owner in a small common bedroom, I see if I can still walk to the side of the bed
   once the wardrobe and desk are in.
3. As an owner choosing a dining table, I see if each chair can be pulled out to sit down.
4. As an owner changing door swings in the renovation, I see doors that hit each other or
   hit a wardrobe or fridge door.
5. As an owner checking a piece, I read its shortfall on the plan ("0.32 / 0.60 m") without
   opening the Inspector, and a screen reader tells me the first problem when I drop it.

### Order of value (what's in, what waits)
| # | Check | Value for an HDB owner | Effort | Slice |
|---|---|---|---|---|
| 1 | Walkways from the main door, and to bed sides | Highest: the most common layout failure in 3- and 4-room flats | M | 2 |
| 2 | Dining chair pull-back | High: the dining area is the tightest part of most HDB living rooms | S | 2 |
| 3 | Door clashes (door vs door, door vs a wardrobe/fridge door) | High: HDB corridors put 3 to 4 doors within 2 m | S | 2 |
| 4 | Shortfall labels on the plan; drop announcement (slice 1 leftovers) | Medium; makes 1 to 3 readable at a glance | S | 2 |
| 5 | Editable numbers, Fix it, sliding fronts, kitchen triangle, saved main door | Lower or needs a schema change | | 3 |

### Rules and numbers

**W. Walkways.** Two kinds of route, both found on the plan as it is shown (Before or After).

| Route | From | To | Need | Basis |
|---|---|---|---|---|
| Circulation | the main door | every room with a door, passage or boundary into it | **0.90 m** | Neufert: 900 mm for one person between furniture; UK Approved Document M4(2) (accessible and adaptable dwellings): hallways 900 mm clear; NKBA walkway 915 mm. 900 also lets a person carry a laundry basket or a child past, and is what a walking frame needs |
| To the bed | the bed's room door(s) | each long side of a bed that slice 1 counts as usable | **0.60 m** | Neufert 600 mm minimum passage between pieces; matches slice 1's bed-side rule, so a common bedroom with a queen bed isn't flagged for being an HDB common bedroom |

- **Main door:** `mainDoors(level)[0]` (shared with My furniture: hinged door to the outside,
  widest). Only doors to the outside count here; with none, no walkway check and the plan
  details say "Add the main door to check walkways." Not saved (slice 3).
- **Never stricter than the flat:** a route's need is `min(need, bare width − 0.02)`, where the
  bare width is the same route's pinch with no furniture. A 0.85 m corridor built by HDB isn't
  a furniture problem; a shoe cabinet in it that leaves 0.65 is ("needs 0.85 m, the corridor's
  own width").
- **Doorways don't count against the width:** the clear width of a 0.80 m door is 0.76 m; door
  widths are the ageing-parents check's job. Free cells in a door's throat (its span × the
  wall thickness + 0.45 m each side) are passable at any width; furniture there still blocks.
- **Obstacles:** solid wall pieces and hubs (half walls, glass walls and windows included),
  room holes (columns), everything outside the rooms, and floor pieces that `blocks()` in
  slice 1 (rugs, people, tabletop, wall-hung and ceiling pieces don't), **including** dining
  chairs, seats and uploaded models. Door leaves are ignored (the way is checked with doors
  open). Room boundaries are free.
- **Widest way, narrowest point:** the route reported is the widest one (maximin), so a tight
  gap between sofa and coffee table (normal: 400 to 450 mm) doesn't matter while there's a
  wider way round. `have` = the route's narrowest clear width; the **pinch** is where it is.
- **Method (for tech-lead to confirm):** rasterise at 50 mm; Euclidean distance transform from
  obstacle cells; maximin search (bucket queue on the integer distance, O(cells)) from the
  main door's inside throat; walls-only grid cached like `fixedParts`. Refine the pinch: the
  exact distance from the pinch point to the nearest obstacle polygon, plus to the nearest on
  the opposite side; report that sum, so the label matches a tape measure to ±20 mm.
- **Who is blamed:** the floor pieces among the two obstacles at the pinch (one or two). A
  pinch between two walls is never reported (the bare-width cap). One issue per piece per
  pinch, listing every room and bed side beyond it.
- **Unreachable:** furniture closes the way completely: `have` 0, the pinch is the gap the
  widest bare route used, the pieces that fill it are blamed. A room that no door, passage or
  boundary joins is skipped. Rooms under 1.0 m² (an A/C ledge) are skipped.
- **Bed side target:** the slice 1 side zone (foot to bedside table). Reached when the route
  touches it at the need. A side slice 1 already reports short isn't checked again; a single
  bed is checked on its better side only. Start: the doors of the bed's room; a bed in the
  main door's room or joined only by boundaries (a studio) starts from the main door.

**D. Dining chairs: room to pull out and sit.**
- Tables: `dining-4`, `dining-6`, `wooden-table`, `pedestal-table-round`. Chairs:
  `dining-chair`, `dining-chair-upholstered`, `plastic-chair`.
- A chair belongs to the nearest of those tables whose footprint is within 0.30 m of it
  (tucked under counts). A chair with no table near isn't checked; a table with no chairs
  isn't either (its Inspector says "Add chairs to check the room to sit.").
- Zone: from the table edge nearest the chair, outward (from the edge's nearest point through
  the chair's centre, so a chair turned a little still works), as wide as the chair,
  **0.75 m** deep. `have` = table edge to the nearest wall or floor piece in it, not counting
  this chair or its table (a chair of another table behind does count).
- Basis: Neufert 750 mm table edge to wall to stand up and sit; 900+ if people pass behind
  (covered by the walkway when the route goes there).

**C. Door clashes.**
- **Door vs door:** leaves of two different doors whose sweeps (`doorSweep`) overlap by more
  than 20 mm. A double door's own leaves never clash. Sliding and pocket doors have thin
  sweeps, so they rarely clash, correctly.
- **Door vs a piece's door:** a door's sweep overlaps a hinged front's reach by more than
  20 mm. Reach (off the front, full width): wardrobe and built-in wardrobe 0.45; shoe cabinets
  (both) 0.40; fridge = its width (0.70 as listed, scaled with the piece); washer 0.45;
  chest of drawers and shelf with drawers 0.45 (drawers out); kitchen base, sink, hob and
  built-in base run 0.45. Basis: typical leaf widths (Neufert; carpenters' 450 mm leaf).
- A piece's footprint in a swing stays slice 1's 'door' issue; this check is only for the
  piece's own doors.

**L. Labels and announcement (slice 1 leftovers).**
- The selected or moving piece labels each short zone "0.32 / 0.60 m" (have / need, app length
  format), centred on the zone's far edge, upright, red, 11 px on screen at any zoom.
- Every walkway pinch: a red bar across the gap, end ticks on the two obstacles, label
  "0.62 / 0.90 m". Always shown while checks are on (pinches are few).
- A drop or move's live-region announcement adds the piece's first problem.

### Core API (shape; tech-lead may refine)
```ts
type ClearanceIssue =
  | { kind: 'zone'; itemId; side: 'front' | 'left' | 'right' | 'back'; what; need; have; zone }
  | { kind: 'walkway'; itemId; route: 'circulation' | 'bed'; to: { roomId?; bedId?; side? }[];
      need; have; pinch: [Vec2, Vec2]; path: Vec2[] /* main door to pinch to target, <= 60 pts */ }
  | { kind: 'doors'; openingId; otherId; sweep }        // one per door, both ways
  | { kind: 'door-front'; itemId; openingId; zone }      // the reach that's hit
  | ...slice 1 kinds unchanged;
walkwayStatus(level): 'ok' | 'no-main-door' | 'issues'   // for the plan details line
```
Chair zones use `kind: 'zone'`, `side: 'back'`, `what: 'Pulling out the chair needs'`.

### Plan (desktop and phone)
- Red as slice 1: chair zones like other zones; both sweeps of clashing doors; the reach of a
  hit wardrobe/fridge front; walkway pinch bars with labels.
- Selected piece with a walkway issue: its route drawn as a faint dashed line from the main
  door through the pinch to the room door or bed side.
- While moving: zones per frame (as now); walkways recomputed at most every 100 ms and on
  release, so the pinch bar follows the piece.
- Not in PNG, print, contractor sheet, 3D or walk (`data-export="skip"`). Never blocks an edit.
- Phone: same drawings; labels 11 px; the plan details and Inspector lines are on the sheet.

### Issue list
- **Inspector, piece** (Clearances section, one line each):
  - "Narrows the way to Bedroom 2 and Bath/WC 2 to 0.62 m; a walkway needs 0.90 m."
  - "Narrows the way to the bed's left side to 0.48 m; 0.60 m needed."
  - "Closes the way to Bedroom 2." (have 0)
  - "Pulling out the chair needs 0.75 m from the table; 0.52 m here."
  - "Its doors hit the Bedroom 2 door when both are open."
  - Capped need: "...; 0.85 m needed, the corridor's own width."
- **Inspector, door** (new Clearances section on openings, only when there's a problem):
  "Hits the Bath/WC 1 door when both are open." / "Hits the wardrobe doors when both are open."
- **Plan details:** "N clearance problems [Show next]" where N = pieces with problems + doors
  with clashes. Show next goes through pieces (sorted, as now), then doors (selects the door).
  Below it, one walkway line: "Walkways: room to walk from the main door to every room." /
  "Walkways: tight to Bedroom 2 (0.62 m), Bath/WC 2 (0.62 m)." / "Add the main door to check
  walkways." Hidden when checks are off.

### Edge cases
- Before and After are checked separately; the main door may differ between them.
- Several outside doors (main door and a service-yard door): only the main door is a start.
- The main door's own throat blocked by a shoe cabinet: every room "closes the way"; one
  issue on the cabinet listing all rooms.
- A piece outside every room: ignored by walkways (outside is blocked anyway).
- Overlapping pieces, pieces into walls: obstacles as they are; slice 1 reports the clash.
- A bed with both long sides against walls and nothing usable: slice 1 reports it; no
  walkway issue.
- Round table: its square footprint is used (slight over-report, accepted).
- Empty plan, no rooms, or no furniture: no walkway, dining or front issues; door clashes
  still checked.
- Performance: walkways on the sample flat with 40 pieces under 15 ms on a laptop (CI test
  bound 40 ms); the plan stays at 60 fps while dragging (the throttle).

### Acceptance criteria
Unit (core):
1. Fixture: two rooms joined by a 1.2 m corridor, an outside door at its end, no furniture:
   no walkway issues; `walkwayStatus` 'ok'.
2. A 0.35 m deep shoe cabinet in that corridor: one walkway issue on it, `need` 0.90,
   `have` 0.85 ± 0.02, pinch ends on the cabinet face and the opposite wall face, `to` names
   the far room.
3. A bare 0.85 m corridor: no issue; with a 0.20 m shelf in it: issue, `need` 0.83 ± 0.01,
   `have` 0.65 ± 0.02.
4. A piece filling the corridor: `have` 0, blamed on it.
5. A 0.80 m swing door on the route (clear 0.76): no issue from the doorway.
6. A table with 0.60 m on one side and 1.00 m on the other: no issue (widest way); with both
   sides 0.60: one issue, `have` 0.60 ± 0.02.
7. A rug, a person, a wall cabinet and a TV on its console across the corridor: no issue; an
   uploaded model: issue.
8. A room boundary on the route: free; a half wall or glass wall across it: the room beyond
   is skipped as not joined, or reached the other way round if there is one.
9. Queen bed, wardrobe 0.50 m past its foot, the only way to its right side: `route` 'bed',
   `need` 0.60, `have` 0.50 ± 0.02, on the wardrobe and the bed; a side slice 1 reports short
   isn't reported again; a single bed against a wall: only its open side is checked.
10. No door to the outside: no walkway issues; `walkwayStatus` 'no-main-door'.
11. One pinch on the way to two rooms: one issue per blamed piece, `to` lists both.
12. Sample flat with no furniture, Before and After: zero walkway issues (no false alarms
    from HDB's own walls and doors).
13. Chair at a dining-4, wall 1.00 m from the table edge: none; at 0.55: zone issue, `side`
    'back', `need` 0.75, `have` 0.55 ± 0.005; the chair turned 30°: same `have`; a chair
    0.50 m from any table: none; a chair of another table back to back 0.60 m behind: issue.
14. Two swing doors on walls meeting at a corner, sweeps overlapping: one `doors` issue for
    each; moved 0.3 m apart: none; two sliding doors side by side: none; a double door: none.
15. Wardrobe front 0.30 m from a door's sweep: `door-front` issue; 0.50 m: none; a bookshelf
    there: none (no hinged front).
16. Sample flat with 40 pieces: walkways under 40 ms in the test.

E2e (desktop, and 390 px phone by finger):
17. Sample flat: plan details read "Walkways: room to walk from the main door to every room."
18. A 3-seat sofa dragged across the way to the bedrooms leaving under 0.90 m: a red pinch bar
    and "0.xx / 0.90 m" appear before release and stay after; the sofa's Inspector reads
    "Narrows the way to ... to 0.xx m; a walkway needs 0.90 m."; the walkway line names those
    rooms; Undo clears all three.
19. Selecting the sofa draws its route (dashed) from the main door; deselecting hides it.
20. A dining table placed 0.3 m from a wall with a chair between: red zone, label
    "0.xx / 0.75 m", Inspector "Pulling out the chair needs 0.75 m from the table; 0.xx m here."
21. Two doors placed so their swings overlap: both sweeps red; selecting one shows "Hits the
    ... door when both are open."; Show next stops at the door after the pieces.
22. A wardrobe dragged short of room shows "0.xx / 0.60 m" on its zone while moving and while
    selected; the drop's announcement (live region) includes its first problem.
23. The count reads "N clearance problems" and Show next visits N stops then wraps.
24. Switch off: pinch bars, chair zones, clashing sweeps, labels and the walkway line all
    hidden; still off after reload.
25. Plan PNG, print and contractor sheet show none of it; 3D unchanged.
26. Before and After show their own walkway lines and counts.
27. Phone (390 px, touch only): 18 and 20 by finger; labels readable; the walkway line and
    Inspector lines on the sheet; nothing overflows.

### Out of scope (slice 3)
- **Editable numbers:** per-rule overrides (walkway 0.90, bed 0.60, chairs 0.75, ...) kept in
  localStorage like the cost rates, with a "For a wheelchair" preset (1.20 m walkways, 1.50 m
  turning) shared with the Ageing parents check (roadmap 4).
- **Fix it:** move a piece out of a zone or pinch by the shortfall when that creates no new
  problem; otherwise say which piece to move.
- **Sliding or hinged fronts:** a per-piece option (schema change) so a sliding wardrobe needs
  no swing and no door-front reach.
- **Kitchen work triangle** (sink, hob, fridge: legs 1.2 to 2.7 m, total 4.0 to 7.9 m; NKBA),
  as information only: HDB galley and L kitchens fix the sink and gas points, so it is often
  not actionable.
- **A saved main door** (schema change; shared with My furniture slice 2) and walkways from a
  second entrance (service yard, back door).
- Live zones for a piece being placed from the palette (before the drop); zones cut at walls.
- Walkways to wardrobe fronts, desks, windows (aircon servicing) and the household shelter's
  contents; stools at a kitchen island; counter seating.
- Door widths for a wheelchair (850 mm), turning circles: the Ageing parents check.
- Routes in 3D or the walk-through; walkway pinches on the contractor sheet.
