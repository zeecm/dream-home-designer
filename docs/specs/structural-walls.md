# Spec: structural and household-shelter walls, with hacking warnings

Roadmap item 1. Spec by the project-manager agent, 5 Nov 2026. Effort S. No schema change.

**Problem.** Owners plan an open kitchen, then learn the wall is structural or the shelter's.

## Model (schema 7 as it is)
- `structural`: `true` = structural, `false` = the person said no, absent = not decided.
- Shelter walls are found, not stored: beside a room matching the shelter pattern
  (`shelter|bomb|HS`), checked on Before.
- Core `wallStatus(level, wallId)`: `'shelter' | 'structural' | 'likely' | 'none'`. `likely`
  = no flag and thickness ≥ 200 mm. Boundaries are `none`. Warnings and AI locks treat
  `likely` as structural.
- Sample flat: its 300 mm and shelter walls `true`, the rest `false`.

## Marking (Inspector; same on the phone sheet)
- Switch "Structural wall", help "Load-bearing concrete. HDB plans draw these solid or
  hatched."
- `likely`: note "300 mm thick, so probably structural." [Yes, structural] [No].
- Shelter walls: switch on, disabled, current shelter note.
- The switch always writes to Before (carries to the renovation); one undo step.
- Plan details (Before): "6 walls look structural" [Mark them], one undo step; hidden at 0.

## Plan and 3D
Plan, PNG, print: structural and shelter walls get a dark charcoal fill, in Before and After; the hacked red hatch draws over it. `likely` walls look
normal. 3D and walk: no change.

## Renovation (After only; Before stays free for fixing the trace)
Checked on commit by comparing After with Before (`renovationDiff`), so every edit path
and AI layouts are covered.

| Wall in Before | Hack, move, thicken, cut down, glass, boundary | Opening added, moved, resized, restyled, removed | Paint, split in place |
|---|---|---|---|
| Shelter | Blocked: edit not applied | Blocked | Allowed |
| Structural / likely | Warn, keep, Undo in toast | Warn | Allowed |

Structural only warns: the marking may be wrong and people try ideas. HDB never allows
shelter changes.

Change list: lines touching a structural wall end "(structural)", with a banner on top; Copy
list includes both. An older renovation already changing a shelter wall shows "(household
shelter: HDB doesn't allow this)"; nothing is undone automatically.

## AI layouts
`lockedWalls` adds `structural` and `likely` walls; refusal reason "a structural, outside,
shelter or bathroom wall". Prompt and LayoutsDialog: "Outside walls, structural walls, the
household shelter and bathrooms stay as they are."

## Copy
- Blocked: "Household shelter walls can't be changed. HDB doesn't allow it."
- Warn: "That's a structural wall. HDB generally doesn't allow hacking it." [Undo]
- Banner: "N changes touch structural walls. Check with HDB before you plan on them."
- Footer: "Hacking any wall needs an HDB renovation permit, applied for by your
  HDB-registered contractor."

## Out of scope
Columns, beams; AI trace reading hatching; a 3D look; condo (MCST) rules; approvals.

## Acceptance criteria
Unit (core):
1. `wallStatus`: 300 mm unmarked → `likely`; marked `false` → `none`; beside "Household
   shelter" → `shelter` whatever the flag; boundary → `none`.
2. Sample flat: 300 mm and shelter walls `true`, the rest `false`; none `likely`.
3. In After, hacking, moving a corner of, thickening, glassing, cutting down or adding a door
   to a shelter wall is refused; painting or splitting it in place is allowed.
4. The same edits to a structural wall apply and return a warning.
5. `lockedWalls` has `structural` and `likely` walls, not `false` ones; `applyLayout` refuses
   removing one with the new reason.
6. `renovationChanges` marks and counts structural lines.
7. "Mark them" and the switch are one undo step each; the switch flipped in After shows in
   Before.

E2e (desktop, and 390 px phone by finger):
8. A drawn 300 mm wall shows the suggestion; "Yes" turns it charcoal in plan and PNG; Undo
   brings the suggestion back.
9. Sample, After: deleting a shelter wall shows the blocked toast, plan unchanged; dragging
   its corner snaps back.
10. Sample, After: deleting a structural wall shows the warning; the change list shows
    "(structural)" and the banner; Undo in the toast restores it.
11. Before: deleting a shelter wall works, no warning.
12. A wall marked No: no suggestion, no warning, AI may change it.
