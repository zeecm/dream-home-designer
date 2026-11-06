# Spec: Plan for contractors (PDF)

Project-manager agent, 6 Nov 2026. Slice 1, M−. No schema change, no new deps.

**Problem.** Contractors quote from a measured plan; the PNG has no dimensions or scale.

## Offering it
Projects menu, Download: "Plan for contractors (PDF)", disabled without walls. Dialog (sheet
on phones): Paper A4 / A3 with its scale, Version (After / As it is now), "Include
furniture" (off; built-ins always), [Print or save as PDF], hint "Save as PDF, scale 100%".
Current level, printed from a hidden iframe like `printPlan`.

## The sheet
Landscape, `@page { size: A4|A3 landscape; margin: 0 }`, one SVG per page, plan-up =
paper-up, dark on white in any theme.
- **Scale:** largest of 1:50, 1:100, 1:200 that fits (10 mm margins, 70 mm title column,
  30 mm dimension bands); else fitted, "Not to scale".
- **Drawing:** walls, door swings, windows, glass, half walls, boundaries, structural and
  shelter hatch; in After, hacked (red) and new (teal). Rooms: name, m², sq ft. Openings
  tagged "D 900", "W 1200"; built-ins with name and length. No plan image, grid or handles.
- **Dimensions** in mm, to 10 mm: up to three tiers per outside side (openings and piers;
  corners; overall), and each room's clear width and depth.
- **Title column:** name, date, version, scale, 5 m scale bar, north arrow (`site.north`),
  "Dimensions in mm. Areas to wall centre lines.", "For discussion, not for construction.
  Check on site.", page n of N, legend.
- **Page 2** (After only): `renovationChanges` with "(structural)" marks and the permit note,
  then ruled Notes lines. No prices: the estimate is the owner's.

## How it is built
- core `dimensions.ts` `planDimensions(level)` → `{ chains, spans, tags }` in metres:
  - chains `{ side, tier, at, stops[] }`: outside walls (room on one side) within 1° of an
    axis join the side they face; tier 1 stops: outer-face ends; tier 0 adds opening edges;
    tier 2: min–max. Stops within 5 mm merge; a piece under 20 mm joins its neighbour; a
    tier equal to the next is dropped. Other outside walls: an `aligned` chain on the face.
    A face beside a room closed by a boundary (a terrace) is inside it for half the wall's
    thickness. Chains run outside the extent: walls, boundary lines, door swings and (After)
    hacked walls.
  - spans `{ roomId, a, b }`: rays ±x, ±y to the nearest face or boundary, through the label
    point, or on the nearest line beside it clear of tags, door leaves and hacked walls with
    room for the figure; none when no line is clear, under 0.6 m, or for a room under 95% of
    its bounding box (an L).
  - tags `{ openingId, at, width }` (the width as the opening fits its wall);
    `roundChain(stops, step)` makes rounded pieces add up.
- core `sheetScale(bounds, paper)` → `{ scale, fits }`.
- web `print/contractorSheet.tsx`: its own SVG over `planGeometry`, `doorSwing`,
  `wallStatuses`, `renovationDiff`, via `renderToStaticMarkup`; not the screen layers.

## Slice 2 (out of scope)
All levels, door and window schedule, QR share link, electrical plan, DXF.

## Acceptance criteria
Core (Vitest):
1. 4 × 3 m room, 100 mm walls: overall top 4.10, left 3.10; no tier 0 or 1; spans 3.90, 2.90.
2. A 1.20 window centred on the top wall: tier 0 is 1.45 / 1.20 / 1.45.
3. `roundChain([0, 1.234, 2.468, 3.702], 0.01)` sums to 3.70.
4. A 45° corner cut: an aligned chain of its face; its ends are stops on both sides.
5. Sample flat: overalls equal the footprint bounds ±1 mm; each outside window is a tier-0
   pair on one side only; every tier adds up to its overall.
6. A room closed by a boundary measures to the boundary line.
7. `sheetScale`: sample A4 1:100, A3 1:50; 25 m wide: 1:200, `fits` false.

E2e (desktop, `window.print` stubbed):
8. Blank plan: disabled.
9. Sample, A4: dialog says 1:100; sheet has name, today's date, "For discussion, not for
   construction", 1:100, scale bar, north arrow, four overalls.
10. Every room's name and area; door tags match Inspector widths.
11. No renovation: one page, no hacking legend. A wall deleted in a renovation: legend on
    page 1, page 2 matches Copy list.
12. Dark theme: dark on white; no plan image or handles.
13. View and undo history unchanged afterwards.

QA by hand: phone dialog at 390 px; Chrome PDF: the 5 m bar measures 50 mm at 1:100.
