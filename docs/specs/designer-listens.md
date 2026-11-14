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
