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

## Out of scope (slice 2, M)
Walkways (900 mm from the main door to every room and bed), dining chair pull-back (750 mm),
door-to-door clashes, kitchen triangle, sliding wardrobes, editable numbers, auto-fix.

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
