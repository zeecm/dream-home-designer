# Spec: a bed with one side against the wall (issue #78)

Project-manager decision, 15 Nov 2026. Effort S. No schema change. Amends the bed rows of
[`clearance-checks.md`](clearance-checks.md) and the designer's bed access in
[`ai-designer-v2.md`](ai-designer-v2.md).

**Problem.** The same bed is judged two ways. A queen with one long side flush on a wall is a
red "Needs 0.60 m beside the bed; 0.00 m right" in the Clearance view, while the designer
passes it with "has one side to get in; the other is against the wall, fine in a small room".
In HDB common bedrooms (about 3 × 3 m) a bed on a wall is normal and often unavoidable. It only
costs comfort when two people share the bed, because one of them climbs over the other.

## The rule (one function in core, used by both views)
A bed is **red only when you can't get in from either side**. A bed with one good side gets
nothing or an amber note, depending on who sleeps in it.

| Bed | Sides | One sleeper | Two sleepers | Not known |
|---|---|---|---|---|
| Single, super single, bunk | one good side | nothing | (n/a) | nothing |
| Queen, king | both good | nothing | nothing | nothing |
| Queen, king | one good, other short | nothing | amber note | amber note |
| Any bed | both short | red, better side | red, better side | red, better side |

- **Good side:** the measure each view already uses (Clearance view: 0.60 m; designer: its
  hard 0.50 m, `ACCESS`). Those thresholds are unchanged here.
- **Sleepers for a bed:** the people said to sleep in its room, less the places on the room's
  other beds (`sleepsOf`). Two or more means shared.
  - Designer: from `sleepingPlan` (said or assumed: assumed puts a couple in the largest
    bedroom). A bedroom it leaves empty counts as not known.
  - Editor: from the project's designer brief only if it *says* who sleeps in that room (not
    assumed). Otherwise not known.
- A note is never a failure. It doesn't count in the plan's problem count, Show next, the
  drop announcement, the designer's hard checks, free fixes, fix rounds, `sameFailures`
  or "Fix every check first". It isn't drawn red on the plan.

## Words (amber unless marked red)
"Against the wall" only when the short side has under 0.05 m and a wall or the room's edge
stops it. Otherwise give the measure ("0.30 m on the right").
- Editor, not known: "One side to get in; 0.00 m right. Fine for one sleeper; for two,
  0.60 m each side is better."
- Editor, known couple: "One side to get in; 0.00 m right. One of you climbs over: 0.60 m
  each side is better."
- Designer, couple or not known (soft P4, card passes): "The queen bed has one side to get in;
  the other is against the wall, so one of you climbs over. 0.60 m each side is better if the
  room allows."
- One sleeper: no line in either view. The old "fine in a small room" line goes.
- Both sides short (red, unchanged voice, better side only): "Needs 0.60 m beside the bed;
  0.40 m left." / designer: "Not enough room to get into the queen bed: 0.50 m needed beside
  it, 0.40 m left."

**Couple's queen on a wall in the designer: soft, not P-level hard.** HDB common bedrooms
often can't avoid it, and the owner has already said the designer fails checks too often.
Instead the solver *prefers* both sides open for a shared double: a tie-break weight
next to the bed-side gap score in `solve.ts`, never at the cost of a hard check or a piece
left out.

## Out of scope
- The 0.50 to 0.60 m band (designer soft, Clearance view red): a separate follow-up.
- A house rule "both sides of our bed open" that makes it hard; resized or uploaded beds
  (the rule is by catalogue id); the bed's foot.

## Acceptance criteria
1. Single, super single or bunk flush on a wall, 0.70 m on the open side: no Clearance line
   ("Room to use it."), no designer line, plan count 0.
2. Queen flush on a wall, 0.70 m open, no brief: one amber Inspector line with the "not known"
   wording; not red, not drawn red, not counted, skipped by Show next, not announced on drop.
3. The same with a brief saying two adults sleep there: the "known couple" wording, amber.
4. The same with a brief saying one person sleeps there: no line.
5. Designer, assumed couple in the master with a queen on a wall: a soft P4 line with the
   designer wording; the card passes; no free fix or fix round starts for it.
6. Designer, one sleeper in a common bedroom with a queen on a wall: no line.
7. Queen 0.30 m off a wall (dead gap), 0.70 m open: the note gives "0.30 m on the right",
   not "against the wall".
8. Queen with 0.40 m left and 0.00 m right: one red line naming the better side (0.40 m
   left), in both views; the designer's check is hard.
9. Bunk bed: treated as one sleeper's bed (a ladder side is enough).
10. Two singles in a room with two sleepers: no couple note on either single.
11. Designer, couple's room big enough for both sides: the proposal leaves both sides at
    0.60 m or more (new regression case); in a 3 × 3 m room it may stay on the wall, soft.
12. Phone: the amber line reads in the Inspector sheet; amber text meets 4.5:1 in light and
    dark themes; the wording itself says it's a note (not colour alone).
13. Existing designer regression cases, `owner-*` fixtures and benchmark pass with no new
    hard failures; walkway checks to bed sides are unchanged.
