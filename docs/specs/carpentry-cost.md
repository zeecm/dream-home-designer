# Spec: built-in carpentry and a cost estimate

Roadmap item 1. Project-manager, 5 Nov 2026. Slice 1: M−, no schema change.

**Problem.** Owners learn the cost only from quotes; carpentry, about a third of it, comes
per foot run, which they can't picture.

## Built-in pieces (catalogue category "Built-in")
Kinds marked `carpentry` (code only), sized with the existing fields.

| Piece | w × d × h (m) | Priced as |
|---|---|---|
| Built-in wardrobe | 1.8 × 0.6 × ceiling | wardrobe |
| Full-height shoe cabinet | 0.9 × 0.35 × ceiling | tall cabinet |
| Built-in TV console | 2.4 × 0.4 × 0.45 | low cabinet |
| Kitchen base run | 2.4 × 0.6 × 0.9 | base + countertop |
| Kitchen wall run, at 1.5 | 2.4 × 0.35 × 0.7 | wall cabinet |

- "Ceiling" is the level's ceiling height when placed. Existing kitchen cabinets count;
  the free-standing wardrobe and TV console don't.
- Clearance: tall pieces 0.60 m in front; base run 0.90 m, part of a kitchen run.
- Foot run: width ÷ 0.3048, nearest whole foot, at least 1. Inspector: "2.40 m · 8 ft run ·
  about $1,600–2,800".

## Estimate (pure core `costEstimate(before, after?, rates)`)
Lines `{group, label, place, qty, unit, low, high}`:
- Walls, doors, windows, floors: from `renovationChanges`.
- Carpentry: built-ins new or resized in After (by id); no renovation, all.
- Painting: room perimeter × ceiling, plus ceilings.
- Debris once if anything is hacked; 10% contingency. No renovation: "Start a renovation to
  price hacking, walls and floors."
- Shelter lines unpriced; structural ones say "(structural)". Lines to $10, totals to $100.

| Rate (S$) | Unit | Low–high | Basis |
|---|---|---|---|
| Hack wall | m | 130–200 | $40–60/ft run [1] |
| Debris | lot | 400–800 | CP |
| New wall / half wall | m | 250–400 / 150–300 | CP |
| Glass partition / glass above | m | 700–1,200 / 350–600 | CP |
| Cut opening / close up | each | 300–600 / 250–500 | CP |
| Door: swing, double, sliding, pocket, bi-fold, folding | each | 400–700, 700–1,200, 600–1,200, 1,000–1,800, 900–1,600, 1,500–3,000 | CP |
| Glass leaves | each | +300–600 | CP |
| Window | each | 600–1,200 | CP |
| Floor: vinyl, timber, tile, marble, concrete, carpet | m² | 45–85, 110–220, 90–160, 215–375, 110–200, 40–90 | [2] vinyl, marble; CP |
| Painting | m² | 4.5–7 | flat $1,800–2,800 [3] |
| Wardrobe / tall cabinet | ft run | 200–350 / 180–300 | [1] / CP |
| Base / wall / countertop | ft run | 110–180 / 90–150 / 75–180 | [1] |
| Low cabinet | ft run | 100–200 | CP |

CP is common practice.

## Web (desktop panel; phone sheet)
- **Plan details:** "Cost estimate: about $X–Y" [See estimate], live.
- **Dialog** (phone: full sheet, stacked cards): Item · Where · Qty · Cost; subtotals per
  group (Building, Doors and windows, Floors, Painting, Carpentry), contingency, **Total**.
- **Rates:** low and high fields (`inputmode="decimal"`), switches for painting, debris and
  contingency, [Reset to typical]. Per browser (`dhd-rates`); low above high swaps. View
  links use the viewer's rates.
- **Output:** [Copy] gives a text table with the total and disclaimer; [Print] prints only
  the estimate, dated.
- **Disclaimer:** "A rough guide from typical Singapore prices (2025–2026), not a quote.
  Prices vary with materials, contractor and site. Get itemised quotes from HDB-registered
  contractors."

## Slice 2
Slice 2s prices every level: [slice-2s.md](slice-2s.md#c2-the-estimate-on-every-level-pr-3).
Platform bed, study and display cabinets, carpentry options, floor-tile hacking, electrical and
plumbing, rates in the project (schema change), a quote-request PDF, condo rates.

## Acceptance criteria
Unit (core):
1. `footRun`: 1.80 → 6, 2.40 → 8, 0.45 → 1.
2. 2.0 m hacked: $260–400, plus one debris line.
3. A 2.4 m glass partition: $1,680–2,880. A half wall with glass above: two lines.
4. Swing door added: one swing line; made bi-fold: one bi-fold line; lost with a hacked
   wall: none; opening closed up: one close-up line.
5. 10 m² refinished in vinyl: $450–850.
6. A new 1.8 m built-in wardrobe: 6 ft run, $1,200–2,100. Unchanged in both versions: no
   line. Resized: priced.
7. A base run adds a countertop line with the same foot runs.
8. No renovation: carpentry and painting lines only.
9. A 3 × 4 m room with a 2.6 m ceiling: 48.4 m² of painting.
10. Total = lines + 10%; contingency off: no such line. Edited rates are used.
11. Shelter lines excluded; structural ones marked.

E2e (desktop, and 390 px phone by finger):
12. Sample, wall hacked in After: details show a range; the hack line matches the change list.
13. An edited rate changes totals, survives reload; Reset restores it.
14. Built-in wardrobe resized to 2.4 m: "8 ft run" in estimate and Inspector; Undo removes it.
15. Copy gives lines, total and disclaimer; Print only the estimate.
16. Phone: a full sheet of stacked cards, no sideways scrolling, a decimal keypad.
17. Built-in wardrobe reaches the ceiling in 3D; plan PNG unchanged.

[1] https://www.99.co/singapore/insider/your-must-have-renovation-cost-breakdown/
[2] https://blog.moneysmart.sg/renovation-loans/renovation-singapore
[3] https://www.shopback.sg/blog/finance/hdb-renovation-cost
