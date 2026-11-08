# Spec: AI interior designer v2 (a designer you talk to)

Owner request (7 Nov 2026), verbatim: "I would like it to be more of an interactive interior
designer, like a real person you can talk to, give your ideas and comments and concerns, so that
you can iterate on the design." Testing v1, the owner got a design that **missed beds, put a sofa
facing the wall and choked the hallway with a table.** Added concern: those are only the faults
they happened to hit; they don't want to come back each time a new one shows up, so quality must
not rest on a growing list of hand-written rules.

Project-manager, 7 Nov 2026. Builds on [ai-interior-designer.md](ai-interior-designer.md) (v1:
brief, versions, compare, accept in parts, hand-edit locks, spend limit, BYO key),
[clearance-checks.md](clearance-checks.md), [plan-comments.md](plan-comments.md),
[storage-meter.md](storage-meter.md), [ageing-parents.md](ageing-parents.md),
[structural-walls.md](structural-walls.md), [exact-render.md](exact-render.md).

**Architecture is the tech lead's** (model chooses intent, a solver does the geometry, tool use,
self-check against the app's checks). This spec says what the person sees and what must be true.
Where it names a mechanism ("the app checks", "the solver places") it means *deterministic code in
core*, not the model.

**Effort:** slice 1 M–L, slice 2 L, slice 3 M, slice 4 M (server). **Schema:** none for slices
1–3; slice 4 adds a server resource, not a project schema change (see [Storage](#storage-and-schema)).

## Problem

1. **Quality.** v1 lets the model place furniture and only repairs clashes. Nothing says a bedroom
   needs a bed, a sofa must face into the room, or a hallway must stay clear; problems are listed
   as advice under a design that still looks finished. People trust a finished-looking plan.
2. **One-shot.** v1 is a form, a long run, and a "Change something" box. A real designer asks
   questions first, shows one idea, hears "I don't like the sofa there", explains why, offers
   another, and remembers what was decided. HDB owners plan with their family over weeks, in
   pieces, on their phone.
3. **Whack-a-mole.** Each fault fixed one by one leaves the next one to be found by the owner.

## Principles (how it should feel)

- Like a patient designer at the first site visit: looks at your plan, asks who lives here and who
  sleeps where, then proposes **one idea at a time** with a reason in your words.
- **Never hands you a broken layout as if it were fine.** The app, not the model, decides whether a
  proposal passes. If it can't be made to pass, it says so in plain words, with options.
- **Points and talks.** Tap the sofa, say "not here". Tap a wall, say "can we open this up?".
- **Remembers.** What you rejected isn't offered again; what you insist on becomes a rule the app
  checks for this home.
- **Shows the bill.** Every reply's cost on your key, and it asks before anything expensive.
- **Nothing changes in your plan until you accept**, and every accept is one Undo.

## User stories

The Ongs, 3-room resale in Toa Payoh (the app's sample flat: Main bedroom, Bedroom, Living and
dining with Dry kitchen, Kitchen, two baths, shelter). Rachel (36) and Daniel (38); Sophie (6);
Rachel's mother Mdm Koh (71, walks with a stick, cares about feng shui) moving in. S$40,000.

**First meeting**
1. As Rachel, I open the designer and it greets me with what it sees ("a 3-room flat, about
   67 m², two bedrooms, the dry kitchen open to the living room") and asks a few questions with
   tap answers, not a long form. It asks **who sleeps in which room**, because four people and two
   bedrooms needs a decision (Sophie shares with Mdm Koh? a bunk? the study?).
2. I can say "just design it" at any time; it states what it assumed ("I've assumed you two in
   the main bedroom and Mdm Koh and Sophie in Bedroom, two single beds") before it spends anything.
3. It shows "What I know about you" as a card I can edit, so a wrong guess is a tap to fix.

**Iterating**
4. It proposes the living room first. The sofa, TV, dining table and changes are previewed on my
   plan, each with a reason. I accept the TV wall and the dining table, not the sofa.
5. I tap the sofa and type "I don't like the sofa there, it blocks the window". It offers two other
   places (A and B), each previewed and checked, and I flip between them.
6. Daniel says "can we open the kitchen?". The designer explains the kitchen wall is likely
   structural, offers a glass sliding door instead, and shows the cost difference.
7. I accept the whole living room. One Undo takes it all back. Later I "bring back" V2's dining
   table idea from earlier in the conversation, without paying again.

**Concerns**
8. **Budget:** every proposal shows its renovation cost and how it moves my total against
   S$40,000. "Cheaper" proposes what to drop, with the saving.
9. **Elderly parent:** Mdm Koh's bed has a clear 0.9 m way to the bathroom, a getting-in side by
   the door, and the designer says when a door is narrower than she'd need with a frame later.
10. **Storage:** each proposal shows the storage meter ("Clothes 92% of what you need").
11. **Feng shui:** I tick it once; proposals note bed-facing-door and main-door-to-window lines
    and explain trade-offs, but never put safety, HDB rules or walkways behind it.
12. **Why:** I tap any change and see its reason at once (free); "Why not on the window wall?"
    gets an answer with the number ("that leaves 0.55 m to Bedroom; a walkway needs 0.9 m").

**Rules I set**
13. I say "never put anything in the corridor". The designer replies "I'll keep that as a rule
    for your home" and from then on the app rejects any proposal that does.

**Family**
14. Mdm Koh, on her phone with the view link, pins the bed: "Bed facing the door not good." I tap
    [Ask the designer] on her comment and it comes into the conversation with its pin.
15. I copy the conversation's decisions and the accepted plan's change list as text for the family
    chat and the ID.

**Quality loop (owner and developers)**
16. When the designer gets something wrong, I tap [This is wrong] on it, say what, and get a small
    case file the developers add as a test, so it never comes back.

## The conversation model

A conversation belongs to a project (one per project; [Start over] begins another). It is a list
of **turns**:

| Turn | Who | What it holds |
|---|---|---|
| Message | Person | Text (any language), up to 5 **pointers** to the plan (below), or an answer to a question widget |
| Question | Designer | One to three questions, each with tap answers (chips) or a small widget: who sleeps where (a row per room with people chips), style cards, budget chips, walls choice. Always skippable |
| Reply | Designer | Text: an answer, an explanation, a pushback |
| Proposal | Designer | Text plus a **change set** (one version, V n), with reasons, check results and lenses; optionally up to 3 **alternatives** (A/B/C) for the same scope |
| Event | App (never the model) | "You accepted 6 changes from V3 [Undo]", "You moved the sofa yourself; it stays where you put it", "Checked and fixed 1 problem before showing you this", "Stopped", "Limit reached" |

**Designer behaviour** (requirements for prompts and tools; the checks back them up):
1. **Asks before assuming** the facts the checks depend on: who lives here and who sleeps where,
   any elder's mobility, budget, walls (keep / HDB-allowed / structural too), what to keep. These
   **first-meeting questions are the app's own** (fixed, free, instant); the model only reads free
   text answers and asks follow-ups. At most 8 questions in the first meeting; one to three per
   message.
2. **States assumptions** when the person skips, in the proposal text, and adds them to "What I
   know about you".
3. **Small steps:** after the first meeting it offers "Start with the whole flat (about US$0.90) or
   one room (about US$0.20)?". Later turns change one room or one idea unless asked.
4. **Reasons:** every change carries one line, tied to the person's words where it can.
5. **Pushes back with numbers** on anything that breaks a check, HDB rule or the person's own
   rules, offering one alternative; the person decides on everything except HDB rules
   ([waivers](#when-a-check-fails)).
6. **Honest about limits:** says when something isn't in the app (beams, ceilings, curtains,
   lighting design, plumbing moves, a product not in the catalogue) and writes it as a note.
7. **Remembers:** decisions and rejections go into **Decisions** (a card the person can edit or
   delete). A rejected idea isn't proposed again unless asked.
8. **Keeps what you did:** locks and hand edits (v1) hold; the next turn mentions hand edits.
9. **Short:** about 120 words a message unless asked for more; plain English, metres, S$; replies
   in the person's language. UI text stays English.
10. **Never claims a check result.** Pass and fail lines on a proposal are written by the app.

**Proposal card** (in the conversation; the newest one is also pinned under the header as "On the
table: V4 · Passes all checks · [Accept…]"):
- Title and text (streamed).
- **Changes**, grouped by room, one row each: verb, piece, where ("Move the sofa to the wall by
  Bedroom, facing the TV"), a tick box, and its reason on tap. Room rows and "Walls and doors" have
  a group tick. Dependencies as v1: furniture in a room whose shape depends on new walls can't be
  ticked without the walls ("Needs the walls from V4").
- **Checks:** "Passes all checks" or "1 doesn't pass" (red, the line, [Show]). "Already in your
  plan: 2" (folded; not caused by this proposal).
- **Lenses** (one line each, only those that apply or are switched on): Cost "+S$2,300 · about
  S$31–38k in total · within S$40k"; Storage "Clothes 92%"; Older person "2 notes"; Feng shui
  "1 note"; Designer's second look "1 note" ([critique](#4-the-second-look-critique)).
- Actions: [Preview] (on by default for the newest), [Accept selected (6)], [Compare], [Show in
  3D] (opens 3D at that room, free), [This is wrong].
- Alternatives: a segmented A / B / C over the card; each is its own version, previewed and checked.

**Going back:**
- Every proposal card stays in the conversation. [Bring this back] on an older one makes a new
  version from it, re-checked on today's plan. No tokens.
- An accept's event has [Undo] while it is still the latest undo step; the toolbar's Undo and
  version history work as always.
- Header menu ▸ **My plan before the designer**: previews the level as it was when the
  conversation started; [Put it back] restores it as one undo step.

## Pointing at the plan (how comments attach)

Pointers use the same targets as plan comments: `item`, `opening`, `point` (electrical), `wall`
(with a spot along it), `room`, or a plain spot. Each pointer records the version it was made on
(the plan, or V n) so the model is told "the sofa in V4 (P7), in Living, at …".

- **While previewing a proposal** (the stage is read-only Select, as v1): tapping a piece, wall,
  door or room opens a small popover: **[Comment]** (adds a chip to the composer and focuses it),
  **[Why here?]** (shows the stored reason; free), **[Something else here]**, **[Remove this]**,
  **[Keep this]** (a lock). The last three send a short message at once ("Something else here: the
  sofa") showing its cost on the button.
- **On my own plan** (not previewing): the Inspector of a selected piece, wall or room has
  **[Ask the designer]**, adding it as a chip and opening the conversation.
- **A spot:** long-press (phone) or right-click (desktop) on empty floor while previewing: "Here"
  chip ("put a reading chair here").
- Chips show "Sofa · Living", × to remove; up to 5 a message. Hovering or tapping a chip in a
  sent message highlights its target on the plan; a target that no longer exists shows "(gone)".
- **Family comments:** each open thread in Comments has **[Ask the designer]** (owner and edit
  links with a key): the comment comes in quoted, with its anchor as a pointer, as "Mum: Bed facing
  the door not good". Comment text is passed to the model as quoted data, never instructions.

## What the designer must always get right

### 1. Encoded once: layout principles, not incident rules

The owner's three faults are instances of four general principles. The checks are built on these,
driven by **catalogue data**, so a new piece type or room type is covered by its data, not a new
rule. Each principle is a core function with tests; the numbers are in one table.

**P1. Function per room (the room's programme).** Each room use (from the conversation or the room
name) has a programme: what it **must have**, **should have** and **must not have**, sized to who
uses it.

| Use | Must have | Should have | Must not have |
|---|---|---|---|
| Bedroom (any) | a bed for each person sleeping there (sizes below); a window | clothes storage for them (wardrobe or a walk-in next door); a bedside surface each | hob, sink, fridge, dining table |
| Living | seats for the household, at least min(people, 3), facing a focus | a focus (TV or a feature), a surface within reach of each seat | beds (unless the person said so) |
| Dining | a table with a chair (or bench place) per person, up to 6 | | |
| Study / WFH | a desk and chair for each person working from home | the desk with daylight from the side or front | |
| Kitchen | sink and hob where they are (wet area, v1) | a fridge with its door clear; worktop beside the hob | beds, sofas |
| Corridor, foyer, passage (a room under 1.4 m wide, or named so) | nothing | a shoe cabinet or console up to 0.35 m deep if 0.9 m stays clear | anything deeper than 0.35 m |
| Household shelter | its door openable, nothing fixed to its walls | | a bed, unless the person asked (helper), then a note |

Bed sizes for P1: a couple, one bed at least 1.52 m (queen) or two singles; an adult or teen, at
least 0.92 m (single), 1.07 m (super single) suggested; a child, a single or one bunk place; a
baby, a cot or a note "baby in the parents' room". An elder: their own bed, getting-in side towards
the door (the Older person check's bed rules where they use a stick, frame or wheelchair).

Who sleeps where (decided 7 Nov 2026): the brief may say it, naming household members only (a
stale entry naming nobody falls back to the default). Not said: the couple in the largest bedroom,
then elders and children one per room, two children sharing where rooms run out. Anyone left
without a room or bed is a hard P1 line on the person ("Sophie has no bed: …"), never "already in
your plan", never waivable into a pass, shown first, and the card never says "Passes all checks"
while it stands; it names the way out where there is one ("a bunk bed sleeps two children in the
space of one"). A bunk bed counts as two single places. The household shelter takes only the
helper.

**P2. Relationships between pieces.** A small vocabulary the catalogue uses: `backs onto` (a wall,
gap at most 50 mm), `faces` (another piece or the room; within an angle, a distance band, nothing
taller than a set height between), `near` (within a distance), `clear of` (a zone kept free),
`belongs to` (chairs to their table, bedside tables to their bed). Each catalogue kind lists its
relationships once:

| Kind | Relationships |
|---|---|
| Sofa, armchair | faces the room's focus (TV within 20° of its forward line, 1.8–4.0 m from its front, nothing over 1.0 m between) or, with no TV, at least 1.2 m clear in front; backs onto a wall, or has 0.9 m clear behind (a floating sofa) |
| TV, TV console | backs onto a wall; faces the main seat within 30° |
| Bed | head backs onto a wall; not across a doorway; a side or foot reachable from the door |
| Wardrobe, chest, shelf, cabinets, fridge | backs onto a wall; front clear (v1 zones) |
| Dining chair | belongs to a table; faces it within 45°; 0.75 m to pull out (v1) |
| Desk | backs onto a wall or window wall, or is free with 0.8 m behind; chair 0.8 m |
| Bedside table | near its bed's head (within 0.15 m), one per usable side |
| Coffee table | 0.35–0.50 m from the sofa's front |

"Sofa facing the wall" fails `faces`; "missed beds" fails P1; a new kind (a bay seat, a bunk bed)
needs only its row.

**P3. Circulation.** v1's walkway check, made binding for proposals: 0.90 m from the main door to
every room, 0.60 m to every usable bed side, never stricter than the flat's bare width. Plus: a
door's throat and sweep stay free (any door, the main door and the shelter's included), door
clashes (door with door, door with a wardrobe's or fridge's doors). "Table in the hallway" fails
here and P1's corridor row.

**P4. Fit and access.** No overlaps over 20 mm (seats under tables allowed), nothing into walls,
inside its room; v1's front zones (wardrobe 0.60, drawers 0.75, fridge and kitchen 0.90, desk
0.80, bed sides 0.60); windows: nothing taller than the sill less 20 mm in front of one, built-ins
never cover one; every room with a bed keeps a window. HDB rules (v1: shelter, outside, wet,
windows, structural by the walls choice) stay as they are.

Decided 7 Nov 2026 (tech-lead and UX review), as the hard line and the softer advice:

| What | Hard (fails) | Soft (advice) |
|---|---|---|
| Bed in front of a window | measured at mattress height, 0.52 m | a headboard above the sill: "rises 0.10 m above the window sill" |
| Wardrobe, shelf, fridge or other tall piece in front of a window | its full height against the sill less 20 mm | |
| Getting into a single, super single or bunk bed | 0.50 m beside it | 0.60 m |
| A double, queen or king bed | 0.50 m on one long side | the other side against a wall: a note, fine in a small room |
| Sliding-door wardrobe (a built-in counts as sliding) | 0.50 m in front | 0.60 m |
| Hinged wardrobe | 0.60 m in front | |
| Way past a bed to its usable side (P3) | 0.50 m | 0.60 m |

Dining zone and lounge zone (owner's decision, 7 Nov 2026), measured from the dining group (the
table and its chairs) to the sofa, armchairs, coffee table and TV console: **0.60 m is hard**
("Not enough room to walk between the dining table, 4 seats and the 3-seat sofa: 0.60 m needed,
0.03 m left."), **0.90 m is advised**. The solver keeps 0.90 m wherever a clear pose off the ways
through the flat does, else 0.60 m. Where even 0.60 m can't be kept, it right-sizes as a
designer would, keeping the designer's intent, and says each swap in a line ("Swapped the 3-seat
sofa for a 2-seat to keep 0.60 m to the dining table."): a round table for four (or a wall-side
table with a bench, for a household of two); for a table for six, an extendable table ("it fits
4, and 6 with the table pulled out"); a 2-seat sofa where armchairs still seat the household;
then both. Only if nothing fits does the check fail, so it goes to a fix round or "can't be
met"; never a silent 3 cm. A TV stands on its console; an
armchair faces the TV or the sofa's front; chairs go evenly round a table; a desk gets a desk
chair.

### 2. Hard and soft

- **Hard** (gate a proposal): P1 must-haves and must-nots, P2 relationships, P3, P4, HDB rules,
  the person's own rules ([below](#3-the-persons-own-comments-become-checks)), locks and hand edits
  unchanged, kept pieces present.
- **Soft** (lens lines, never gate): P1 should-haves, storage meter, budget, Older person check
  notes (door widths HDB built), feng shui, kitchen work triangle, dining seats beyond 6, the
  second look's notes.

### When a check fails

1. The designer's answer is applied to the plan by the app and checked **before the person sees
   it**. Hard failures the proposal caused go back to the designer automatically (up to **2 fix
   rounds**, priced in the estimate, shown as "Checking… fixing 1 problem").
2. Still failing: the card says so in the app's words ("Sophie has no bed: Bedroom fits one single
   bed with 0.6 m beside it"), the failing changes are unticked and marked "Doesn't pass", and the
   designer adds options (a bunk bed, a trundle, the living room's sofa bed). The rest can be
   accepted.
3. Ticking a failing change asks "Accept anyway? Sophie will have no bed." [Accept anyway]
   records a **waiver** (shown in Decisions; the plan's own checks still show it). HDB rule
   failures can't be waived (as today).
4. Failures already in the plan, not touched by the proposal, are "Already in your plan" and don't
   block. The designer may offer to fix them.
5. When the person asks for something that fails ("put the table in the corridor"), the designer
   says what breaks with the number and one alternative; if the person repeats it, it is done with
   a waiver.
6. **Can't be met in this flat** (five people, two bedrooms, no study): the first meeting raises it
   as a question before any proposal, with options. The designer never silently drops a person.

### 3. The person's own comments become checks

When a message states a lasting wish ("never anything in the corridor", "the sofa must face the
window", "Mum's bed near the bathroom", "keep the shoe cabinet by the door"), the designer turns it
into a **house rule** in the P2 vocabulary (piece kind or a specific piece, relationship, target,
numbers) and asks once: "I'll keep this as a rule for your home: *Nothing in the corridor.*
[Keep as a rule] [Just this once]".
- Kept rules are checked by the app on every proposal in this project, hard, like P1–P4, and listed
  under **Your rules** (edit wording, numbers, delete).
- A wish that can't be put in the vocabulary ("feel more airy") is kept as a **note to the
  designer**, labelled "not checked", so nobody thinks it is.
- A rule that conflicts with an HDB rule or another rule is refused with why.
- Waivers and rules carry over to "Bring this back" (old versions are re-checked against today's
  rules).

### 4. The second look (critique)

Checks catch what can be measured. A designer also looks at the result. After the checks pass,
an optional **second look** sends the proposal back to the model *as a picture*: the plan drawn by
the app (furniture outlines, labels, dimensions of the key gaps, the changes highlighted; the same
drawing as the plan PNG export, made on the device, free) and a short sheet of facts (room sizes,
who sleeps where, rules). It asks for what a designer would notice: awkward flow, a room that
feels empty or crowded, a focal point that's off, pieces out of proportion, daylight blocked.
- Findings come back in a fixed form: target (piece, room, wall), principle (P1–P4 or "taste"),
  severity (fix / consider), one line.
- A **fix** finding on P1–P4 is verified by the app's checks; if the checks disagree, the app's
  answer stands and the finding is dropped (logged in the case file). A "fix" taste finding gets
  one more round; "consider" findings show as "Designer's second look" notes on the card.
- On by default for whole-flat and room proposals with "Thorough"; off for "Quicker". Its cost is
  in the estimate and on the card ("second look US$0.06").
- Repeated taste findings across cases are where new principles come from
  ([regressions](#5-new-failures-become-regression-cases)).

### 5. New failures become regression cases

- **[This is wrong]** on a proposal card or a piece's popover: a one-line "What's wrong?" with
  quick picks (Missing something · Facing the wrong way · In the way · Doesn't fit · Ugly or odd ·
  Other) and the pointer. Free.
- It saves a **case**: the level before, the proposal's level, the brief and household, the
  person's rules, the pointer and their words, the check results and second-look findings, the
  model and app version. Plan names and free text are kept; keys, prices, other projects, the plan
  image and comment authors are not. [Copy case] / [Download case] (a `.json` under 200 KB), and
  "Paste it into a GitHub issue to help fix this" for the owner. Nothing is sent anywhere by the app.
- **Developers:** a case dropped into `packages/core/src/fixtures/designer/cases/` is a test with no
  code: it asserts **the app's checks flag the bad layout** (at least one hard check on the
  pointed target). If none does, the test fails until a principle or catalogue row covers it (or
  it is marked `known` with a note). Fixing the cause adds the principle once; all cases rerun.
- A **benchmark** set (the sample 3-room, the 4-room test fixture, a 5-room, a 2-room flexi, an
  executive with a study, a BTO with an open kitchen), each with a household, runs the checks on
  recorded designer answers in CI. With a real key, `pnpm designer:eval` (manual, owner or agent,
  priced before it runs) designs each one and reports, per flat: hard failures shown to the person
  (must be 0), failures caught before showing, fix rounds used, second-look findings, cost. Good
  answers it records become fixtures.
  *Built in slice 1:* the sample 3-room (full household, Sophie in the Bedroom) and the 4-room
  fixture, plus the owner's 7 Nov cases, in `packages/core/src/designer/benchmark/`
  (`pnpm --filter @dhd/core designer:bench` prints the report from recorded answers). The 5-room,
  2-room flexi, executive and BTO flats have no traced plan in the repository yet; each joins the
  set when one is added. The live run with a key is not built yet.

## Cost and streaming (BYO key)

- **Per message:** the Send button shows the estimate ("Send · about US$0.03"). Each designer
  message shows its actual cost, muted ("US$0.04"; tap for tokens, cache, fix rounds, second look).
- **Header:** "This conversation US$1.84 · this tab US$2.10 of US$5.00".
- **Asks before spending:** a turn whose high estimate passes the person's per-reply threshold
  ("Ask me before a reply that may cost more than [US$0.25 ▾]", in AI settings) gets a short
  designer reply first: "Redesigning the whole flat takes about US$0.90 (at most US$1.90). Go
  ahead?" [Go ahead] [Just the living room · about US$0.20]. v1's cost check rules (first run in a
  tab, US$0.50 and over, passing the limit) still apply, as a card in the conversation rather than
  a dialog.
- Rough sizes for the copy (Claude Opus list prices, cached prefix): a question or answer
  US$0.01–0.03; a room proposal US$0.10–0.25; the whole flat US$0.80–2.00; a fix round about half
  its proposal; a second look US$0.03–0.08.
- **Streaming:** "Thinking…" at once, with the model's thinking summary line (Claude) as v1; text
  streams as it comes; a proposal's changes appear on the plan as ghosts with "Checking…" as the
  solver places them; ticks and Accept enable only once the checks have run. Live region: the
  finished message, not every token.
- **Stop** (button; Esc on desktop) at any time: text so far is kept; a partial proposal is kept,
  checked and treated like any other; the cut-off cost is estimated "~" (v1).
- Spend limit, pause, rate limits, quota, refused key, offline: v1's behaviour and copy, shown as
  app events in the conversation.
- Long conversations: older turns are folded into Decisions and "What I know" inside a normal
  turn (said in an event); the person sees nothing lost.

## Layouts

### Desktop (1280 and up; works from 1024)
- The conversation is the details column, at least 400 px; the stage (plan, 3D, walk) refits on
  the left and shows the proposal being previewed.
- Header: "Designer", spend line, menu: What I know about you, Decisions, Your rules, Versions
  (the v1 strip), Compare, My plan before the designer, Copy as text, Start over, Close.
- Under the header, the pinned "On the table" bar. Then the message log; then the composer:
  pointer chips, quick-reply chips (one row), textarea (Enter sends, Shift+Enter a new line),
  Send with its cost.
- Hovering a change row highlights the piece on the plan; hovering a piece on the plan highlights
  its row.
- Preview bar as v1: "Previewing V4, not in your plan yet [Accept…] [Back to my plan]".
- Diff on the plan: new pieces in the accent outline, moved ones with a faint ghost where they were
  and a thin arrow, removed ones dashed, walls as v1; failing pieces in red with the check's label.

### Phone (390 px, fingers only)
- A bottom sheet with three heights: **peek** (the newest message and the composer), **half** (the
  plan above, refitted to the proposal), **full** (the conversation). It opens at half.
- The "On the table" bar stays in the sheet's header at every height.
- Tapping a piece on the plan gives the popover as an action sheet (44 px rows).
- Composer above the keyboard (`visualViewport`); chips scroll sideways in one row; no sideways
  page scroll.
- Proposal cards: change rows 44 px with their ticks; alternatives A / B / C as a segmented
  control and swipe.
- Compare: one column at a time (v1). Landscape: the right-hand column that folds to a tab.
- Dictation from the phone keyboard works in the composer (nothing to build).

## What carries over from v1

| v1 | In v2 |
|---|---|
| Brief form | Kept as "Fill in a form instead" in the first meeting; it fills the same brief, shown as "What I know about you" |
| Versions V1…Vn in IndexedDB | Every proposal and alternative is a version; the strip is in the menu; same limits (20 per project) |
| Compare | Unchanged, reached from a card or the menu |
| Preview (plan, 3D, walk) | Unchanged, plus the diff marks and the popover |
| Accept in parts, one Undo | Finer: per change with group ticks; same dependencies and one undo step |
| Locks, hand-edit locks | Unchanged; [Keep this] on a piece adds one; listed in "Your rules" as kept parts |
| Spend meter, limit, prices, cost check | Unchanged rules; shown in the conversation |
| HDB wall rules, wet areas, refused ops "Left out" | Unchanged |
| "Change something" composer | Replaced by the conversation |
| Problems listed under a finished design | Replaced by hard checks that gate and soft lenses |
| Three providers, streaming, retries | Unchanged |

Existing v1 versions open in v2 as proposal cards in a conversation started from them ("Earlier
designs").

## Edge cases

| Case | Behaviour |
|---|---|
| No key, or only a picture model | Opens AI settings first (v1). The free parts (first-meeting questions, What I know) can be filled without a key; nothing is sent |
| More people than bedrooms | Raised in the first meeting with options; never a silent missing bed |
| Person skips every question | Designer states assumptions (each bedroom-use room gets beds for two in the largest, one elsewhere); they show in What I know |
| Person asks for an HDB-forbidden change (hack the shelter) | Designer declines with the HDB reason; the app refuses it anyway |
| Person insists on a failing layout | Done with a waiver (not for HDB rules) |
| Person's own plan already has problems | "Already in your plan"; never blocks a proposal |
| Plan edited by hand mid-conversation | Next turn starts from the plan as it is; an event lists hand edits; they're locked (v1) |
| Plan edited while a reply streams | The proposal is checked on the plan as it is when it finishes (v1 re-check) |
| Rule conflicts with another rule or HDB | Refused with why; the older rule stays |
| A pointer's target deleted | Chip shows "(gone)"; the message still sends with the spot |
| Catalogue lacks the piece ("a Castlery Dawson sofa") | Nearest catalogue piece at the stated size, with a note; offers My furniture |
| Off-topic or unsafe asks | Steers back to the home; model refusals shown as v1 |
| Comment or plan names containing instructions | Passed as quoted data; checks still gate every proposal |
| Other language, Singlish | Replies in kind; checks and app lines in English |
| Second look disagrees with the checks | Checks win; finding dropped and kept in any case file |
| Second look fails or times out | Proposal shown without it: "Second look didn't finish" |
| Panel closed while replying | Reply continues; the entry shows "Designer is replying…"; Stop from there |
| Tab closed mid-reply | Finished turns kept (IndexedDB); the cut-off one is lost and may be billed |
| Two tabs on one project | Turns appended in order; the panel refreshes on focus (v1) |
| Private window, no IndexedDB | Conversation in memory with v1's warning |
| Several levels | Works on the level shown; each card names its level |
| View-only link | No designer (slice 4: read-only conversation if shared) |
| Unknown model price | Tokens only, limit not checked (v1) |

## Out of scope

- Voice conversation (spoken replies); photos of the flat or inspiration images as input.
- Real products, loose-furniture prices, shopping links (ideas row 14).
- A server-side key or paying for the person's AI use; anything sent to us automatically
  (case files are copied by hand).
- Moving wet areas, windows, the main door or the shelter; ceilings, beams, lighting design,
  curtains (notes only).
- Designing several levels at once; condo (MCST) rules.
- Feng shui beyond the listed geometric notes; it is never hard.
- Family members talking to the designer on the owner's key (slice 4 is read and comment only).

## Storage and schema

- **Slices 1–3: no schema change.** The conversation (turns, pointers, Decisions, What I know,
  rules, waivers, the starting level snapshot, per-turn usage) lives in IndexedDB `dhd-designs`
  beside v1's versions and briefs. Not in the project document, exports, share links, history or
  `/api`. Deleting a plan deletes it. Accepting writes ordinary data through one `Command` (v1's
  `acceptDesign`).
- House rules are in IndexedDB too; they only bind the designer, so they needn't be in the project
  yet. Moving them, and the household, into the project fits the planned `Project.household`
  (schema 11, with the paused ageing slice 2); not needed for v2 and not blocking.
- **Slice 4 (sharing):** a separate server resource like comments (`/projects/{id}/designer`, its
  own size cap, owner writes, view links read), not the project schema; no `SCHEMA_VERSION` bump,
  but an API change, so deploy the API first. Comments anchored to a version need the comments
  anchor's `variant` to accept a version id (tech lead to confirm).

## Slices

**Slice 1 (M–L): layouts that pass, before any chat UI.** Inside v1's flow:
- Core: principles P1–P4 as checks driven by a programme table per room use and relationship rows
  per catalogue kind; hard/soft split; "already in your plan" vs caused; waivers.
- The tech lead's intent-plus-solver placement; the automatic fix rounds (a room goes back once on
  Quick, twice on Thorough, and a run sends 3 fix requests at most; "at most" in the cost check
  prices those 3 and says "up to 3 fix-ups included") before a
  version is shown; the version card's Checks line and "Doesn't pass" parts unticked in Accept,
  with Accept anyway.
- The household's "who sleeps where" added to the brief (room rows get people chips).
- Case files ([This is wrong] on a version), the cases folder test, the benchmark set in CI,
  `designer:eval`.
- 1b (S, can ship separately): the same checks on anyone's own plan in Plan details ▸ Checks
  ("Design: Bedroom has no bed; the sofa faces the wall"), free.

**Slice 2 (L): the conversation.** Conversation panel and phone sheet; first-meeting questions and
widgets; What I know, Decisions; proposals as cards with per-change accept; alternatives; Why
(stored reasons); pushback; streaming text and ghosts; per-message cost and the ask-before-spending
threshold; Bring this back; My plan before the designer; Copy as text; v1 versions imported.

**Slice 3 is split in two (lead decision, 8 Nov 2026):**

**Slice 3a (L): pointing at the plan, and house rules.** Three PRs, each shippable:
- A, house rules: the rule object, its checks inside the design checks, vetting before it is offered,
  the offer under a reply, Your rules, Decisions made rules, rule rows on the card and Accept anyway
  per rule, re-checks with no request, records version 3.
- B, pointers: chips in the composer and in sent messages, the popover (Why here?, Keep this, Leave it
  out, Something else here, Remove this), Here on empty floor, [Ask the designer] from the Inspector,
  kept pieces.
- C, rules the solver aims for: steering for positive rules (in, faces, against, distances).

**Slice 3b (M): second look and lenses.** The second look with the plan picture; lenses for storage
and feng shui; [Ask the designer] on a comment thread (criterion 38, moved from 3a). The Older person
lens is on hold.

**Slice 4 (M, server):** share the conversation read-only with a link; family comments on a
version; the owner forwards them to the designer.

## Acceptance criteria

Provider calls are mocked (recorded streams, as v1); **no test calls a real provider.** "Checks"
means core's design checks.

### Slice 1: quality
1. Sample flat, household 2 adults (Main bedroom) + 1 elder with a stick and 1 child (Bedroom): a design with
   only a queen bed in Main bedroom fails P1 with "Mdm Koh has no bed" and "Sophie has no bed",
   both on Bedroom; adding two single beds that fit passes.
2. A bedroom-use room with no window fails P1; the shelter with a bed fails unless the household
   has a helper placed there, then it passes with a note.
3. A sofa whose front is 0.5 m from a wall fails P2 "faces the wall"; turned 180° with its back to
   that wall, passes. A sofa 25° off the TV's line fails; 10° passes; 1.5 m from the TV fails;
   2.4 m passes; a 1.8 m shelf between them fails.
4. A floating sofa with 0.7 m behind it on the route to Bedroom fails; with 0.9 m passes.
5. A dining table in the corridor leaving 0.60 m fails P3 with v1's walkway wording and P1's
   corridor row; a 0.30 m-deep shoe cabinet leaving 0.95 m passes.
6. A piece in the shelter door's sweep fails P3; a 2.1 m wardrobe in front of a window fails P4.
7. Never stricter than the flat: a bare corridor of 0.85 m needs 0.83 m.
8. A new catalogue kind given only a relationship row (a test-only "bay seat": backs onto a window
   wall) is checked with no other code change.
9. A failure present before the proposal and untouched by it is "already in your plan" and the
   proposal passes.
10. Mocked answer with the sofa facing the wall: the app sends exactly one fix request whose body
    names the failure and the piece; the mocked fix passes; the card says "Passes all checks" and
    "Checked and fixed 1 problem"; the usage shows both requests.
11. Mocked answers failing twice: after 2 fix rounds the card shows "1 doesn't pass" with the app's
    line; that change is unticked; Accept selected leaves it out; ticking it asks "Accept anyway?";
    accepting records a waiver.
12. An HDB rule failure can't be ticked (no Accept anyway).
13. No version is shown with "Passes all checks" while any hard check fails (property test over
    the fixtures and every benchmark flat).
14. [This is wrong] produces a case file with the listed fields and none of: the key, prices, the
    plan image, comment authors; under 200 KB for the sample.
15. A case file copied into `fixtures/designer/cases/` runs as a test with no code; a case whose
    bad layout no check flags fails the suite unless marked `known`.
16. The owner's three cases (missing beds, sofa facing the wall, table in the hallway) are in the
    cases folder and pass.
17. Benchmark in CI: every recorded answer, after fix rounds, has 0 hard failures shown as passing.
18. All checks on the sample with 40 pieces: under 150 ms (median of 7 under `PERF=1`, three times
    otherwise).
19. 1b: Plan details ▸ Checks lists P1–P4 problems on a hand-made plan, free, with [Show next];
    no household known means P1's bed count is skipped with "Tell us who sleeps where".

### Slice 2: conversation
20. Opening the designer on the sample greets with the flat's type, area and rooms, then asks the
    first question with chips; no provider request is made until a free-text answer or a design is
    asked for.
21. Who-sleeps-where shows one row per bedroom-use room with people chips; 4 people and 2 bedrooms
    with nobody assigned is raised as a question before any proposal.
22. "Just design it" shows assumptions in the proposal text and in What I know.
23. A proposal card shows its changes grouped by room, a reason per change, Checks, Cost and the
    lenses that apply; Accept selected with 2 of 5 rows ticked changes only those 2, as one undo
    step; the event's Undo restores the project exactly.
24. A rejection ("not the sofa there") puts a line in Decisions; the next request's body includes
    it; editing or deleting it changes the next body.
25. Alternatives A/B/C each preview and carry their own checks; switching costs no request.
26. [Why here?] shows the stored reason with no request.
27. [Bring this back] on V2 makes V(n+1) with no request, re-checked on today's plan and rules.
28. My plan before the designer previews the starting level; Put it back restores it in one undo
    step.
29. Send shows an estimate; each designer message shows its cost; the header totals equal the sum
    of the fixtures' usage at the price table.
30. A turn above the threshold gets the "Go ahead?" reply first; [Go ahead] sends the expensive
    request; the cheaper option sends the scoped one.
31. Text streams (the first chunk visible before the stream ends); ghosts appear on the plan
    before Accept enables; Stop mid-stream keeps the text, cancels the request (signal aborted)
    and records "~" cost.
32. A hand move of the sofa between turns shows the event and the next request marks it fixed
    (v1 hand-edit lock).
33. v1 versions in IndexedDB appear as "Earlier designs" cards and can be previewed and accepted.
34. Reload: the conversation, Decisions and versions are back; IndexedDB holds no key.
35. Phone 390 px, fingers only: first meeting, a proposal, accept part, Undo, alternatives, the
    sheet's three heights, composer above the keyboard; no sideways scroll; targets ≥ 44 px.

### Slice 3a: pointing at the plan, and house rules
36. While previewing, tapping the sofa opens the popover; Comment adds "Sofa · Living" to the
    composer; the request body names the piece's id, room and version.
37. Up to 5 chips; a sixth is refused with "Up to 5 at a time"; a deleted target shows "(gone)".
39. "Never put anything in the corridor" (mocked rule) asks Keep as a rule; kept, a later mocked
    proposal with a console in the corridor fails with the rule's wording; deleting the rule makes
    it pass.
40. A wish that maps to no rule is kept as a note labelled "not checked".

Criteria 3a.1–3a.12 (from the PM's list and the UX design's §12):
- 3a.1 On your own plan, the Inspector's [Ask the designer] (and a tap on a piece while the designer
  is open) puts a chip for that piece in the composer; the request names its id, room and level.
- 3a.2 While previewing, a right-click (desktop) or a 500 ms press (phone) on empty floor adds a
  "Here · {Room}" chip with the spot in metres; a pan or a pinch never makes one.
- 3a.3 Why here? shows the stored reason and Keep this keeps the piece where it is, both with no
  request.
- 3a.4 Chips in a sent message light their target; a target gone since shows "(gone)" and where it
  was.
- 3a.5 Changing a rule's number in Your rules re-checks the card on the table at once, with no
  request, and says so in the log ("V6 checked again: …").
- 3a.6 A rule that contradicts a kept one, breaks an HDB rule, can't be met by the flat or rules out
  a must-have (beds where someone sleeps) is refused with why; a contradiction offers Replace yours
  or Keep yours, and the older rule stays by default.
- 3a.7 A rule the plan already breaks is said when it is offered ("Your plan doesn't meet it now:
  …") and, on a proposal that doesn't touch it, is in "Already in your plan", never failing it.
- 3a.8 Bring this back checks the old version on today's rules and says so ("…and on your 2 rules").
- 3a.9 Rules and pointers are kept with the conversation on the device: never in the project, `/api`,
  exports or share links.
- 3a.10 Pointer labels, room names and comment text go to the model as quoted data; an
  instruction-like text is never acted on.
- 3a.11 Phone, 390 px, fingers only: chips, the action sheet, a rule offer and Your rules have
  targets of at least 44 px and no sideways scroll.
- 3a.12 A home of several levels: every pointer and every rule carries its level; a card is checked
  only against its own level's rules, and a chip names the level when there are several.

**Slice 3a, the PM's additions** (settled 8 Nov 2026):
- **Rule vocabulary.** A rule is data: a subject (anything, a category such as tall pieces or
  storage, a kind or role, or one piece in the plan) × a relation (not in, in, faces, doesn't face,
  within, at least, against, keep clear) × a target (a room, a room use, a wall, a door or window,
  their room's door, the window, a kind, the way from the main door to rooms, a spot) × a number in
  metres. The app checks it; the model only fills it in; the sentence shown is the app's, from the
  rule object, never the model's prose. At most 20 rules a home.
- **A corridor is a route.** "Corridor", "passage" and "hallway" are never targets: the app names
  the way it means ("the way from the main door to Main bedroom and Bedroom") and Show on plan draws
  it. "Nothing in the way" fails a piece standing in the corridor part of that way even when the
  width left passes; "keep 0.90 m clear" fails only a piece that leaves less.
- **Decisions vs rules.** A rule is checked on every proposal; a Decision is told to the designer,
  not checked. Just this once keeps an offered rule as a Decision; Make this a rule turns a Decision
  into an offer (priced as a Send, about US$0.03; free when the Decision came from Just this once).
- **Conflicts** are refused with why (see 3a.6); two clear widths on the same way merge to the wider.
- **Already in your plan** works for rules as for the app's checks (3a.7); waivers are per rule and
  per piece, and the rule stays.
- **Your rules** is a menu view beside What I know and Decisions, on a phone too (no tab bar).
- **Popover pricing:** Something else here and Remove this show Send's figure (about US$0.03); a
  design that follows asks under the usual cost rules.
- **The phone gesture:** a 500 ms press on empty floor makes a Here chip; a second press moves it.
- **Level on pointers:** see 3a.12.
- On Start over, rules and kept pieces carry over only when "Keep what I know about you" is ticked.
- A rule never forces a piece in: "the desk in Bedroom" with no desk passes.

### Slice 3b: second look and lenses
38. [Ask the designer] on a comment thread adds it quoted with its anchor; the request carries the
    comment text as quoted data. (Moved from 3a.)
41. Second look: the request contains a plan image made on the device and the facts sheet; a "fix"
    finding on P2 that the checks confirm triggers one round; one the checks contradict is dropped;
    "consider" findings show as notes; Quicker sends no second look.
42. Feng shui on: a bed whose foot faces the door gets a note; it never makes a proposal fail.

### Slice 4: sharing
43. A view link shows the shared conversation read-only (no composer); the owner's key is never
    in it; sharing asks first with "Family with the link will see what you've told the designer
    about your household."
44. A family comment on V4 shows in the owner's conversation; [Ask the designer] forwards it.
