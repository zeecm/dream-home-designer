# Spec: the designer listens (issue #66, part 2)

Owner bug, 9 Nov 2026: the AI interior designer "never listens". This is a quality fix for the
owner's top complaint, not a new feature. Part 1 (built separately, branch
`designer-keep-after-accept`) fixes pieces accepted from a version being dropped from every later
design. **Part 2 (this spec)** makes the run and the conversation behave like a competent designer:
it knows what failed and why, keeps fixing while it's getting somewhere, makes the free fixes itself,
doesn't let a room rename break the bed, and never charges again for the same failures without
saying so.

Builds on [ai-designer-v2.md](ai-designer-v2.md) ("When a check fails") and keeps every money rule
of [locked-phone-runs.md](locked-phone-runs.md): nothing is spent past the figure the person
approved, and money leaves only from a priced button.

## The user problem

A couple planning their 3-room HDB asked the designer to design the flat, then asked four times,
more angrily each time, for every check to be fixed before it came back. Each time they paid, and
each time the same checks failed and the bed was missing. The designer apologised, blamed "the
app", and said "I don't have the ability to run the checks before you see the results", which is
false: the app runs the checks before the card is shown and sends failures back to the model. A
person planning their own home can't tell whether a failure is the flat, the request or the
software. From their side the designer was ignoring them and charging for it.

## What the evidence shows

From the owner's export (36 turns, proposals V4 to V9, Gemini `gemini-3.1-pro-preview`, Thorough).
The issue's replay covers the hard failures. Reading the turns and usage shows four more causes:

1. **The talk model is told almost nothing about a run.** "Since your last reply" says only
   `"V6 (Main bedroom, and Living room): designed."`. "On the table" lists at most 6 failing check
   lines, and never the pieces left out or the reason (`“bed1”: there’s no piece “P7” in the
   flat`). Fix rounds that were tried, and how they ended, are never mentioned. So the model guessed
   ("it couldn't fit them … without blocking walkways"), and guessed wrong.
2. **The talk prompt plants the excuse.** `TALK_SYSTEM` says the app, "not you, says whether
   something passes", and rule 10 says never claim a check result. The model read this as "I can't
   check", and twice saved it as a note for the ID: "explained that the app handles the placement
   and checks directly, which cannot be hidden".
3. **Fix rounds silently did nothing.** 16 of the 37 design requests stopped at the 16k output limit
   after about 15.4k tokens of thinking. On Gemini 3 the "lower effort" retry is the same request
   (`high` → `medium` still sends `thinkingLevel: 'high'`), so it gets cut off again. In V6, V7 and
   V9 every room's one fix round was cut off twice, and the stored result is `fixes: 1, fixed: 0`.
   The card says nothing when `fixed` is 0, so the owner never learned that a fix was tried. About
   424k output tokens were spent on six proposals, most of them on thinking that produced no answer.
4. **The first proposal's wall changes put the couple's bedroom into a living space.** V4 removed
   W5, W8 and W10. The space holding `rm_main-bedroom` (where the brief puts both adults) came out
   named "Living & Study" with use `living`. Its queen bed then failed "doesn’t belong in Living &
   Study".
5. **(Adjacent, not in this spec.)** Neither `gemini-3.1-pro-preview` nor the default `gemini-3-pro`
   is in `PRICES` (only `gemini-2.5-*`). Every cost card had `estimate: null`, so the owner saw no
   figure and the "approved figure" had nothing to bind to. File it as its own bug: add Gemini 3
   prices, checked against Google's price page.

## How it should feel

Like a good designer after a site check: "The bed didn't fit with two desks: the room is 3.1 m
wide. I've kept the bed and one desk; the second desk goes in the living room." Facts and a
concrete change, no apology loop, no blame. The app speaks for itself in its own short lines (free),
so the person always knows what the app checked, what it fixed itself and what still blocks the
design, without paying for a chat reply to find out. When they ask for "no problems", the app
either brings back a design with no problems or says plainly why it can't and what to do next.

## Behaviour

### 1. The run report: what the model is told after a run

The app builds a **run report** for each version, deterministically, from its result and its fix
history. It holds:

- **F1, F2, …** each hard failure the version causes (not "already in your plan", not waived): the
  room, the piece's ref and P id, the app's own words.
- **L1, L2, …** each piece the answer asked for that the app left out: its ref, catalogue id, the
  reason in the app's words, and a **to-fix hint** chosen by the reason's code (table below).
- **Fix rounds:** for each room, how many were tried and how each ended: fixed n of m, no better
  (not used), cut off at the output limit (not used), or not tried because the run's fix-ups were
  used up.
- **Fixed by the app (free):** what the free fixes placed, moved or took out (§3).
- **Kept as it was:** renames, uses and wall changes the vetting refused (§4), with the reason.
- **Repeats:** "Same as V7: F1, F2 (twice running)" (§5).

Where it goes:

- **The talk call:** in the live facts of the last user message, as a block "## The last design, as
  the app checked it (data)" for the newest version of each scope since the last accept (at most 8
  F lines, 8 L lines). It goes in the live facts, not the history, so the history's cache bytes stay
  the same. The digest in "Since your last reply" becomes a verdict: `V6 (Main bedroom, and Living
  room): designed; 4 don’t pass, 3 pieces left out.`
- **Fix rounds:** the fix block lists this space's left-out pieces with their reasons and hints, not
  only the failing checks.
- **The person:** a short line from the app under the card (free, no request; copy below).

To-fix hints (the reason code says which; the numbers come from the solver where it has them):

| Reason | Hint to the model |
|---|---|
| keep ref not in the starting plan | P7 isn’t in the plan this design starts from. Place a new `bed-queen` with `keep: null`, or keep a piece listed in The flat now. |
| brief leaves it out / stays in place | The brief says this piece stays where it is (or goes). Don’t place it; place a new one if the room needs it. |
| no wall long enough | Needs 2.10 m of wall; the longest free run in R3 is 1.80 m. Use a smaller piece (`sofa-2`), another wall, or free-standing with 0.90 m behind. |
| no place / outside the room | It had no spot inside R2. Give it `against`, or put it in another room. |
| bathroom fittings, wet area, not in the catalogue | As the app says; pick from the catalogue. |
| doesn’t belong in the room's use | Beds go in rooms where someone sleeps: R2 (Adult 1, Adult 2). |

### 2. The talk prompt tells the truth about the app

`TALK_SYSTEM` is rewritten to describe how the app really works, and adds rules:

- How the app works (stated as fact): after a plan is approved, the app places the pieces, runs
  every check **before the person sees the design**, sends hard failures back to the designer to be
  fixed (as many rounds as the price allows), and places missing essentials itself where it can.
  You get its report in "The last design, as the app checked it".
- Never say you can't see, run or act on the checks. Never blame "the app" as a third party: you and
  the app are one designer. Don't apologise more than once in a conversation. Don't promise "no
  problems". Say what you will change.
- When the last design has F or L lines and they want it fixed: name each (up to 3) with the
  concrete change: the piece, the room, the size, the wall. When the same failure came back twice,
  change the approach (a smaller piece, one desk instead of two, another room, a different use), or
  say with the app's numbers that it can't be met here and offer one alternative.
- A plan reply after a failing design fills a new field, `plan.addresses`: the F/L ids it deals
  with, each with a one-line change. The app shows these under the plan's line and uses them in §5.
- Rule 10 stays in substance (never claim a result: the app shows it), reworded so it no longer
  reads as "I can't check".

A **claims filter** in `parseTalkReply` (free, deterministic) removes any sentence that contradicts
how the app works ("I can't/don't have the ability to run the checks", "the app removed it, not me",
"I can't fix them before you see them"). The same filter applies to memory notes, so such a note is
never saved. If nothing is left of `say`, the app shows its own run-report line instead.

### 3. Fix rounds keep going, and the app makes the free fixes itself

Per room, in this order: the model's answer → **free fixes** → checks → if fixable hard failures
remain and fix-ups are left: a **fix round** (the model, with the full report) → free fixes → checks
→ again. It stops at the first of these:

- every hard check passes;
- a round makes no progress (no fewer hard failures, or the same answer as before): that answer
  isn't used, and no more of the run's fix-ups go to this room;
- an answer doesn't come (cut off twice, unreadable): said in the report, not silent;
- the run's priced fix-ups are used up.

There is no fixed "twice per room" cap any more: while a room makes progress it may use the run's
fix-ups that are left. The run's total fix-ups are what the cost card priced (FIX_PER_RUN today; more
in "fix every check" mode, §6). Rooms share the fix-ups in turn, so one stubborn room can't take
them all from the others.

**Free fixes** (no request, deterministic, in core, on the answer as data so the version can be
rebuilt from what's stored):

- **Missing essentials (P1 must-haves):** a bed for each sleeper with no bed in their room (from who
  sleeps where: a queen for a couple; a super single for one adult; a single for a child or an
  elder), seats for the living room (3-seat sofa, then 2-seat, then armchairs), a dining table for
  the household (with the existing swaps), a desk and chair for each person working from home where
  the plan or brief has a study. Placed by the solver with the space's other pieces.
  A queen goes in only when both partners have no bed in the same room (both their checks fail
  there). A single adult without a bed gets a super single, even when their partner has one.
- **Orphans:** a dining chair with no table, a bedside with no bed: taken out, but only pieces this
  answer added, never the person's own or kept pieces.
- **Near misses** (issue item 4): a clearance short by 5 cm or less (0.89 m against 0.90 m) is fixed
  by moving the pieces involved up to 5 cm.
- A free fix is kept only if hard failures go down strictly, it adds no new hard check (HDB, house
  rules and locks included), and it leaves no kept piece or hand edit worse (`acceptResolve`'s rule).
  If it can't place a piece, the report says why, with numbers.

**Output-limit retries:** a step cut off at the output limit is sent again with **less thinking for
real** (on Gemini 3, `thinkingLevel: 'low'`; on others the existing lower effort). It is never sent
again as the same request. The tech lead decides whether fix rounds start at lower thinking.

**Money:** unchanged rules. Every fix round is counted in the approved figure before it's sent. A
run never goes past the figure: when it's reached, the run ends and the card offers **Keep fixing ·
at most US$x**, a new priced button. A run carried on after a locked phone keeps its fix-ups left
and each room's round history. With an **unpriced model** the limit is in requests: the cost card
names how many requests at most ("up to 9 requests"), and Keep fixing names how many more.

### 4. Room names and uses are vetted before the room steps

After the layout step (and for any plan that renames or re-uses a room), before any room is sent to
the model, free:

- A room where the brief has someone sleeping **keeps a sleeping use** (master, bedroom, kids,
  parents, guest). A new name is kept if it still reads as a bedroom ("Main bedroom & study");
  otherwise the room keeps its old name. Card line: "Main bedroom stays a bedroom: Adult 1 and Adult
  2 sleep there."
- A wall change that would join a room where someone sleeps to a living, dining or kitchen space (no
  door between them any more) is **refused**, with that reason. The rest of the layout stands. Two
  bedrooms joined into one bigger bedroom is fine (the owner's "bigger master bedroom").
- Layout room entries that land in the same space are merged to one name and use, the sleeping use
  winning, and the report says so.
- To really turn a bedroom into a study, who sleeps where changes first (an edit in What I know, or
  the designer's confirm). After that, the rename goes through.

### 5. No paying again for the same failures

- **Same failures**: the hard failures of two versions of the same scope, matched by principle,
  check code, room and the piece's role (not item ids, which are new each run). Already-in-plan and
  waived checks don't count.
- **On the card:** when the newest two versions of a scope have the same failures (the newer one may
  have more), the newest card opens with a **What's blocking this** block: each failure in plain
  words with its measured cause, and the ways forward that apply:
  - **Place the missing pieces · free** (the free fixes of §3, run on this version on request;
    useful when they weren't kept automatically, or the version came from a build before this one);
  - **Keep fixing · at most US$x**, only if a fix round could still help (not for "more people than
    bedrooms");
  - **Accept anyway**, only for checks that can be waived (never HDB rules);
  - **Change what I asked**, which focuses the composer.
- **Before a paid run:** if the last two versions of this scope repeated and nothing they depend on
  has changed (the brief, What I know, Decisions, house rules, kept pieces, who sleeps where, the
  starting plan, hand edits), and the designer's plan addresses none of the F/L lines or the same
  ones in the same way, the cost card **always asks**, even under the person's threshold. It says the
  run will likely fail the same way, and puts the free fix first. **Run it anyway** stays: the person
  decides, at the price shown.
- The free fix makes **no request**: it is a new version on the same card, marked "Placed by the app,
  no request", accepted like any other, with Undo.

### 6. "Fix every check before showing me"

- When the person asks for this ("fix them all before coming back", "make sure there are no
  problems", "check there are no outstanding items before returning"), the designer records it as a
  lasting fact, and What I know shows a row: **Before showing me a design: Fix every check first ·
  Show it as it is**. The person can set or change it there too. Changing it is free and has Undo.
  Default: Show it as it is (today's behaviour).
- **With it on:** fix rounds use every fix-up priced for the run, by progress (§3), and the cost
  card prices more of them (proposed: up to 6 fix-ups instead of 3; the tech lead sets the number),
  with the line "Keeps fixing until every check passes, up to 6 tries". The figure is still the
  limit.
- **It passes:** the normal card, with the fix line ("Checked and fixed 5 problems before showing
  you").
- **It doesn't:** the run never comes back as just "designed". The card opens with **Couldn't make
  everything pass**: each failure left, why in numbers where the app knows (the wall length, the
  piece's need) or "the designer's answers kept leaving it out (3 tries)", and the ways forward of
  §5. The app's line in the conversation says the same.

## Desktop and phone

- Desktop: the blocking block and the app's lines are in the conversation panel, at the top of the
  card, above the change list. The plan keeps showing the version, with the failing pieces marked as
  today.
- Phone (390 px, fingers only): the block is at the top of the card in the sheet. **Place the
  missing pieces · free** is reachable at peek height without scrolling past the change list. Pressing
  it folds the sheet to peek so the placed pieces are in sight on the plan (as a new proposal does
  today). Every button is at least 44 px.

## Copy

App lines (plain, concrete, no blame, no apology):

| Where | Copy |
|---|---|
| Card, fix rounds worked | Checked and fixed 3 problems before showing you. 2 still don’t pass. |
| Card, fix round cut off | Sent back to be fixed, but the answer was too long and was cut off, so it wasn’t used. 4 still don’t pass. |
| Card, no progress | Sent back to be fixed twice. The second answer was no better, so the first is shown. |
| Card, fix-ups used up | 2 still don’t pass. This design used the 3 fix-ups it was priced for. [Keep fixing · at most US$0.30] |
| Card, free fix | Placed by the app, no request: a queen bed in Main bedroom, against W12. |
| Card, free fix couldn't | No queen bed fits in Main bedroom with the 2.4 m wardrobe and two desks: the longest free wall is 1.4 m, and a queen bed needs 1.6 m. |
| Card, vetting | Main bedroom stays a bedroom: Adult 1 and Adult 2 sleep there. To make it a study, change who sleeps where. |
| Card, wall refused | Kept wall W5: taking it out would join Main bedroom, where Adult 1 and Adult 2 sleep, to the living room. |
| App line under a run | V8 is back. 4 don’t pass: Adult 1 and Adult 2 have no bed; the living room seats 0. The designer had 3 tries; each left out the bed. |
| Blocking block heading | The last 2 designs failed on the same 3 things |
| Blocking, a cause | Main bedroom is 3.1 m wide. A queen bed, a 2.4 m wardrobe and two desks need about 3.8 m. |
| Blocking buttons | [Place the missing pieces · free] [Keep fixing · at most US$0.40] [Accept anyway] [Change what I asked] |
| Cost card, repeat | This will likely come back with the same 3 problems: the last 2 designs did, and nothing they depend on has changed. [Place the missing pieces · free] [Run it anyway · at most US$0.60] |
| Strict, What I know | Before showing me a design: Fix every check first · Show it as it is |
| Strict, cost card | Keeps fixing until every check passes, up to 6 tries. |
| Strict, not met | Couldn’t make everything pass within US$0.60. 2 still don’t pass: … [Place the missing pieces · free] [Keep fixing · at most US$0.30] |
| Plan's addresses | For “Main bedroom has no bed”: a queen bed against W12, one 1.2 m desk instead of two. |
| Plan with no addresses after a failure | This plan doesn’t say how it fixes the 4 problems above. |

A designer reply of the kind the prompt asks for (an example for the prompt tests, not fixed copy):
"V8 left the bed out: the queen bed, the 2.4 m wardrobe and two desks don't fit Main bedroom's 3.1
m. I'll keep the bed and wardrobe and put one 1.2 m desk under the window. The second desk goes in
the living room by W3, and the 3-seat sofa goes back against W7."

## Edge cases

| Case | Behaviour |
|---|---|
| Failures that furnishing can't fix (more people than bedrooms, a bedroom with no window) | Not sent to fix rounds, and not counted for "Keep fixing". Shown as "can't be fixed by furnishing" with the way forward (who sleeps where). |
| Already in your plan | Not in F lines, repeats or strict mode. Listed separately as now. |
| Waived checks | Not failures. A waiver is a change for §5's "nothing changed". |
| House rules | Hard: free fixes and nudges never break one. Rule failures are F lines. |
| HDB rules | Never waivable. A free fix never touches walls. |
| Hand edits since the last version | Count as a change for §5. Free fixes never move a hand-edited or kept piece. |
| Alternatives A/B/C | Repeats compare the newest option of each scope. The free fix makes a new option on that card. |
| Stop during a fix round | What's done is kept. The report says "Stopped during fix round 2". |
| Locked phone, resumed | Fix-ups left and round history come from the checkpoint. The figure holds. |
| Quick quality | Fewer fix-ups priced. Strict mode on Quick prices its own number, shown. |
| Unpriced model | Limits in requests, named on the cost card and on Keep fixing. |
| The person asks for something that can't fit (a king bed in a 2.8 m room) | Existing pushback with the probe's numbers, before any run. In strict mode the designer says it won't pass. |
| The person rejects a free fix ("no bed there") | Untick it or Undo. Recorded as a Decision ("rejected: bed in Main bedroom"); the free fix doesn't offer it again for that room. |
| A build before this one made the version | Its card shows the block from its stored result. Place the missing pieces works on it. |

## Out of scope

- Part 1 (keep refs, an empty `brief.keep` meaning "replace everything").
- Changing check thresholds, or new checks.
- Solver margins in general (placing at 0.92 m). Only the ≤ 5 cm local nudge is in.
- A paid chat reply sent automatically after a run. The app's own lines are free and are enough.
- Gemini 3 prices (separate bug, adjacent finding 5).
- Cloud-run specifics beyond "the same rules hold on the server".

## Acceptance criteria

Provider calls are mocked (recorded or scripted streams); **no test calls a real provider.**
"Requests" means requests the mocked provider received. Each criterion says where it's checked: core
(Vitest), web unit, or e2e (Playwright, mocked provider, desktop 1280 and phone 390).

### PR A: the designer is told what happened, and tells the truth

1. *(core)* `runReport(result, history)` on a fixture version with 2 hard failures and 2 left-out
   pieces lists F1–F2 with room, P id and the app's text, and L1–L2 with ref, catalogue id, reason
   and the to-fix hint for that reason's code. A keep-ref drop gives the "isn't in the plan this
   design starts from … `keep: null`" hint.
2. *(core)* `talkPrompt` after that version: the last user message has "## The last design, as the
   app checked it (data)" with those lines. The history messages' bytes are identical to the same
   prompt built before the run (cache unchanged).
3. *(core)* The "Since your last reply" digest reads `V6 (…): designed; 2 don’t pass, 2 pieces left
   out.` for a failing version and `… designed; passes.` for a passing one.
4. *(core)* A fix round's prompt for a space lists that space's left-out pieces with reasons and
   hints, as well as the failing checks.
5. *(core)* `TALK_SYSTEM` no longer contains "not you, says whether something passes". It contains
   the how-the-app-works paragraph and the rules of §2 (snapshot test).
6. *(core)* The claims filter removes each of these sentences from `say` and from notes: the
   export's "I don't have the ability to run them in the background and fix them before you see the
   results", "the app itself places the items and runs the checks", "explained that the app handles
   the placement and checks directly, which cannot be hidden", plus 3 more variants. It keeps these:
   "The app's checks found 4 problems", "The app measured 0.85 m behind the sofa", "I'll move the
   desk to W3". A reply that is only a banned claim shows the app's run-report line.
7. *(core + web)* A plan reply with `addresses: [{id: "F1", change: "…"}]` shows "For “…”: …" under
   the plan line. A plan reply with failures on the table and no `addresses` shows "This plan
   doesn’t say how it fixes the 4 problems above."
8. *(web unit)* The card shows a fix line whenever `fixes > 0`: fixed n, still failing, cut off and no
   better each have their copy. Nothing is silent when `fixed` is 0.
9. *(ai)* A step whose stream ends at the output limit (Gemini `MAX_TOKENS`) is sent again with a
   different thinking setting (Gemini 3: `thinkingLevel: 'low'`). The second request body differs
   from the first. No third identical request is sent.
10. *(e2e)* After a mocked run with a left-out bed, the next talk request's intercepted body contains
    the F line "has no bed" and the drop reason. The mocked reply "I don't have the ability to run
    the checks. I'll add the bed." shows only "I'll add the bed."

### PR B: fix rounds that keep going, free fixes, vetting

11. *(core)* Free fix, beds: the export's Main bedroom answer with no bed (2 adults sleep there) →
    the version has a queen bed, P1 bed passes, and the report's "Fixed by the app" lists it. No
    request is made.
12. *(core)* Free fix, seats and dining: a living answer with no sofa and an orphan dining chair →
    a sofa that fits is placed, the orphan chair the answer added is taken out, and P1 seats passes.
    A chair that is a kept piece is never taken out.
13. *(core)* Free fix can't place: a 2.8 m-wide room with a 2.4 m wardrobe and two desks → no bed is
    placed, and the report says why with the free wall length and the bed's need.
14. *(core)* Free fixes are kept only if hard failures go down strictly, with no new hard key
    (including a house rule and an HDB rule fixture) and no kept piece or hand edit made worse.
15. *(core)* Near miss: the V2 fixture's 0.89 m walkway against 0.90 m passes after the nudge. A
    0.84 m one is not nudged and stays a failure.
16. *(ai)* Scripted provider, one room, 3 failures, each fix answer fixing one, 3 fix-ups priced: 3
    rounds run, and all pass. With a second round no better: the run stops, the remaining fix-up
    isn't spent (request count), and the first answer stands.
17. *(ai)* Two rooms, 3 fix-ups: rooms take fix-ups in turn. One stubborn room can't use all 3 while
    the other has a fixable failure.
18. *(ai)* No run sends more requests, or more estimated spend, than its approved figure. At the
    figure the run ends with Keep fixing offered (priced). An unpriced model is limited by the
    request count shown.
19. *(ai)* Locked phone: a run interrupted after fix round 1 of a room resumes with its fix-ups left
    and round history, and doesn't repeat round 1.
20. *(core)* Vetting: the export's V4 layout concept → no "doesn’t belong in Living & Study"
    failure. The wall change joining Main bedroom to the living space is refused, with the copy's
    reason. Main bedroom keeps a sleeping use. Joining Bedroom into Main bedroom ("bigger master")
    goes through.
21. *(core)* A rename of a room with sleepers to "Study" keeps the old name and use, with the line.
    After who sleeps where moves them, the same rename goes through.

### PR C: no paying twice, and "fix every check"

22. *(core)* `sameFailures(a, b)` matches across runs by principle, code, room and role (new item
    ids). It ignores already-in-plan and waived checks, and treats a superset as the same.
23. *(web/e2e)* Two versions of a scope with the same failures: the newer card opens with "The last
    2 designs failed on the same 3 things", a measured cause for each, and only the buttons that
    apply (no Accept anyway for an HDB rule, no Keep fixing for "more people than bedrooms").
24. *(e2e)* With that repeat and nothing changed, Go ahead on the next plan with no `addresses` →
    the cost card shows the repeat copy, **even with the per-reply threshold above its price**. The
    free fix is first. No request is sent until a button is pressed.
25. *(e2e)* Any change §5 lists (a fact edit, a hand edit, a house rule, a waiver, or `addresses`
    naming a new change) → no repeat warning.
26. *(e2e)* Place the missing pieces · free → no request (counter unchanged), a new version on the
    card marked "Placed by the app, no request", accepted with Undo as one step.
27. *(e2e)* A mocked reply setting the strict fact → What I know shows "Before showing me a design:
    Fix every check first". The next cost card shows "Keeps fixing until every check passes, up to 6
    tries" and a figure with 6 fix-ups. The person can turn it off there for free.
28. *(e2e)* Strict on, scripted answers that never fix the bed: the card opens with "Couldn’t make
    everything pass within US$x", a reason for each failure left and the ways forward. The app's line
    under it says the same. The card never shows only "designed".
29. *(e2e)* Strict on, scripted answers that fix everything by round 3: the normal card with "Checked
    and fixed 5 problems before showing you", and requests = rooms + 3.

### Regression: the owner's conversation, replayed

30. *(core, Vitest)* Fixture `owner-2026-11-09-never-listens` from the export (both levels, the
    brief, V4–V9's stored answers; no key, no prices). With parts 1 and 2: each of V6–V9's answers,
    run through the runner with the provider scripted to give the export's answers (fix rounds give
    the same answer again), comes back with a bed in Main bedroom and seats in the living room,
    placed from the kept pieces or by free fixes. Every hard failure left is in the report with a
    reason. No fix round is spent on an answer identical to the one before.
31. *(e2e, desktop and phone)* The owner's pattern, scripted:
    a. "Design the whole flat" with the layout mock renaming Main bedroom "Living & Study" and
       removing W5/W8/W10 → the vetting line shows, and there's no "doesn’t belong" failure.
    b. Accept all 27 changes.
    c. "Where is the bed? Also you should fix the problems." The room mocks leave the bed out → the
       bed is placed free, and the card's fix line shows.
    d. "Can you fix them all before coming back to me? Ensure that there are no problems." The talk
       mock sets strict and says "I don't have the ability to run the checks" → the strict row is in
       What I know, the banned sentence isn't shown, and the talk request carries F/L lines.
    e. The run's fix mocks repeat the same failing answer → the run stops at the first round with no
       progress. The card shows "Couldn’t make everything pass", with reasons and the free fix.
    f. "THERE ARE STILL 4 CHECKS THAT DON'T PASS". The plan mock repeats the same intent with no
       addresses → the repeat cost card, with the free fix first.
    g. Over the whole scenario: every request follows a priced press, and total requests ≤ the sum of
       what each approved card named. No reply text blames the app or claims it can't check.
32. *(e2e, phone 390, fingers only)* In 31e, the blocking block and "Place the missing pieces · free"
    are visible at peek without scrolling the change list. Pressing it folds the sheet so the new bed
    is in sight on the plan.

## Priorities and PR split

Part 1 first (it's the blocker; without it, nothing here can bring the bed back from an accepted
version). Then:

| PR | What | Value | Effort / risk |
|---|---|---|---|
| **A (P0)** | Run report to the talk call and fix rounds; truthful `TALK_SYSTEM`; claims filter; `plan.addresses`; the card's fix line; real lower-thinking retries | Stops the excuses and wrong guesses; the owner sees that the app tried; stops paying for cut-off answers | Small-medium. Prompt and talk-reply schema; may bump the conversation record. Can be built alongside part 1. |
| **B (P0)** | Fix rounds by progress, free fixes (essentials, orphans, ≤ 5 cm nudge), vetting renames and wall joins | The designs come back right more often, at no extra cost | Medium-large: core solver path and `run.ts`; benchmark layouts must stay the same where nothing fails |
| **C (P1)** | Repeat detection, What's blocking this, the repeat cost card, "Fix every check first", the replay e2e | No paying twice; the owner's literal request honoured | Medium: web card, cost card and What I know; record or brief field |

Ship A as soon as it's green: it changes the most for the least risk. B and C can then go in either
order; the replay criteria 30–32 land with C.

## Notes for the UX reviewer

- The app's own lines (fix line, run line, vetting, free fix) must read as the app speaking (the
  event style), not as the designer's message, and stay short: one line, then details on tap. Don't
  turn the card into a wall of red. The blocking block leads; the change list stays below.
- With an angry person, don't add apology or reassurance copy. Facts and a button are the respect.
- Where "Fix every check first" lives: What I know (lasting), shown on the cost card when on. Decide
  if the cost card also has a one-tap toggle. My lean: a line with "Change", not a toggle beside the
  money buttons.
- "Place the missing pieces · free" must never look like a paid button: no price skeleton, a
  distinct "free" mark. Check that it reads as free at a glance on the phone.
- Check the phone flow: block at peek, sheet folds to show the placed piece, and Undo is reachable.

## Notes for the tech lead

- `runReport` in core (pure), built from `DesignResult` plus the space's fix history. Store each
  space's round history on `SpaceDesign` (`rounds: { outcome: 'fixed' | 'no-better' | 'cut-off' |
  'no-fixups', before, after }[]`) and the free fixes made. That changes proposal or conversation
  records; bump their record versions. It isn't the project schema unless the brief's strict field
  lives there. If it does, it's a `SCHEMA_VERSION`/`SchemaVersion` bump with the fixture
  regenerated, and the API deploys first.
- Drop reasons need a **code** on `Note` (keep-missing, keep-brief, keep-in-place, no-wall,
  no-place, outside, wet, bathroom, not-catalogue, wrong-use) and the solver's numbers where it has
  them (`firstWhy` today is text).
- Free fixes edit the **answer** (extra intents, `by: 'app'`), so a version rebuilds from what's
  stored and the worker's `designResultKey` caching still works. They run inside the solver's
  budget; watch the PERF bounds for heavy living rooms.
- Progress-based rounds: replace `fixRoundsFor` per room with a run-level fix-up pool taken in turn,
  priced in `estimateRun`. Keep `fixesLeft` in the checkpoint as now. Strict mode raises the pool;
  the cost card shows it.
- Gemini 3: `thinkingLevel` only has low and high, so map the retry's lower effort to `low`. Look at
  whether room and fix steps should start lower: 15.4k of 16k output going to thinking is the real
  cost here.
- Repeat detection: a signature from normalised check keys (`P3|walkway|<itemId>|…` → role + room).
  "Nothing changed" is a hash of the inputs §5 lists, so compute it in core.
- The claims filter is a small list of patterns with tests; keep it narrow to avoid false positives
  (criterion 6 has both lists).
- The run report goes in the live facts block, not in `sent`, so the history's cache bytes don't
  change.

## Lead decisions (tech lead, 14 Nov 2026)

Checked against `main` at 1f859d4 (`packages/ai/src/run.ts`, `request.ts`, `stream.ts`,
`core/designer/{result,prices,prompts,schema}.ts`, `core/designer/talk/{prompt,reply,schema}.ts`,
web `talk/{turn,propose,pricing}.ts`), the part 1 WIP (`designer-keep-after-accept`), the #67 WIP
(`gemini3-prices`), the second look (`claude/designer-v2-slice3b-second-look`) and the owner's
export. Where these decisions differ from the text above, they win.

### Blockers (settle before building)

1. **The fix-up pool can already be overspent (confirmed, `run.ts:544-551`).** A room checks
   `fixesLeft > 0`, then awaits `mayStart`, then decrements. While a run is paused at a limit,
   every room that reaches its fix gate waits on the same `asking` promise. After one Carry on,
   each of them calls `reserve()` without checking `overLimit` again (`run.ts:326-327`), and each
   decrements. A scratch test (three rooms failing, `fixesLeft: 1`, a pause, then Carry on) sent
   **3** fix requests. Progress-based rounds make this more likely, so PR B must fix it first. Take
   the fix-up synchronously, before any await, and give it back if the gate refuses. After a pause,
   loop back through `overLimit(next)` before `reserve()`. Add the scratch scenario as a test.
2. **Pricing a shared pool.** `estimateRun` prices the dearest FIX_PER_RUN fix requests from
   `fixRoundsFor` copies per room. Once a room may take the whole pool, that under-prices it. The
   pool's price is **P × the dearest room's fix request**, `fixes = P`. The reservation for a fix
   round (`highOf('fix')`, `propose.ts:931`) is **that room's own** fix price (expose `fixOne` on
   `StepEstimate`), not the average. `FIX_EXTRA` (600 tokens) has to grow with the fix block: the
   L lines and hints are capped at 8 + 8 lines of at most 300 characters, so 600 becomes 2,100.
   With these, "keep going while progressing" can't pass the figure. Every round is still
   reserved at its most before it goes, and the pool is a hard request cap whatever the price.
3. **At the figure, keep today's pause and ask.** `confirmOver` and "Carry on · at most US$x" were
   reviewed under #62. Don't replace them with "the run ends and offers Keep fixing". **Keep
   fixing** is only for a run that ended with its pool used up and fixable failures left. It is a
   new run kind: fix rounds only, starting from the stored answers, priced as fix requests. It is a
   new option on the same card, built in PR C. It is not part of B.
4. **No paid retry caused by the filter.** If filtering empties `say`, the reply must still parse
   ok. Today, "no kind and nothing said" is treated as unreadable and sent again (paid). Run the
   filter after the ok/not-ok decision, and never let it turn a readable reply into an unusable
   one.
5. **The prompt must stay true in each PR.** A's `TALK_SYSTEM` may say only what A's build does:
   the checks run before the design is shown, and failures go back up to the priced number of fix
   rounds. "Places missing essentials itself" goes in with B1. "As many rounds as the price allows"
   goes in with B2.

### Decisions

**Where each piece goes, and the data that already exists**
- `DesignResult` already has `dropped` (`Note`, with `ref` and `space` but no code), `repaired`,
  `refused`, `checks` (`hard`, `already`, `unfixable`, `part`, `itemId`) and `refs`. Space entries
  have `fixes` and `fixed`. The runner's `failing()` (`run.ts:489`) sends **checks only**, and its
  fix block (`prompts.ts:266`) appears only when a check fails. So a bed left out for a keep ref
  shows up as "has no bed" with no reason. That is the loop seen in V6 to V9.
- `runReport` goes in core, in `designer/report.ts`. It is pure and is built from a
  `DesignResult` plus the space entries. Each F line carries a **failure signature**
  (principle|code|room|role, not item ids) that B's progress rule and C's repeats reuse. A version
  that isn't accepted has no P ids for its new pieces: name them by the answer's ref and catalogue
  id, and use P ids only for kept and plan pieces.
- Drop reasons: `Note.code` (the spec's list), plus `need` and `longest` numbers where the solver
  has them. They are set in `result.ts:resolveWant` and in `place.ts`'s `drop(...)`, which part 1
  also edits, so this lands after part 1. `Note` is computed, not stored: no record change.
- Talk call: **no second block.** The F and L lines replace the 6 "Doesn't pass" lines in "On the
  table" (`tableLines`, web `turn.ts:onTable`), capped at 8 + 8. They stay live facts, so the
  history bytes are unchanged. The "Since your last reply" verdict is frozen into `sent` at Send,
  which is safe for the cache.

**The excuse filter: the prompt does most of the work, the filter stays narrow**
- The root causes are the prompt's "it, not you", missing information, and one the spec missed.
  The task block asks for memory notes "for their ID about what the app can't do"
  (`prompt.ts:272`). That is exactly what the model saved twice, and the notes are re-sent every
  turn. Change it to "work the app doesn't cover (beams, plumbing, curtains, products)".
- `say` filter: **only first-person claims of not being able to check or fix** (I can't / don't
  have the ability to / am not able to … check, run, see or fix …). Criterion 6 changes. "The app
  itself places the items and runs the checks" and "The app removed the bed because it doesn't
  allow sleeping furniture in Living & Study" are *true* and must be **kept** (add both to the
  keep list). Blaming the app in the third person is a voice rule for the prompt, not something to
  filter.
- Notes: drop any note about the app, the checks or the client's mood (a false positive costs
  nothing). Also apply this when `factsBlock` is built, so the owner's two stored notes stop being
  re-sent. No record migration.
- The filter runs on the final parse and on salvaged stopped or cut-off replies. Streaming stays
  unfiltered: `partialTalk`'s invariant is "always a prefix of the final", and a sentence that
  vanishes at the end is rare once the prompt is fixed.

**Free fixes: a post-pass on the answer, not inside the solver**
- `designer/free.ts` (core, pure): from the **failing P1 must-have checks only** (never straight
  from the brief, so it never invents a requirement the checks don't have), it adds intents to the
  answer and re-runs `designResult`. The solver then re-solves the space with its usual budgets,
  and the result is kept by `acceptResolve` with signatures: strictly fewer hard failures, no new
  hard signature (R, K and HDB included) and `piecesNoWorse`. At most 2 tries a room a round (all
  missing essentials together, then beds alone). In the web it is a worker ask, passed to
  `runDesign` like `results`. On a server it calls core directly.
- `solveSpace` and `designResult` don't change, so **benchmark layouts are unchanged by
  construction** and the PERF bounds hold. Add a PERF-gated test: a free fix on the heavy living
  room in at most 2× the first solve's bound. Add benchmark cases for free fixes.
- Stored as data: app items are ordinary answer items with a reserved ref prefix `app:`.
  `parseSpaceDesign` renames any model ref with that prefix, so the model can't pose as the app.
  The card's "Placed by the app" lines come from the prefix. No schema field, and a stale tab
  keeps them.
- **Out of B:** orphan removal and the 5 cm nudge. Orphans fail no hard check, so taking them out
  can never meet the "strictly fewer" rule. The model often uses a dining chair as a desk chair.
  Placing the missing table is the real fix. The nudge would have to go in `designResult`, which
  changes layouts, and walkways are measured on a 5 cm raster (`walkway.ts` CELL), so a 5 cm move
  is within measurement noise. File it as a follow-up with a PERF and benchmark diff. Criterion 15
  moves there. Criterion 12 drops the orphan chair.

**Vetting: the runner rewrites the concept as data**
- `vetConcept(concept, startLevel, brief, aliases)` in core (`designer/vet.ts`, with tests) runs
  after `parseConcept` and before the room steps. It reverts renames and uses of rooms where
  someone sleeps. Where entries land in one space, it merges them, sleeping use first. It refuses
  `remove_wall` ops whose result puts a room where someone sleeps in the same space as a living,
  dining or kitchen room: newest first, until none does. It is bounded by LIMITS.ops and is cheap
  (walls and spaces only). Two bedrooms joining is allowed.
- Not in `designResult`: that would change old and accepted versions (their change ids, and Put it
  back). The vetting lines are cosmetic, so they go in an optional `appLines` on the option, read
  tolerantly.
- Criterion 20 uses the export's V4 concept exactly, and its `add_wall` ops at x = 4.5 stay.
  Check that the walls left don't make a room with no door.

**Fix rounds by progress (B2)**
- Pool P: Thorough 3 (strict 6). Quick min(3, rooms) (strict min(4, 2 × rooms)). The second
  look's round draws from the same pool, last.
- Turns: in the first pass, each room may take up to max(1, ⌊P / rooms⌋). After every room's first
  pass, rooms that are still progressing take what's left one at a time, in room order (2 at a
  time). That is deterministic for criterion 17.
- Progress means strictly fewer hard failures and no new signature. The count of fixable checks
  alone, as today (`run.ts:586`), can swap one failure for another. If the answer is the same as
  before after the merge (`stableJson`), the room has stalled.
- Checkpoint: the room's answer is saved with status `done` after its first answer and after each
  round (today `save()` runs only when the room ends, so a resume runs the room step again).
  Per-room `rounds`, a stalled flag and the pass go on `RunCheckpoint`, and `fixesLeft` is written
  when a fix-up is taken. An older build must never carry such a run on: **proposal record bump**.
- The fix prompt says "move, turn, swap or **drop** the pieces named" (`prompts.ts:275`). Make it
  "never drop a bed, seat, table or desk the room needs; drop something else".
- Unpriced models: #67 WIP says the designer won't run on an unpriced model. If that holds, delete
  the spec's unpriced branches. If not, "up to N requests" must count retries, or say "steps".

**Output limit (#67 owns it, not A)**
- Confirmed in `stream.ts:213`: on Gemini 3, both `high` and `medium` send `thinkingLevel:
  'high'`. That includes **every Quick run**, and the talk call (effort `medium`, 4,000 tokens).
  #67 maps effort per model (low and high on 3.x Pro; Flash also has medium) and sends the length
  retry at `low`.
- My call on starting lower: **fix rounds on Gemini 3 start at `low`**. In V6 to V9, every fix
  round was cut off at about 15.36k thinking tokens, so nothing is lost. Room steps stay `high`.
  Claude and OpenAI stay as they are (no evidence). `maxTokens` and the figure are unchanged.
- Retries aren't in the estimate. Once #67's prices bind, a cut-off step's retry uses up room in
  the figure and brings the pause sooner. Accept that for now, and look at the pause rate after
  #67 lands.

**Records and versions** (no project schema change, no `SCHEMA_VERSION` bump, no API deploy: talk
and proposal records live in the browser's `dhd-talk`)
- A: **no bump.** `rounds` on the space entry and `plan.addresses` are optional and read tolerantly
  (`.catch(undefined)`), as the precedent of `owns` within v3 allows. If a stale tab drops them,
  only the fix line's detail is lost, and repeats err towards asking.
- B2: **proposal record bump** (checkpoint money fields). It takes **v5** if the second look (v4)
  has merged. Otherwise whichever lands second takes the next number.
- C: **talk record v5.** The strict setting (`DesignBrief.fixAll`, kept out of `briefData` so room
  prefixes stay cached) must not be lost silently by a stale tab: that is the owner's complaint
  again. A structured `declined: {room, role}[]` for rejected free fixes goes there too, because
  Decision text can't be read reliably. The free-fix option's marker joins B2's proposal bump if C
  follows soon after; otherwise it is v6.
- §5 "the plan addresses them in the same way": compare the set of F and L ids only, not the text.

### Should-fix in the spec

- Criterion 6: move the two true third-person sentences to the keep list (above).
- Criteria 9 and 16 to 19: 9 goes to #67. Add the pause and Carry on race (blocker 1) to 18.
- Criteria 12 and 15: orphans and the nudge are out (above).
- "Card, no progress" copy: today the loop breaks after the first no-better round, so "Sent back to
  be fixed twice" needs two rounds. Word it from the stored `rounds`.
- "Fixed n" comes from the rounds (the room tried alone) and "still don't pass" from the card's
  verdict (the whole version): name them so, or the numbers won't add up.
- The repeat cost card can only add asks, never remove one. Say so in §5.

### PR order

1. **Part 1** (`designer-keep-after-accept`: result, place and solve). Nothing brings the bed back
   without it.
2. **#67** (Gemini 3 prices, per-model thinking map, a real low retry, fix rounds at low on
   Gemini 3). B prices the pool on it.
3. **A** (report, Note codes, prompt, notes and the narrow filter, `addresses`, fix line). It can
   be built alongside 1 and 2, but rebase it on part 1 for `Note.code`.
4. **Second look** whenever it's ready. It must first rebase on #65 (its branch still has the run
   code in web), and it takes proposal v4.
5. **B1** (vetting and free essentials): core and runner, no money change.
6. **B2** (pool by progress, the race fix, checkpoint, pricing): proposal bump. Tech-lead review
   of the money diff.
7. **C** (repeats, the What's blocking this block, the repeat cost card, strict, Keep fixing as a
   fix-only run, replay criteria 30 to 32): talk v5.

## UX design

Designed against the running app (production build, Go API, mocked provider: a Main bedroom answer
with no bed, then the export's "I don't have the ability…" plan reply). Screenshots of today's cards:
`d1440-03-card.png`, `d1440-05-after-send.png`, `p390-03-card.png`, `p390-03c-sheet-next.png`,
`p390-05-after-send.png`, `l844-03-card.png`, `d1280-08-log-dark.png` in the session scratchpad
(`…/scratchpad/shots/`).

What today's build shows, and what this design answers:

- The card says **"Checks: 2 don't pass"** and lists **neither** failure. The count comes from the
  whole result (`fails.open`) and the list only from the ticked-subset report's pieces with no row,
  so a missing bed (no piece, so no row) is counted and never named. This bug alone produces "where
  is the bed?". Fix it in PR A whatever else ships: **one list makes the count, the lead, the On the
  table bar and the announcement.**
- A fix round ran (two `furnish "Main bedroom"` requests) and the card says nothing.
- After a run the log scrolls to its foot, which is the "Where next?" scope offer. On a 1440 × 900
  screen the card's head and checks are above the fold of the log. On a phone at peek, only the
  **On the table** bar is visible (`p390-03-card.png`): no part of the card fits at peek.
- The reply's banned sentences show in full, and the cost card shows the plan's title with nothing
  about what it fixes.

### Principles

1. **Three voices, as today.** You: a bubble. The designer: plain text under "Designer". The app:
   the event line (a 14 px mark, then grey 13 px text, `.talk-app-line`). Everything this spec adds
   for the person is the app's voice. It's free, it's facts, and it never says sorry. The designer's
   text is never restyled to look like the app.
2. **One list, one count.** The run report's F and L lines are the only source for the card's lead,
   the Checks row, the On the table bar, the folded card line, the announcement and the cost card's
   repeat line. If two of them disagree, that's a bug.
3. **Escalate only when it repeats.** A first failure gets a short lead. The framed **What's blocking
   this** block appears only when the same failures come back (or strict mode couldn't make them
   pass). So the card doesn't nag the first time and doesn't hide anything the second time.
4. **A button only if pressing it changes something.** The free fix is offered only when a dry run
   (in the results worker, free) would place or take out at least one piece. Keep fixing is offered
   only when the run stopped because it ran out of fix-ups or reached its figure, not when the last
   round made no progress (paying again would likely give the same result).
5. **Free reads as free.** Every spend button already ends "· about US$x". The free one ends
   "· free" in the same place, has no `data-spends`, never shows a price skeleton, and is never the
   near-black primary. Grammar does the work at a glance. No second colour is needed.
6. **The person's words, not the solver's.** App lines use the change list's vocabulary ("against
   the wall opposite the window", "the wall between Main bedroom and the living room") and the
   household's names as What I know says them ("You and Partner"). Never `W12`, `P7` or "Adult 1"
   in anything the person reads. Those ids are for the model.

### The card after a run: order

Top to bottom (new parts in **bold**):

1. Head: `V8 · Main bedroom` · Show on plan (unchanged).
2. A / B / C tabs (unchanged).
3. **The lead**: how this version was checked (below). It sits *above* the designer's summary,
   because "did it work?" comes before "what is it?".
4. The designer's summary, then "Your words: “…”" (unchanged).
5. **What this design set out to fix** (only when the plan had `addresses`), below.
6. Changes (unchanged). Rows the app placed itself carry a grey **By the app** tag, the way kept
   pieces carry **Kept**.
7. The `Checks` row now holds the count and "Already in your plan: n" only. The failure lines move
   up into the lead, so they aren't shown twice. When the lead lists them, the row reads
   `3 don't pass · listed above`.
8. Electrical, Storage, Cost, the pointing tip, Accept selected, foot (unchanged).

### The lead: four states, one component

`<section aria-labelledby="lead-{card}">` with no fill and no border in states A and B, so it reads
as part of the card. States C and D take the existing `.talk-stopped`/`.talk-confirm` frame: a 1px
`--border`, radius 8, 12px padding, white (or `--surface` in dark). No red or amber fill anywhere:
red goes only on the warn mark and the count. At most **3 failure lines** show, then "and 2 more"
as a disclosure. At most **2 lines of "what the app did"** show, the rest under "How it was
checked".

**A. Passes.**

```
✓ Checked and fixed 3 problems before showing you.
✓ Placed by the app, free: a queen bed in Main bedroom, against the wall opposite the window.
```

When there were no fix rounds and no free fixes, there's no lead at all (today's card).

**B. Doesn't pass, first time** (no repeat, strict off).

```
Checked and fixed 1 problem before showing you. 2 still don't pass:          ← 14/600, ink
 ⚠ You and Partner have no bed                                                ← 14/400 ink
   No queen bed fits with the 2.4 m wardrobe and two desks: the longest
   free wall is 1.4 m, and a queen bed needs 1.6 m.                           ← 13 grey (--muted)
 ⚠ The living room seats 0
   The designer's answers left the sofa out (2 tries).
✓ Main bedroom stays a bedroom: You and Partner sleep there. Who sleeps where ›
  How it was checked ›                                                        ← disclosure
[Place a sofa · free]                                                         ← only if the dry run places one
```

- The headline line joins the fix-round outcome and the count, using the copy table's wording.
  "Fixed 3" counts from the rounds (the room tried alone). "Still don't pass" is the card's verdict
  for the whole version, from the one list. They're two facts, so they're two sentences, and the
  numbers never have to add up to anything.
  Without fix rounds it's just `2 don't pass:`.
- Each failure is the app's check text as the main line, with its **measured cause** as the grey
  subline (from the reason code and the solver's numbers). With no measured cause, it's the
  try count ("The designer's answers left it out (3 tries)"). With neither, there's no subline.
- **Can't be fixed by furnishing** (more people than bedrooms, no window): subline "Can't be fixed
  by furnishing: 3 people sleep here and there are 2 bedrooms." plus a `Who sleeps where ›` link
  (What I know at that row, the existing `knowAt` pattern).
- **How it was checked ›** opens a list per room: `Main bedroom · fix round 1: 3 → 1 problem ·
  fix round 2: cut off at the length limit, not used`, the free fixes made and not made, the
  vetting lines. This is where multi-room detail goes, so the headline stays one line.

**C. What's blocking this** (the newest two versions of this scope have the same failures).

```
┌──────────────────────────────────────────────────────────────┐
│ V7 and V8 failed on the same 3 things                        │ ← 14/600, the section's name
│  ⚠ You and Partner have no bed                               │
│    Main bedroom is 3.1 m wide. A queen bed, a 2.4 m wardrobe │
│    and two desks need about 3.8 m.                           │
│  ⚠ The living room seats 0                                   │
│    The designer's answers left the sofa out (3 tries).       │
│  ⚠ A dining chair has no table                               │
│                                                              │
│ [Place a queen bed and a sofa · free]                        │
│ [Keep fixing · at most US$0.40]          ← only per principle 4
│  Change what I asked                     ← text button, focuses the composer
└──────────────────────────────────────────────────────────────┘
```

- The heading names the versions ("V7 and V8", or "V6 to V8" for three in a row) so the person can
  look back. "The last 2 designs" makes them count.
- The ways forward are stacked and content-width (as the scope buttons are), each 44 px on a coarse
  pointer. Order: free, then paid, then the text button.
- **No "Accept anyway" button in the block.** Accept selected, just below, already asks "Accept
  anyway? 2 problems: …" (and refuses HDB rules). A second route to the same waiver would split one
  decision across two places. The block's text says nothing about waiving. The card's own flow does.
- **Change what I asked** focuses the composer. The placeholder becomes "Say what to change, e.g.
  one desk instead of two". On a phone the composer's focus already folds the sheet to peek with
  the keyboard.

**D. Couldn't make everything pass** (strict on, failures left). This is the same frame as C, with
this heading:

```
Couldn't make everything pass within US$0.60
2 still don't pass:
 ⚠ …
Same failures as V7.                                    ← only if it's also a repeat
[Place a queen bed · free]   [Keep fixing · at most US$0.30]   Change what I asked
```

Precedence: D, then C, then B, then A. One state per card, never two frames.

### The free fixes: shown and undone

**Made during a run (automatic).**

- One line per kind in the lead: "Placed by the app, free: a queen bed in Main bedroom, against the
  wall opposite the window." Lines past two go under "How it was checked". (The lead decisions take
  orphans and the 5 cm nudge out of B. If they come back, they use the same line: "Took out a dining
  chair the answer added, with no table to go with it.")
- The pieces are rows in Changes, tagged **By the app**, ticked by default like any row, with the
  reason one tap away ("A bed for You and Partner: nobody had one."). To leave one out, untick it.
  Once accepted, the accept line's **Undo** takes everything back in one step (as today).
- Left out at Accept: recorded as a Decision "Left out: the app's queen bed in Main bedroom" (the
  existing "what you leave out is kept" rule), and the free fix doesn't offer it again for that
  room. It's recorded **at Accept**, not on untick, so a person trying ticks out records nothing.
- Couldn't place: a warn line in the lead with the numbers (copy table). There is no button, because
  nothing can be pressed to make it fit.

**Asked for (Place … · free).**

- It runs in the results worker. The button shows "Placing…" and is disabled. There's no skeleton,
  no spinner and no price.
- **It adds rows to the same card**, tagged **By the app**, and the lead and checks are worked out
  again. It does **not** make a new A/B/C option. Tabs mean "another idea" to the person, and a free
  correction isn't another idea. The stored answer still gains the `by: 'app'` intents, as the
  automatic fixes do, so the version rebuilds from what's stored.
- An app line goes into the log, because it's the person's action, like "You accepted…":
  `✓ Placed by the app, free: a queen bed in Main bedroom, against the wall opposite the window.
  Undo`. Undo takes those intents out again. It's offered while this is the newest such action (the
  "kept" line's rule).
- The block re-renders. If everything now passes, it drops to state A. If not, it shows what's
  left, with the free button gone (principle 4).
- On a phone the sheet folds to peek and the plan zooms to the room (the existing `scopeBox`), with
  the bed marked **New**.

**Fitting with the lead decisions.** The "By the app" tag comes from the `app:` ref prefix, and the
vetting lines come from the option's `appLines`. **Keep fixing** is a fix-only run that makes a new
option. That's right for it: it's paid design work, so its tab reads "B · kept fixing" and is
compared like any option. The *free* fix should still be rows on the same card, as above. If
storage keeps it as an option, then its tab reads "B · by the app, free", the log line's Undo
removes that option and shows A again, and the lead of B says what it added. Either way, the person
must never see a free correction offered as "another idea".

### Repeats explained, without nagging

- **On the card:** state C appears only on the **newest** card of the scope. Older cards fold to
  their line as now (`V7 · Main bedroom · 3 don't pass`).
- **Before a paid run:** the repeat cost card (below) asks only under the spec's conditions (same
  failures, nothing changed, plan addresses nothing new). The long sentence shows **once per failure
  signature**. If the person presses Run it anyway and the same thing comes back, the next repeat
  card is one line: "Likely the same 3 problems again (V7 to V9)." It still asks (that's the money
  rule) but doesn't lecture.
- It never stacks with "This plan doesn't say how it fixes…". The repeat sentence replaces it.
- Nothing about repeats is said in a toast, in the designer's voice, or in more than one place on
  screen at once.

### Before a run, during it, after it

| When | What's shown | Where |
|---|---|---|
| Before (plan reply) | The plan's title; **For “…”: …** lines from `addresses` (up to 3, then "and 1 more"), or "This plan doesn't say how it fixes V8's 4 problems."; the strict line when on; the repeat line when it applies; the price | The cost card, or the plan's line when no cost card is needed |
| During | Each room's progress line, now with its round: `Main bedroom · fixing 2 problems (round 2)`; `… · the answer was cut off; trying again with less thinking`; `… · placing a bed itself` | The running card (`.talk-progress`) |
| After | The lead (A to D); **What this design set out to fix** | The card |
| After, persistent | `On the table: V8 · 3 don't pass` | The bar (as now, but counted from the one list) |

**What this design set out to fix** closes the loop for the owner's turn 31 ("Did you fulfil my
request?"). For each `addresses` entry, it shows the promise and the outcome, from the same list:

```
What this design set out to fix
 ✓ You and Partner have no bed: a queen bed against the long wall
 ⚠ The living room seats 0: a 2-seat sofa by the window. Still doesn't pass
```

It's 13 px, with no frame and under the summary. It isn't shown when there were no addresses.

### The cost cards

**Repeat** (asks even under the threshold):

```
“Restore the queen bed” (Main bedroom)
This will likely come back with the same 3 problems: V7 and V8 did, and nothing they depend on
has changed.
  You and Partner have no bed · The living room seats 0 · A dining chair has no table
[Place a queen bed and a sofa · free]
[Run it anyway · about US$0.13]   Not now
(at most US$1.08, up to 3 fix-ups included)
```

- The free fix comes first and is listed above the paid button. Run it anyway is an outlined button,
  not the near-black primary, because nothing on this card should pull toward spending.
- The failures are named in one line because the card they come from may be far up the log.
- With no free fix available, the card shows "Change what I asked" (text button) in that slot.
- Its first sentence gets focus (`tabindex="-1"`), as CostCheck focuses its heading. Focus never
  lands on a spend button.

**Strict on** (any cost card):

```
… takes about US$0.21 (at most US$1.62, up to 6 fix-ups included). Go ahead?
Fix every check first is on: keeps fixing until every check passes, up to 6 fix-ups
(adds up to US$0.54 at most). Change
```

"Change" opens What I know at that row. It's a line, not a toggle beside the money buttons (agreeing
with the spec's lean): a toggle there would change the figure under the finger about to press it.

**Plan with addresses**: up to 3 "For “…”: …" lines, 13 px, under the plan's title in the cost card.

### "Fix every check first" in What I know

- Row label **Before you see a design** (What I know speaks to the person: "Who lives here", "How
  much you own"). Value: **Fix every check first** or **Show it as it is**. `Change` opens the
  existing two-option chooser. It saves free.
- The log line after a change (the existing fact line, plus Undo while it's the newest):
  `✎ You changed: before you see a design Show it as it is → Fix every check first. Undo`
- Set by the designer from a reply: the existing "noted" line under the reply, `✓ Noted in What I
  know: fix every check before you see a design. Edit`. That's the same pattern as other facts the
  reply records.

### Desktop and phone

**Desktop (1280 to 1440).** The panel is about 420 px wide. When a run ends and the card is taller
than the log, the log scrolls the **card's head** into view, not the foot, so the lead is the first
thing read. The bar's `Accept…` already jumps to Accept selected. The failing pieces stay marked on
the plan as now. Hovering a failure line lights its piece (or its room, for a missing piece), the
way hovering a change row does.

**Phone, portrait (390 × 844).** At peek, only the **On the table** bar fits. The spec's "block at
peek" can't hold, so the bar carries it:

```
V8 · 3 don't pass                [Place a bed · free]
```

- When the newest card offers a free fix, the bar drops "On the table:" and its button becomes the
  free fix, with a short label: "Place a bed · free", "Place 2 pieces · free". Otherwise the button
  is `Accept…` as now. Pressing it does the free fix in place. The sheet is already at peek, the plan
  zooms to the room, and the bar then reads `V8 · passes [Accept…]` (or what's left).
- At half or full height, the lead is at the top of the visible log (the head-into-view rule above),
  so **Undo** on the free fix's line is one drag up.
- All new buttons and text buttons are at least 44 px. The stacked ways forward are content-width,
  not full-width bars.

**Phone, landscape (844 × 390).** The side column: the same card, with the head-into-view rule. The
bar's free button works the same way there.

**Dark mode.** No new colours. The marks use `--pill-warning-ink` (warn) and `--positive` (check),
and text uses the existing tiers. The frame in C and D is the dark `--border` on `--surface`.

### Accessibility

- **One announcement per run end**, through the existing polite region (`say`), from the one list:
  "V8 is ready. 3 don't pass: You and Partner have no bed, and 2 more. Cost US$0.31." Strict and not
  met: "V8 is back. Couldn't make everything pass: 2 still don't pass." Passing: "V8 is ready.
  Passes all checks; the app fixed 3 problems first." The lead itself is **not** a live region, so
  nothing is read twice.
- **Focus isn't moved at run end** (the person may be typing). The bar's button is the next Tab
  stop from the log's top.
- **The free fix:** "Placed a queen bed in Main bedroom. 1 still doesn't pass. Undo is available."
  is announced, and focus goes to the new log line's Undo (as Accept selected does today). On a
  phone at peek, where the log is hidden, focus goes to the bar's button instead.
- **Structure:** the lead is a `section` named by its headline. Failures are a `ul`. Each failure
  hovered or focused lights its piece. Disclosures use `details`/`summary` (as "Already in your
  plan" does).
- Red is never the only signal: the warn mark and the words "don't pass" both carry it. The text
  tiers already pass AA.
- **Motion:** nothing animates in. The sheet's fold uses its existing transition, which is instant
  under `prefers-reduced-motion`.
- Spend buttons are never focused automatically (the existing rule). The free button is ordinary.

### Copy (replaces or refines the table above)

| Where | Copy |
|---|---|
| Fixed all | Checked and fixed 3 problems before showing you. |
| Fixed some | Checked and fixed 3 problems before showing you. 2 still don't pass: |
| Cut off | Sent back to be fixed, but the answer was cut off at the length limit and wasn't used. 4 still don't pass: |
| No better | Sent back to be fixed 2 times. The last answer was no better, so the earlier one is shown. |
| Fix-ups used up | 2 still don't pass. This design used the 3 fix-ups it was priced for. [Keep fixing · at most US$0.30] |
| Unpriced model | [Keep fixing · up to 3 more requests] |
| Free fix | Placed by the app, free: a queen bed in Main bedroom, against the wall opposite the window. |
| Free fix couldn't | No queen bed fits in Main bedroom with the 2.4 m wardrobe and two desks: the longest free wall is 1.4 m, and a queen bed needs 1.6 m. |
| Vetting | Main bedroom stays a bedroom: You and Partner sleep there. To make it a study, change who sleeps where. |
| Wall kept | Kept the wall between Main bedroom and the living room: taking it out would join the room You and Partner sleep in to the living room. |
| Can't be furnished | Can't be fixed by furnishing: 3 people sleep here and there are 2 bedrooms. Who sleeps where › |
| Blocking heading | V7 and V8 failed on the same 3 things |
| Strict not met | Couldn't make everything pass within US$0.60 |
| Free button | Place a queen bed · free / Place 3 missing pieces · free (bar: Place a bed · free) |
| Repeat cost card | This will likely come back with the same 3 problems: V7 and V8 did, and nothing they depend on has changed. [Place … · free] [Run it anyway · about US$0.13] Not now |
| Repeat, again | Likely the same 3 problems again (V7 to V9). |
| Strict on cost card | Fix every check first is on: keeps fixing until every check passes, up to 6 fix-ups (adds up to US$0.54 at most). Change |
| What I know | Before you see a design: Fix every check first · Show it as it is |
| Plan addresses | For “You and Partner have no bed”: a queen bed against the long wall, one 1.2 m desk instead of two. |
| No addresses | This plan doesn't say how it fixes V8's 4 problems. |
| Reply emptied by the filter | (the app's line in place of the reply) V8: 3 don't pass. You and Partner have no bed, and 2 more. |
| Announcement | V8 is ready. 3 don't pass: You and Partner have no bed, and 2 more. Cost US$0.31. |
