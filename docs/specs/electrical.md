# Spec: electrical and lighting plan

Roadmap item 1. Project-manager, 6 Nov 2026. Slice 1: M, schema 9.

**Problem.** Owners find a missing bedside socket after plastering; contractors can't
count points.

## Points (schema 9)
`Level.points: z.record(ElecPoint).default({})` (migration a no-op). Bump `SCHEMA_VERSION`
and Go `SchemaVersion`, regenerate `hdb4room.json`, deploy the API before merge.
`ElecPoint { id, kind, wall?: {wallId, t, side, height}, at?: Vec2, gang?: 1–3,
compressorId?, route?: Vec2[] }`, exactly one of `wall`, `at`.

| Kind | Height (mm) | Symbol | New / move (S$) |
|---|---|---|---|
| 13A double, single socket | 300; 1150 over a counter | half-circle, 2 or 1 ticks | 80–150, 65–120 / 60–120 |
| Switch, 1–3 gang | 1050 | circle, tick, gang | 40–80 / 40–70 |
| Light, fan point | ceiling | circle-cross, "F" | 50–100, 70–120 / 40–80 |
| Data, TV point | 300 | triangle "D", "TV" | 80–150 / 60–110 |
| Aircon unit | top 200 below ceiling | box "AC" | 150–250 isolator |
| Compressor | ledge (plan) | box "CU" | in aircon package |
| Trunking | at the unit | dashed | 30–50 per m |
| Water heater, cooker | 2000, 600 | "WH", "C" | 120–200, 150–250 |
| Doorbell | 1200 | bell | 60–120 |

Removal 20–40. Sockets, lights [1]; the rest common practice.

## Placing (Electrical tool)
- Tool **Electrical**, a kind palette (one scrolling row on phones).
- Wall kinds: tap a face (within 0.3 m); the point lands there at its default height,
  never in a door or passage (moved to jamb + 50 mm), under a window only below the sill.
  Drag along or to another wall.
- Ceiling kinds and compressor: tap in a room or on the ledge.
- Aircon: then "Run trunking": tap bends, end on a compressor (placed if none); bends drag.
  Every leg runs square to the walls and hugs a face within 0.3 m (50 mm off it); Alt frees
  the angle; a dashed preview shows the next leg and its length. "Route along the walls"
  (bar and Inspector) routes it out through the outside wall or a window to the ledge in one
  undo step; "Straighten" squares an existing run (6 Nov, owner's report).
- Points follow their wall and splits; go with a deleted or hacked wall (one undo).
- Phone: magnifier; height in mm, `inputmode="decimal"`.

## Showing
- **Plan:** symbols on the face; "h1150" only off default. View toggle "Electrical" (per
  browser, on with the tool, in the PNG when on).
- **3D:** white faceplates 86 × 86 mm (double 146), 8 mm proud; unit, compressor and
  trunking as boxes; no ceiling points; not collidable.
- **Inspector:** kind, height, gang, room, warnings.
- **Warnings:** a socket in a bath/toilet/WC; a point on a shelter wall ("can't be chased
  or drilled"); on a structural wall ("surface trunking or check with HDB"); aircon without
  compressor.

## Estimate and contractor sheet
- Estimate group **Electrical**: "13A double socket, new · Bedroom 2 · 2 · $160–300".
  Renovation: by id against Before: new, removed, moved (other wall, or over 50 mm); a
  changed kind is new. No renovation: all new, noting "Start a renovation to price only what
  changes." Rates editable.
- Contractor dialog: "Electrical plan" (on with points) adds a page: plan grey, no
  furniture or dimensions, points black (After: new teal, removed red, moved teal with old
  spot faint), trunking with length, legend (symbol, kind, height, count), schedule (room,
  kind, qty, height), "Work by a Licensed Electrical Worker."

## Slice 2
Slice 2s builds "Suggest points" per room: [slice-2s.md](slice-2s.md#a-suggested-electrical-points-per-room-pr-1).
"Suggest points" per room type and furniture (bedroom: sockets each side of the bed, switch
by the door, centre light, aircon on the bed wall), switch-to-light links, sockets hidden
by furniture, circuits, 3D ceiling points.

## Acceptance criteria
Core (Vitest):
1. v8 parses as v9 with `points: {}` on every level; both `wall` and `at`, or gang 4, fail.
2. `pointPosition`: 4 m centred 0.1 wall, t 0.25, left, 0.3 → 1.00 along, 0.05 off, 0.30 up.
3. `defaultHeight`: socket 0.30, by a kitchen base run 1.15, switch 1.05, aircon top 2.40
   at a 2.6 ceiling.
4. Socket in a door's width → jamb + 50 mm; under a 1.0 m sill a socket stays, a switch
   moves.
5. Commands undo and redo; deleting a wall deletes its points, one undo restores; a split
   keeps positions within 1 mm.
6. `trunkingLength` (0,0) → (3,0) → (3,2): 5.00 m.
7. No renovation, 3 double sockets and a light: $240–450 and $50–100.
8. Renovation: moved 1 m → relocate; removed → removal; unchanged → none; single to double
   → new double; on a hacked wall → removed.
9. Aircon with 5 m trunking: $150–250 plus $150–250.
10. The four warnings; `pointCounts` match the lines.

E2e (desktop; 390 px phone by finger):
11. A socket on a bedroom wall: Inspector 300 mm; set 1150: "h1150"; Undo; reload keeps it.
12. A light point draws a circle-cross; 3D shows the socket faceplate.
13. Toggle off hides symbols (plan, PNG); survives reload.
14. Aircon, two bends: Inspector length equals the estimate line.
15. Bathroom socket: warning on plan and Inspector.
16. Renovation, socket moved: "relocate" line, teal on the electrical page; legend counts
    match.
17. View link: symbols, no tool.
18. Phone: magnifier placing, drag, decimal keypad, no sideways page scroll.
19. Production API accepts a v9 save.

[1] https://www.homejourney.sg/blog/how-to-choose-electrician-price-singapore-2025-provider-homejourney-202512251239
