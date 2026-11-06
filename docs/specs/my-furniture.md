# Spec: My furniture and the way in

Spec by the project-manager agent, 6 Nov 2026. Slice 1, effort M−. Schema 8, additive.

**Problem.** "Will my sofa fit?", answered before delivery day, not on it.

## Storage
`Item` has no name and `CustomModel` needs a GLB hash, so: schema 8 (migration a no-op), Go
`SchemaVersion` 8, testdata regenerated, API deployed first.
- `CustomModel.hash` optional; new optional `shape` (`sofa | bed | table | cabinet | box`),
  `material` (fabric, fabric-light, wood, wood-dark, white, charcoal), `diagonal` (sofa, m).
  Exactly one of `hash`, `shape`.
- `customKind` builds the shape's boxes at `size`. Items: `assetId` = its id, scale 1.
  `syncModels` and the 40-upload cap skip hash-less entries; `updateModel` / `deleteModel`
  rename and remove.

## Adding one
Catalogue "Your furniture": [Add by size], [Upload a model]. Form: name, shape chips, width,
depth, height (0.05–6 m), colour swatches; sofa: optional "Diagonal depth" with a how-to
sketch. The diagonal is its width across when tipped on its back (back top to front bottom), so
core `diagonalRange(d, h)` allows d·h / √(d² + h²) up to min(d, h), ± 5 mm; otherwise "Between
0.69 and 0.95 m for this sofa." under the field, which is focused. The hint shows the range
once depth and height are typed. Save starts placing it.

## The way in (core `deliveryCheck(level, itemId, opts)`)
- **From:** doors in `outsideOpenings`, widest first; several: a "From" picker; none: every
  door. Remembered per browser per project.
- **Route:** rooms joined by doors and passages, freely across boundaries. Fewest openings
  among passing routes, else fewest openings.
- **Clear width:** passage, pocket: width; swing − 0.04; double − 0.08; sliding × (1 −
  1/panels); bi-fold, folding − 0.04 × panels. Height: opening height.
- **Passing:** try each carry: length `l` along the way, `t` across, `v` up (6 orders of w,
  d, h; a sofa with a diagonal also t = diagonal, v = √(d² + h²), l = w). Passes if t ≤ W,
  v ≤ H, and on each side the space in front `C` (perpendicular ray to walls and built-ins,
  cap 3 m) ≥ l or l ≤ min over θ of (W sin θ + C cos θ − t) / (sin θ cos θ).
- **Result:** fits (≥ 20 mm spare), tight, too big; swing or double passing at full width:
  "fits with the door off its hinges". Uses `itemSize`.
- Floor pieces only (not built-ins, people, rugs). An optional lift door is checked first.

## How it shows (desktop and phone sheet)
Inspector "Getting it in":
- "Fits through every door on the way in. Narrowest: Bedroom door, 0.86 m."
- "Too big for the Bedroom door: 0.86 m wide; the sofa needs 0.95 m on its side."
- "Can't turn through the Bedroom door from the 1.05 m space in front."
- "Put it in a room to check the way in." / "Add the main door first."
- "Measure the lift and the gate too: many HDB lift doors are about 0.9 m wide." [Lift door]

Plan: a dashed route, door to door to the piece, each door labelled with its clear width;
tight amber, too big red. Drawn for a selected My furniture piece, others via [Show the way];
hidden while moving; not in PNG, 3D or walk. Runs on the version shown; never blocks.

## Out of scope (slice 2)
Slice 2s builds the lift and an editable diagonal: [slice-2s.md](slice-2s.md#b1-the-lift-pr-2-schema-10).
Corridor widths along the route, lift car, stairs, legs off, furniture in the way, a saved
main door (shared with clearance slice 2), the route in 3D.

## Acceptance criteria
Unit (core):
1. Clear widths: 0.90 swing 0.86; 1.60 double 1.52; 1.80 two-panel sliding 0.90.
2. Sofa 2.0 × 0.9 × 0.85, 0.80 door, open space: too big, needs 0.85; diagonal 0.75: fits.
3. Box 0.5 × 0.5 × 2.3, 2.1 m door: fits.
4. Turn limit at W 0.8, C 1.0, t 0.6: 1.33 ± 0.01 m.
5. Sample flat, piece in the Bedroom: route from the main door to the Bedroom door; needing
   0.88: "off its hinges"; 0.95: too big, Bedroom door named.
6. Two routes, one too narrow: the other; a room with no door: unreachable.
7. Two outside doors: widest first; none: no route.
8. A schema 7 document loads unchanged; neither hash nor shape fails to parse.

E2e (desktop, and 390 px phone by finger):
9. Add by size "My sofa" 2.1 × 1.0 × 0.95: placed; survives reload and a share link.
10. In the Bedroom: criterion 5's message; that door red on the plan.
11. Moved to the living room: "Fits through every door"; route redrawn on release.
12. Added with diagonal 0.80: the Bedroom passes. A diagonal of 1.5 is refused under its field
    ("Between 0.69 and 0.95 m for this sofa."). Editing it later is slice 2s B2.
13. Remove "My sofa": its pieces go in one undo step; no upload attempted.
14. Plan PNG has no route; [Show the way] on a catalogue sofa stays clear of the phone sheet.
