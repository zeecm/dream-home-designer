# Spec: folding and sliding doors, half walls, glass walls

Owner request (5 Nov 2026). Spec by the project-manager agent.

**Problem.** Singapore renovations swap swing doors and solid walls for sliding, bi-fold and
folding glass; people can't judge openness or clashes from a flat plan.

## Model (schema 7)
- Walls: `height` exists (half walls are presets on it). New `build?: 'solid' | 'glass'`,
  `glassAbove?: boolean` (half wall with fixed glass over it), `structural?: boolean`.
- Openings (doors): `style?: 'swing' | 'double' | 'sliding' | 'pocket' | 'bifold' | 'folding'`
  (absent = swing), `panels?: number`, `glazed?: 'clear' | 'frosted' | 'fluted'`,
  `stack?: 'a' | 'b'`. A folding partition is a door filling its wall between the inside
  corners ("Fill the wall").

## HDB defaults
| Kind | Default | Range |
|---|---|---|
| Bathroom bi-fold | 700 mm, 2 leaves, frosted | 650–800 |
| Bedroom sliding | 900 mm, 1 leaf, on the wall face | 800–1000 |
| Pocket | 800 mm | 700–900 |
| Kitchen folding glass | fills the wall, ~500 mm panels, clear | 1.5–4 m, 3–8 panels |
| Kitchen sliding glass | 3 leaves | 1.8–3.6 m |
| Half wall | 1.0 m; presets 0.9 / 1.05 / 1.2 | 0.3 m to ceiling − 0.1 m |
| Glass wall | 50 mm frame, 10 mm glass; clear, frosted, fluted | 40–100 mm |
Door height 2.1 m.

## 2D symbols (also in PNG and print)
Sliding: two offset leaf lines in the wall and a travel arrow. Pocket: dashed leaf in the
wall. Bi-fold and folding: zigzag of half-open panels, stack side marked, their sweep shown
like a swing arc. Glass wall: two thin lines, pale blue-grey fill. Half wall: lighter fill and
a tag "HW 1.0" ("HW 1.0 + glass").

## 3D and walk
Plain transparent glass (no transmission); frosted more opaque; ~40 mm aluminium frames; half
walls capped. Doors up to 1.2 m open within 2 m like swing doors (slide, fold, ~0.35 s);
wider partitions start shut and toggle by tap, E, or walking into them. Glass and half walls
block walking; shut partitions block, open ones pass; stacked panels are solid. Reduced
motion: no animation. A "Play" button in the details runs the animation once.

## Change list
"Door changed from swing to bi-fold (Bathroom 2 / Corridor)"; "Wall cut down to 1.0 m half
wall"; "Wall replaced by a glass partition" (old hacked, glass built). Structural or shelter
walls warn when edited.

## Phone
Style chips with icons, panels stepper, stack toggle, Play, Fill the wall; wall details Full /
Half (presets) / Glass and a "Glass above" switch; 44 px targets.

## Acceptance criteria
1. Every style placeable and changeable by finger and mouse; its own symbol in plan, PNG, print.
2. A style change is one undo step; survives reload and the 6 → 7 migration.
3. Fill the wall sizes to the clear width; refuses over another opening.
4. Glass see-through in 3D; frame rate within 10% with 3 glass walls added.
5. Walking never crosses glass, half walls or shut partitions; passes open ones.
6. Bi-fold opens within 2 m; a 2.4 m partition toggles by tap or E; reduced motion snaps.
7. Each change type in the change list and Copy list.
8. Half-wall preset shows in the plan tag and 3D.
9. Fingers-only e2e: place a bi-fold, flip its stack, undo.
