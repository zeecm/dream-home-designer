# Spec: AI interior designer (a whole-flat design you can iterate on)

Owner request (6 Nov 2026), verbatim: "Apart from just recommending layouts, there should be an
idea to use AI to recommend ENTIRE house layouts WITH furniture AND suggested wall hacks, with
paint. Basically the full interior designer experience. And the recommendation should be able to
be iterated upon, parts changed or altered accordingly. This would cost a huge amount of tokens,
so the user should be warned accordingly."

Project-manager, 6 Nov 2026. Builds on [ai-layouts.md](ai-layouts.md) (keys, providers,
`planForModel`, `applyLayout`, `adoptLayout`), [structural-walls.md](structural-walls.md),
[clearance-checks.md](clearance-checks.md), [my-furniture.md](my-furniture.md) (delivery, lift),
[carpentry-cost.md](carpentry-cost.md), [electrical.md](electrical.md) and
[slice-2s.md](slice-2s.md) A (suggested points).

**Effort:** slice 1 is L, built as two PRs (1a core, 1b web). **Schema:** no change (see
[Storage](#storage-and-schema)). **API:** no change, no deploy needed.

**Problem.** An HDB owner can now draw the flat, hack walls, place furniture, paint and price it,
but each is a separate tool, and they have to be the designer. What they want from an interior
designer is a complete, coherent proposal for the whole flat that fits their household and
budget, and that they can change one part of without starting again. A designer charges
S$2,000–5,000 for a concept. Ours costs the person a dollar or two on their own AI key, so the
cost must be visible before and during every run.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | One big call, or steps? | **Steps:** one *layout and style* call for the whole flat, then one *room* call per space, run on the plan *after* the layout's walls are applied in core. | Furniture coordinates must be relative to walls as they will be. A single call would have to imagine the geometry after its own hacks; it gets it wrong. Steps also give progress room by room, keep one failure from losing the run, keep each answer well under the output limit, and let iteration redo one room for a fraction of the price. Cost is about 20–40% more input than one call, most of it recovered by prompt caching. |
| D2 | What is designed? | The **renovation (After)**: walls and doors, room names and uses, furniture and built-ins, paint and wallpaper per wall face, floor per room, suggested electrical points, and a style summary with a palette. Priced by `costEstimate`. | The owner's "full interior designer experience". |
| D3 | Starting point | After if a renovation exists, else Before. The brief can choose "The flat as it is" instead. | People who have already planned some hacking want the designer to build on it. |
| D4 | What may change? | Never: household shelter walls, outside walls, windows, bathroom walls, the kitchen's sink and hob position (wet area). Structural and likely-structural walls: locked by default; the brief can allow them, and then every such change is flagged "(structural)". | HDB rules ([structural-walls.md](structural-walls.md)). Wet areas stay because moving plumbing and gas needs approval and is rarely done. |
| D5 | Who checks the answer? | **Core**, deterministically. The model proposes; core validates, applies with the app's own commands, repairs what it can and lists the rest. The model never writes the project. | The same rules as every other edit path. |
| D6 | Where do proposals live? | **IndexedDB in this browser** (`dhd-designs`), per project. The project document gets only what is accepted, as ordinary walls, items and finishes. | No schema change; versions are drafts, like trace drafts. Losing them on reload would waste paid tokens, so they're kept on the device. |
| D7 | Electrical points | Computed **locally** by `suggestPoints` on the designed level (no tokens). | Already built, deterministic, free. |
| D8 | Money | AI cost is in **US$** (providers bill in US$); renovation cost stays in **S$**. Never mixed in one figure. | Avoids "your design costs $1.40". |
| D9 | Manual edits after accepting | After is the truth once accepted. The next iteration starts from After as it is, and the parts edited by hand since accepting are **locked automatically** (shown, and can be unlocked). | The person's own changes are never overwritten silently. |

## User stories

The Tan family: Mei Ling (38) and Kevin (40), Kevin working from home three days a week; Ethan (9)
and Chloe (4); Kevin's mother, Mdm Lim (74), who walks with a stick and is moving in. A 4-room
resale flat, S$60,000 for the renovation.

1. As Mei Ling, I fill in one brief (who lives here, how we live, the style we like, our budget,
   what we're keeping) and get a complete design for the whole flat: which walls to hack, what
   each room is for, the furniture and carpentry, paint and floors, and the cost.
2. Before anything runs, I see roughly what it will cost on my own AI key, and I can stop it
   at any time and keep what's done.
3. As Kevin, I want a proper study corner. I ask the designer to redo just the second bedroom
   ("Kevin's study corner, kids share the room") and the rest of the design stays as it was.
4. I like the living room and the paint. I lock them, and ask for "cheaper" for the rest.
5. I type "make the kitchen open" and get a version with the kitchen wall hacked or glassed,
   with the warning if it is structural.
6. For Mdm Lim, I tell it she walks with a stick. Her room is near a bathroom, with a door at
   least 0.85 m wide and a clear 0.90 m way to it; if not, the design says so.
7. I compare two versions side by side with the flat as it is, and walk through one in 3D
   before I accept anything.
8. I accept the walls and the living room from version 2 and the bedrooms from version 3. One
   Undo takes it all back.
9. After accepting, I move the sofa myself. When I ask for another kitchen idea, my sofa stays
   where I put it.
10. On my phone on the bus, I can read the design, look through the versions and ask for a
    change, without the screen scrolling sideways.

## Flow and screens

### Entry
- Plan details ▸ Renovation: **[Design my flat with AI]** under "Suggest layouts with AI".
  When versions exist: **[Designs (3)]** reopens the panel.
- Disabled with title "Draw rooms first." when the level has no rooms. Hidden on view-only links.
- No key: opens AI settings first (as Layouts does); saving the key opens the brief.

### 1. Brief (dialog; phone: full-screen sheet)
Title "Design my flat". Body scrolls (`.dialog-body`), foot fixed (`.dialog-foot`). Sections,
each folded to one summary line once filled (tap to open). Remembered per project in IndexedDB.

1. **Who lives here.** Steppers: Adults, Children (each with an age: Baby, Preschool, Primary,
   Teen), Elderly (each with: Walks unaided, Uses a stick, Uses a walking frame, Uses a
   wheelchair). Checks: Live-in helper, Pets (text). "Anything else about you" (the layouts'
   free-text "Who lives here", kept for its placeholder).
2. **How you live.** Work from home: No one / One person / Two people. Cooking: Light / Daily /
   Heavy (heavy keeps the kitchen closable: a glass sliding door rather than fully open).
   "We often have guests" check. The eight layout wishes (`WISHES`), reused.
3. **Style.** Cards: Scandinavian, Japandi, Warm modern, Modern minimalist, Industrial,
   Modern luxe, Heritage (rosewood and Peranakan accents), Let the designer choose (default).
   "Colours you like or don't" (text, e.g. "no dark colours, love sage").
4. **Budget.** "Renovation budget (hacking, carpentry, floors, paint, electrical)": Under
   S$30k / S$30–50k / S$50–80k / Over S$80k / Not sure (default) / Custom (low, high). Help:
   "Loose furniture isn't priced."
5. **Keep.** Walls: "Keep all walls" / "Change walls HDB normally allows" (default) / "Also
   suggest structural changes (needs HDB approval)". Furniture in the flat (a list of its pieces
   by room; shown only when it has some): each Leave out (default) / Bring along / Keep where
   it is. "Anything else to keep" (text).
6. **Room by room.** One row per room of the starting level (not shelter, ledge, bathrooms):
   name, a use select (Let the designer decide (default), Keep as it is, Master bedroom,
   Bedroom, Kids' room, Parents' room, Guest or flexi room, Study, Walk-in wardrobe, Living,
   Dining, Kitchen, Store) and a one-line wish.
7. **Extras.** "Add suggested electrical points" (on). "Start from": Your renovation (default
   when there is one) / The flat as it is.

Foot: [Cancel] [Next: check the cost]. Phone: the foot sticks above the keyboard
(`visualViewport`).

### 2. Cost check (confirm step, same dialog)
Shown before every run whose high estimate is US$0.50 or more, before the first run in a tab
whatever its size, and before any run that would pass the tab's limit. Smaller runs show their
price on the button that starts them instead (see Iteration). Copy in [Copy](#copy).

Controls: **Quality**: Thorough (default: layout step high effort, rooms medium) / Quicker and
cheaper (layout medium, rooms low). The estimate updates. [Edit prices] opens AI settings at
the price table. [Back] [Design my flat · about US$1.40].

### 3. Running (the Designer panel)
The panel opens in the details column (desktop, as Suggested points does; a selection still
shows its own details) or as a bottom sheet at half height (phone, drag to full). The stage
shows the design as it arrives (preview, below).

- Steps list, each with its state (waiting, running with a spinner, done with its tokens,
  failed with its reason, skipped):
  - "Reading your plan" (local, instant)
  - "Layout and style"
  - one row per space ("Living and dining", "Main bedroom", …)
  - "Checking clearances, walkways, delivery and cost" (local)
- Under the running step, the model's latest thinking summary line (Claude), as the trace does.
- Running total (polite live region, updated at most every 2 s): "38,900 tokens · about
  US$0.61 so far · estimate US$1.40". Tokens of a step still streaming carry "~".
- [Stop] (always visible; Esc on desktop).
- As each space finishes, its furniture and paint appear in the preview.

### 4. Result: versions (Designer panel)
- A strip of version tabs "V1 · V2 · V3", newest selected; phone: swipe between cards.
- The selected version card:
  - **Name** and summary ("Warm Japandi for three generations"), the palette as 3–6 swatches
    with names, a mood line, up to five reasons.
  - **Numbers:** "Renovation about S$48,000–71,000 · within your budget" (or "about S$9,000 over
    your top figure"); "14 changes to walls and doors"; "3 problems · 6 fixed for you".
  - **Rooms:** one row per space: name, use, a one-line intent, item count, and three lock
    toggles (Furniture, Built-ins, Paint and floor) plus, at the top, Walls. Tapping a row's
    name fits the room in the preview.
  - **Problems** (worst first) each with [Show], and **Fixed for you** (folded) and **Left out**
    (refused ops and dropped pieces, in words).
  - **Usage:** "Made in 2 min 40 s · 88,410 tokens (12,300 from cache) · US$1.21" (details
    unfold per step).
  - Actions: [Preview] (default on) [Compare] [Accept…] [Change something] […] (Rename,
    Delete version, Copy as text).

### 5. Preview
- Selecting a version shows it in the stage as the level (plan, 3D, walk, 3D compare with
  Before), read-only: tools other than Select, Measure and Walk are disabled.
- A bar replaces the renovation bar: "Previewing V2, not in your plan yet" [Accept…]
  [Back to my plan]. Esc or Back returns to the version that was shown before.
- Clearance zones, walkway bars and delivery routes draw on the preview as on the plan.
- New and changed walls draw as in After (hacked red hatch, new accent); designed pieces and
  points are normal pieces, so the preview looks exactly like the plan will.

### 6. Compare
[Compare] shows up to three columns over the stage: Before (always first), then two versions
picked by checkboxes (default: the selected and the previous one). Each column: the plan drawn
at one shared scale (`MiniLayout` style, rooms tinted by floor finish, furniture outlines),
then style, renovation cost, changes, problems. Tap a column to preview it. Phone: one column
at a time with a segmented control Before / V1 / V2, swiping between them.

### 7. Accept (dialog)
Title "Put V2 into your renovation". A checklist:
- **Walls and doors** (all or nothing): "Hack 2 walls, build 1, 1 glass partition, 2 doors."
- Per space: **Furniture** (n pieces), **Built-ins** (n, with foot runs), **Paint and floor**,
  **Electrical points** (n).
- Rules: a space whose shape depends on the version's walls can't take furniture, built-ins or
  points without the walls; its checks are disabled with "Needs the walls from V2". Paint for a
  wall face that won't exist without the walls is skipped silently.
- What it replaces: "Replaces 7 pieces in Living and dining." Pieces placed by hand since the
  last accept (or in a renovation never accepted from a design) are kept unless "Also remove
  the 2 pieces you placed yourself" is ticked.
- If the plan changed since the version was made: "Your plan has changed since V2 was made.
  It has been checked again on the plan as it is now:" and the difference (ops that no longer
  apply, pieces moved by repair).
- [Cancel] [Accept 11 changes]. One undo step ("Use design V2"), starting a renovation if
  there is none. The view switches to After. Toast: "Design V2 is in your renovation." [Undo].
- A structural change in what's accepted shows the existing warning toast with Undo.

### 8. Change something (iteration composer, in the panel)
- **What to change:** "Whole design" (default) or a space (select); then aspects as toggle
  chips: Walls, Furniture, Built-ins, Paint and floors (all on for Whole design; Furniture,
  Built-ins and Paint and floors for a space).
- **Feedback** textarea, placeholder "e.g. make the kitchen open, cheaper, more storage for the
  parents". Quick chips that add a sentence: Cheaper · More storage · Brighter · More open ·
  Simpler · Kid-friendly · Safer for an elderly parent (shown when the brief has elders).
- Locks from the version card apply; parts edited by hand since accepting are listed as
  "Kept as you changed them: Sofa (moved), Living wall (repainted)" with × to unlock each.
- Button: "Make V3 · about US$0.18" (the typical estimate). The cost check opens first when the
  rules in step 2 say so.
- Changing walls refurnishes the spaces whose outline changes: the composer says "Changing
  walls redoes the rooms they touch: up to 3 more steps." and the estimate includes them.

## Copy

All amounts from the estimator, shown as "US$" with two decimals under US$10, else whole
dollars. Token counts with thousands separators. Model names as the person typed them.

**Cost check (whole flat):**
> **This uses a lot of AI tokens**
> Designing the whole flat takes **5 requests** to **Claude (claude-opus-5-5)** with your key:
> one for the layout and style, then one for each of 4 rooms. Your provider bills your account
> for them, not us.
>
> **About 61,000 tokens, about US$0.87.** At most US$1.97, if every step thinks at full length.
>
> This tab so far: US$0.35 of your US$5.00 limit.
>
> Sent from this browser to Anthropic: your plan's walls, rooms and furniture, and this brief.
> Not your plan image or the plan's name.
>
> Prices are list prices for this model as of Nov 2026, not your bill. Your provider's dashboard
> shows what you're charged.

- Over the limit, added in `--warning`: "This would take you past your US$5.00 limit for this
  tab." and the button reads "Design anyway · about US$0.87".
- Unknown price: "We don't have prices for "my-model". Enter them in AI settings to see the
  cost. **About 61,000 tokens.**" and "Your limit can't be checked without prices."
- Large plan (input over 60,000 tokens): "This plan is large, so each step sends more." Over
  180,000 input tokens in one step: the run is refused: "This plan is too large to design in
  one go. Design a few rooms at a time (Change something ▸ a room)."

**Running:** "Step 3 of 5: Main bedroom…" (steps count requests only) · "38,900 tokens · about US$0.61 so far · estimate
US$1.40".

**Limit reached during a run** (the run pauses before its next step):
> **You've reached your US$5.00 limit for this tab**
> The design has spent US$1.12 so far. Finishing it takes about US$0.40 more.
> [Stop here, keep what's done] [Finish the design]

**Done:** "Done in 2 min 40 s · 88,410 tokens (12,300 from cache) · US$1.21."

**Stopped:** "Stopped. Kept 3 of 5 steps. The step that was cut off may still be billed (up to
about US$0.20)." [Finish the design · about US$0.45]

**Rate limit:** "Anthropic is limiting requests from your key. Waiting 20 s, then trying again
(1 of 2)…"
**Quota or credit used up:** "Your key has run out of quota or credit. Steps already done are
kept. Top up with your provider, then [Finish the design]."
**Key refused:** "The key was refused. Check it in AI settings." [AI settings] (steps done kept).
**Step failed:** "Main bedroom: the model's answer couldn't be read." [Try this room again ·
about US$0.12]
**Refused by the model:** "Main bedroom: the model declined this request."

**Left out (refused ops), one line each:**
- "Hack the wall between Kitchen and Household shelter: household shelter walls can't be
  changed. HDB doesn't allow it."
- "Hack the wall between Bedroom 2 and Living: a structural wall. Tick "Also suggest structural
  changes" in the brief to allow it."
- "Close up the window in Bedroom 2: windows stay."
- "Change the wall between Bath/WC 1 and Main bedroom: bathroom walls stay (wet area)."
- "Change any wall: you asked to keep all walls."
- "Sink cabinet: the sink stays in the kitchen's wet area."
- "Floor lamp "lamp2": not in the catalogue."

**Fixed for you:** "Moved the wardrobe 0.35 m along the wall to clear the door." · "Narrowed
the built-in wardrobe to 1.50 m to fit the wall." · "Turned the dining table to keep 0.90 m to
the bedrooms."

**Problems** reuse the clearance, walkway and delivery wording, plus:
- "Bedroom 3 has no window. A bedroom needs one for light and air."
- "The door to Parents' room is 0.80 m; 0.85 m lets a walking frame or wheelchair through."
- "About S$9,000 over your top figure. Try "Cheaper"."

**AI settings additions:** "Limit for this tab: [US$5.00 ▾] (US$1, 2, 5, 10, 20, No limit).
Spent this tab: US$1.21 [Reset]". "Prices per million tokens" (input, cached input, output) for
the model in use, [Reset to list prices], "as of Nov 2026".

## Data shapes

All in core (`packages/core/src/designer/`): zod schemas, and the same as closed JSON schemas
with every property required (nullable where optional), as `LAYOUT_SCHEMA` does. Enums are
lower-cased before parsing (`lowerEnums`). Limits are enforced by zod after parsing (providers'
strict modes don't all support `maxItems`/`maxLength`): over-long strings are cut, over-long
arrays truncated, with a note.

```ts
// The brief (stored; reuses the layouts' Brief fields).
DesignBrief {
  household: { adults: number; children: ('baby'|'preschool'|'primary'|'teen')[];
               elders: ('walks'|'stick'|'frame'|'wheelchair')[]; helper: boolean;
               pets: string; text: string };
  lifestyle: { wfh: 0 | 1 | 2; cooking: 'light' | 'daily' | 'heavy'; guests: boolean };
  wishes: string[];                         // WISHES
  style: StyleId | 'designer'; colours: string;
  budget: { low: number; high: number } | null;   // S$
  walls: 'keep' | 'allowed' | 'structural';
  keep: { items: Record<string, 'bring' | 'in-place'>; text: string };  // absent = leave out
  rooms: Record<string, { use: RoomUse | 'keep' | 'designer'; wish: string }>;
  electrical: boolean;
  start: 'after' | 'before';
  quality: 'thorough' | 'quick';
}
RoomUse = 'master' | 'bedroom' | 'kids' | 'parents' | 'guest' | 'study' | 'walk-in'
        | 'living' | 'dining' | 'kitchen' | 'store';

// Step 1 answer: layout and style.
Concept {
  name: string;                 // ≤ 40
  summary: string;              // ≤ 300
  style: { name: string; mood: string;            // ≤ 40, ≤ 300
           palette: { name: string; hex: string;  // #rrggbb
                      use: 'walls' | 'feature' | 'wood' | 'accent' | 'floor' }[] };  // 3–6
  walls: LayoutOp[];            // ≤ 20; the layouts' ops; rename_room is not used here
  rooms: { at: Pt; name: string; use: RoomUse; intent: string;   // at: inside, after the walls
           floor: string;       // a FLOOR_FINISHES id
           paint: string }[];   // the room's default wall finish
  bathrooms: { at: Pt; floor: string; paint: string }[];  // finishes only, no furniture
  reasons: string[];            // ≤ 5, each ≤ 160
  notes: string[];              // ≤ 5
}

// Step 2 answer, one per space.
SpaceDesign {
  items: {
    ref: string;                // ≤ 12, the model's own label ("bed1"), for feedback and locks
    assetId: string;            // catalogue id or the person's own model id (mdl_…)
    keep: string | null;        // an existing piece's id, when bringing it along
    wall: string | null;        // a wall of this space it backs onto
    along: number | null;       // m from the face's start (vertex a end) to its centre; null = centred
    at: Pt | null;              // its centre, when not against a wall
    rotation: number | null;    // degrees clockwise; 0 = its front faces +y (down the plan)
    width: number | null; depth: number | null; height: number | null;  // m; null = as catalogued
    why: string;                // ≤ 120
  }[];                          // ≤ 40
  faces: { wallId: string; finish: string }[];  // a face towards this space: feature walls
  notes: string[];              // ≤ 3; e.g. "To open the kitchen I'd need to change walls."
}

// Stored per version in IndexedDB (never in the project).
Design {
  id: string; projectId: string; levelId: string;
  n: number;                    // V1, V2…; per project, max + 1
  name: string; parent: string | null; createdAt: string;
  base: { variant: 'before' | 'after'; fingerprint: string };   // hash of walls, vertices,
                                                                 // openings, rooms, items, finishes
  baseLevel: Level;             // the level it was designed on (for re-checking and hand edits)
  brief: DesignBrief;
  request: { scope: Scope; feedback: string; locks: Lock[] };
  concept: Concept | null;
  spaces: Record<SpaceKey, { name: string;
    status: 'done' | 'failed' | 'cancelled' | 'skipped' | 'locked' | 'copied';
    design?: SpaceDesign; error?: string }>;
  usage: Usage[];
  accepted: { at: string; parts: Part[]; level: Level } | null;   // After as accepted
}
Scope  = { kind: 'all' } | { kind: 'aspects'; aspects: Aspect[] }
       | { kind: 'space'; space: SpaceKey; aspects: Aspect[] };
Aspect = 'walls' | 'furniture' | 'built-ins' | 'finishes';
Lock   = { space: SpaceKey | '*'; aspect: Aspect; by: 'person' | 'hand-edit'; label: string };
Part   = { aspect: 'walls' } | { space: SpaceKey; aspect: Aspect | 'electrical' };
Usage  { step: string; provider: Provider; model: string; input: number; cachedInput: number;
         cacheWrite: number; output: number; reasoning: number | null;
         estimated: boolean; usd: number | null; ms: number }

// Worked out from a Design, never stored.
DesignResult { level: Level; spaces: Space[]; refused: Note[]; repaired: Note[];
               dropped: Note[]; problems: Problem[]; cost: CostEstimate;
               points: Suggestion[]; budget: 'within' | 'over' | 'unknown' }
```

**Spaces** (`spacesOf(level)`): rooms joined by room boundaries form one space (the sample's
Living and dining with its Dry kitchen); rooms joined by a door or passage are separate. Left
out: `roomKind` 'none' (shelter, ledge), bathrooms (finishes only, from the concept), and rooms
under 3 m² (paint from the concept, no call). `SpaceKey` is the sorted ids of its rooms in the
designed level; spaces are matched across versions and to the plan by where they are (the
`matchRooms` rule on each room's inside point).

**What the model is sent** (`designContext`, extending `planForModel`): units and axes; north
and each room's window directions ("windows face W"); ceiling height; walls (id, ends, thickness,
rooms either side, `status`: shelter, structural, likely, outside, wet, free, and glass or half
height); openings (id, kind, wall, t, width, style, which room a door swings into and how deep);
rooms (id, name, `roomKind`, area, outline to 2 dp, windows); kept and brought pieces (id, kind,
size, room, position, keep state); the lift preset; the brief in words; the catalogue compactly
(id, name, category, w × d × h, against-wall, built-in, resizable), filtered per space by kind
(bedroom: Bedroom, Storage, Lighting, Decor, Built-in wardrobe; living: Living, Dining, Storage,
Lighting, Decor, Built-in TV console and shoe cabinet; kitchen: Kitchen, Dining, Built-in kitchen
runs; study: Bedroom desks, Storage, Lighting; other: all but People and Bathroom) plus the
person's own models. A room step gets the space's faces (wall id, which side faces the space,
ends, length, kind, its openings as stretches with sills and door sweeps) instead of the whole
plan's walls, and the concept's style and that space's intent. No image.

**Prompt order for caching:** stable first (rules, catalogue, brief, the plan as designed, the
concept), the step's own ask last. Claude: `cache_control` on the stable block; the first room
step runs alone so later ones read the cache, then two at a time. OpenAI and Gemini cache
matching prefixes automatically. Core memoises `designContext` per fingerprint, so iterating
in the same tab within the provider's cache life (Claude: 5 minutes) reads the same prefix.

## Validation and repair (core, deterministic)

`designResult(base, before, design, opts) → DesignResult`. Pure, seeded ids (an id function
passed in), independent of record order. Before decides wall statuses (as the guard does).

**Walls (concept ops, applied with `applyLayout`'s rules, extended):**
1. Shelter walls: always refused, whatever the brief. Outside walls, walls with windows,
   bathroom walls: refused. Windows: never closed up.
2. Structural and likely: refused unless `walls: 'structural'`; then applied and flagged.
3. `walls: 'keep'`: every op refused.
4. New walls: 0.1 m, on the axes within 2°, ends snapped onto existing walls within 0.15 m,
   else refused. New doors ≥ 0.75 m (bathroom 0.65), clamped to the wall.
5. Room names and uses from `rooms[].at`; a point in no room is refused; the shelter can't be
   renamed or given a use.
6. The designed level must pass `renovationBreaches` with no shelter breach; if one slips
   through, the whole concept's walls are dropped and listed (belt and braces; the store's
   guard is the third line).

**Furniture (per space, in this order):**
1. Unknown `assetId` → dropped. `keep` must name a piece the brief brings; "in place" pieces are
   copied as they are and never moved.
2. Size: catalogue pieces 0.6–1.6× per axis (beds keep their catalogue size: choose the bed
   kind), built-ins 0.30 m to the clear face length wide, full-height built-ins to the ceiling.
3. Against a wall: the wall must border the space; the piece backs onto the face towards the
   space (`placeFurniture`), at `along` clamped into a clear stretch (between inside corners, not
   across a doorway or passage, not into a door's sweep for tall pieces, under a window only if
   lower than the sill less 20 mm). No clear stretch on that face → the next longest face of the
   space that fits, else dropped.
4. Free-standing: `at` inside the space with the footprint inside it; else moved inwards up to
   0.3 m, else dropped. Non-finite or off-plan numbers fail the zod parse (dropped).
5. Wet area: sink and hob cabinets must stand inside Before's kitchen rooms; else dropped.
6. Clashes, by `clearanceIssues` on the whole designed level, pieces in priority order (kitchen
   runs and built-ins, beds, wardrobes, sofas and tables, desks, chairs and side tables, lamps
   and decor). For each piece with an overlap (> 40 mm), into-a-wall, or door-sweep issue, try in
   order and take the first that clears its issues without adding any: slide along its wall in
   5 cm steps up to ±0.6 m; for free pieces, move up to 0.4 m in the four axis directions, then
   turn 90°; for built-ins and rugs, narrow by up to 20%. Still clashing → the lower-priority
   piece of the pair is dropped and listed.
7. Walkways (`walkwayReport`): for each pinch under its need, try the same moves on the blamed
   pieces, keeping a move only if the route widens. Otherwise it stays a problem.
8. Zone shortfalls (wardrobe front, bed sides, chairs) are not repaired beyond step 6; they're
   problems, as in the plan (advice, never blocking).
9. Finishes: `finish` must be a `PAINTS` or `WALLPAPERS` id or `paint-#rrggbb`; floors a
   `FLOOR_FINISHES` id; otherwise the concept palette's walls colour (as `paint-#…`), then white,
   with a note. A face finish only on the side towards its space; faces of bathrooms take the
   concept's bathroom paint; the shelter's faces stay as they are.
10. Electrical (brief on): `suggestPoints(level, { statusOf: before })` on the result.
11. Budget: lines from `costEstimate(before, level, rates)` plus `electricalLines`; 'over' when
    the low total exceeds the brief's high figure.

**Problems listed** (worst first): clearance issues, walkway pinches, delivery for each new
deliverable piece (`deliveryCheck` from `entranceDoor` with `site.lift`), bedrooms (use or
`roomKind` bedroom) without a window, doors to an elder's room and to the nearest bathroom
under 0.85 m when an elder uses a frame or wheelchair (0.80 m with a stick), structural changes
(banner), over budget.

**Bounded:** the whole result for the sample with 40 pieces under 300 ms (median of 7 under
`PERF=1`, three times that otherwise). Repairs try at most 60 positions a piece.

## Calls, streaming and tokens

**Steps.** 1: Layout and style (`Concept`; Claude effort high or medium by quality, max_tokens
24,000). 2: each space (`SpaceDesign`; effort medium or low, max_tokens 12,000), the first alone,
then two at a time (one after any 429). A failed step's JSON is retried once at once (counted
and shown); `max_tokens` reached is retried once at the next lower effort.

**Streaming for all three providers** (the runner, `apps/web/src/ai/designer/run.ts`): Claude as
now (`messages.stream`); OpenAI chat completions with `stream: true` and
`stream_options: { include_usage: true }`; Gemini `streamGenerateContent?alt=sse`. Every step
has its own AbortController under the run's; Stop aborts them all. The quiet timeout (120 s
without an event) applies per step.

**Estimate before running** (`estimateRun`, core, pure): for each step, input tokens =
ceil(prompt characters ÷ 3.2) of the prompt actually built (the room prompts from the starting
plan's spaces); typical output per step from a table (layout 8,000 thorough / 4,000 quick; room
5,000 / 2,500, thinking included); high = the step's max_tokens. Typical assumes cache reads for
the stable prefix from the second room step on, where the provider caches; high assumes none.
Retries are not in the estimate (shown when they happen).

**Prices** (`PRICES` in `credentials.ts`, US$ per million tokens, `asOf: '2026-11'`; overridable
per browser in `dhd-ai-prices`). Starting values, to be checked against each provider's pricing
page when this is built (the Claude rows are Anthropic's list prices; cache writes at 1.25× input):

| Model | Input | Cached input | Cache write | Output (and thinking) |
|---|---|---|---|---|
| claude-opus-5-5 | 4.00 | 0.20 | 5.00 | 20.00 |
| claude-sonnet-5-5 | 2.00 | 0.20 | 2.50 | 10.00 |
| claude-haiku-5-5 (≤ 100k prompt; 0.50 / 2.50 above) | 0.10 | 0.01 | 0.125 | 0.50 |
| gpt-5 | 1.25 | 0.125 | – | 10.00 |
| gpt-5-mini | 0.25 | 0.025 | – | 2.00 |
| gemini-2.5-pro (≤ 200k prompt) | 1.25 | 0.31 | – | 10.00 |
| gemini-2.5-flash | 0.30 | 0.03 | – | 2.50 |

A model not in the table (matched by exact id, then by the longest listed prefix) has no price.
No prices are fetched.

**Actual usage** (`usageOf(provider, response)`):
- Claude: `message_start.message.usage` (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`) and the final `message_delta.usage.output_tokens`.
- OpenAI: the last chunk's `usage` (`prompt_tokens`, `prompt_tokens_details.cached_tokens`,
  `completion_tokens`, `completion_tokens_details.reasoning_tokens`).
- Gemini: the last chunk's `usageMetadata` (`promptTokenCount`, `cachedContentTokenCount`,
  `candidatesTokenCount`, `thoughtsTokenCount`; output billed = candidates + thoughts).
- A step aborted or failed before its usage arrives counts input as estimated and output as the
  streamed characters ÷ 3.2, `estimated: true`, shown with "~".

**Meter and limit.** Every text call through `askForJson` or the designer runner (trace, layouts,
designer) adds its usage to the tab's meter (`dhd-ai-spend` in sessionStorage: US$ and tokens).
Image renders aren't counted ("Renders aren't counted"). The limit (`dhd-ai-cap`, localStorage,
default US$5) is soft: the cost check warns before a run that could pass it (by its high
estimate), and a running design pauses before its next step once the meter passes it. Calls
already in flight finish.

**Rate limits and errors.** 429 with `retry-after` (or 15 s, then 30 s): wait with a countdown,
at most two waits per step, then the step fails. A quota or billing error (OpenAI
`insufficient_quota`, Anthropic credit or billing errors, Gemini RESOURCE_EXHAUSTED with a
quota reason) stops the run. 529 or 5xx: one retry after 10 s. 401/403: stop. Offline: stop.
Every stop keeps finished steps and offers [Finish the design], which runs only the steps not
done.

## Iteration

- **A new version every time.** An iteration makes V(n+1) from the version shown: locked and
  out-of-scope parts are copied from it (status `copied`), only the asked parts are generated.
- **Scopes and calls:** a space with any of Furniture, Built-ins, Paint and floors: one room
  step. Paint and floors for the whole design: one call returning faces and floors for every
  space (a finishes-only schema, small output). Furniture or Built-ins for the whole design: one
  room step per unlocked space. Walls (alone or whole): the layout step, then a room step for
  each space whose outline changed and isn't locked; a locked space whose outline changed keeps
  its pieces only where they still pass the repair rules, the rest listed as conflicts.
- **What the model gets:** the version's concept (as context), the previous answer for the parts
  being redone, the feedback in the person's words, the locked parts as fixed ("These stay
  exactly as they are"), and the brief. Never the other spaces' faces for a room-only step.
- **Feedback that needs a wider scope** ("make the kitchen open" with Walls off): the model
  says so in `notes`, shown under the version with [Try again with Walls].
- **After accepting:** iteration starts from After as it is (base `after`). `handEdits(accepted
  level, After now)` lists, per space and aspect, pieces moved, resized, added or removed, faces
  repainted, floors changed, walls changed by hand; each becomes a `hand-edit` lock (shown in
  the composer, unlockable). Accepting a later version keeps hand-placed pieces (Accept dialog).
- **A version made on an older plan** is re-checked on the plan as it is now, when previewed and
  when accepted (`designResult` on the current base); the Accept dialog lists what differs.
- **Versions** are kept up to 20 per project (oldest unaccepted removed first, with a note);
  Delete version asks nothing and has Undo in its toast for 10 s.

## Edge cases

| Case | Behaviour |
|---|---|
| Answer not JSON or fails zod | Step retried once; then failed with [Try this room again]. The layout step failing ends the run with no version; tokens spent are shown. |
| Op on a shelter wall | Refused, listed with the HDB wording; never reaches the plan. |
| Structural op, not allowed | Refused with the brief hint. Allowed: applied, flagged, banner. |
| Unknown wall, opening or piece id | That op or piece dropped and listed. |
| Pieces outside the space, NaN, 10 km away | Fail parsing or repair; dropped and listed. |
| Too many pieces (> 40 a space) or ops (> 20) | First ones kept; note "The designer suggested more than we place; the first 40 are shown." |
| Markup or very long text in names and reasons | Shown as plain text (React), cut to the limits. |
| Model refusal (Claude `refusal`, OpenAI `refusal`, Gemini SAFETY) | That step fails "declined"; others go on. |
| `max_tokens` reached | Retried once at lower effort; then failed. |
| Some spaces fail | Version saved with them "Not designed"; [Finish the design] runs only those. |
| Stop | All in-flight requests aborted; finished steps kept as "V3 (stopped)"; cut-off step's cost estimated, "~". |
| 429 rate limit | Countdown, two waits, concurrency 1, then step fails. |
| Quota, credit, key refused, offline | Run stops; done steps kept; [Finish the design] later. |
| Limit reached mid-run | Pause before the next step (copy above). |
| Plan edited during a run | The run keeps going on the level it started with; the version says "Made on the plan as it was at 14:02"; preview and accept re-check on the current plan. |
| Opening another plan during a run | "A design is running. Stop it and open the other plan?" [Stop and open] [Stay]. Finished steps are in IndexedDB. |
| Tab closed during a run | Steps are saved as they finish; the in-flight step is lost (and may be billed). |
| Two tabs on one project | Versions numbered by the highest stored n; the panel refreshes on focus. |
| IndexedDB unavailable (private window) | Versions in memory, with "Designs will be lost when you close this tab." |
| Model without a price | Tokens only; limit not checked (copy above). |
| View-only link | No designer. Edit links: allowed, versions stay in that browser. |
| Brought piece too big for its new room | Dropped and listed "Your 2.1 m sofa doesn't fit the new living room." |
| No main door | Walkway and delivery checks skipped with their existing "Add the main door…" line. |
| Accepting into a renovation with other changes | Walls part replaces After's walls with the version's (said in the dialog); other parts only touch their spaces. |
| Undo after accept | One step back to After as it was; the version is marked not accepted. |

## Phone (390 px, fingers only)

- Brief: a full-screen sheet; sections fold; steppers and chips 44 px; the foot above the
  keyboard; no sideways scroll.
- Cost check: same sheet, the estimate in large type first, the copy below.
- Running and versions: a bottom sheet at half height over the preview (the plan refits above
  it, as Suggested points does); drag up for the full card; the running total stays in the
  sheet's header while folded.
- Versions: swipe between cards; tab dots show V1…Vn.
- Preview: the bar at the top ("Previewing V2" [Accept] [Back]); 3D and walk as usual.
- Compare: one column at a time (Before / V1 / V2 segmented, swipe).
- Change something: the composer as a sheet above the keyboard (`visualViewport`); the
  quick chips scroll sideways in one row.
- Landscape phone: the panel is the right-hand column that folds to a tab, as details do.

## Storage and schema

- **No schema change.** Versions, briefs and usage live in IndexedDB `dhd-designs` (store
  `designs`, key `[projectId, id]`; store `briefs`, key `projectId`). No keys or prices are
  stored there. They are not in the project document, exports, share links, version history or
  `/api` requests. Deleting a plan in "Manage your plans" deletes its designs.
- Accepting writes ordinary data (walls, openings, room names and finishes, items, wall
  materials, points) through one `Command` (`acceptDesign(levelId, target, parts)`, built like
  `adoptLayout` with `applyLevel`), so undo, history, carry-over, sharing and the contractor
  sheet need nothing new.
- **Later, if versions must be shared** (family looking at V2 from a link): a separate resource
  like comments (`/projects/{id}/designs`, its own store and limits), not the project schema.
  Slice 3.

## Slices

**Slice 1 (L; PR 1a core, PR 1b web): design, check, iterate, accept.**
- Core: schemas (`DesignBrief`, `Concept`, `SpaceDesign`, `Design`), `designContext`,
  `spacesOf`, prompts, `designResult` (walls, placement, repair, checks, cost, points),
  `handEdits`, `acceptDesign`, `estimateRun`, `usageOf`, price maths. Fixtures of mocked answers.
- Web: brief, cost check, runner (streaming for all three providers, Stop, retries, rate limits,
  Finish the design), meter and limit in AI settings with the price table, Designer panel,
  versions in IndexedDB, preview (plan, 3D, walk, 3D compare with Before), compare columns,
  Accept dialog by aspect and space, Change something (scope, aspects, feedback, chips, locks,
  hand-edit locks), phone layouts.

**Slice 2 (M):** lock and swap single pieces ("Keep this", "Something else here"); a fix-up
round that sends the remaining problems back for one space (priced); kitchen work triangle check;
a cheaper model for room steps; synced pan and zoom in Compare and a 3D compare of two versions;
a photo-real render of a version's room through the existing renders; "Why this?" on a piece.

**Slice 3 (M–L):** share versions with family and contractors (server resource); a shopping
list with prices; mood board images; condo (MCST) rules; designing several levels.

## Acceptance criteria

Unit tests use recorded or hand-made model answers in `packages/core/src/fixtures/designer/`
and `apps/web/src/ai/designer/fixtures/`. **No test calls a real provider.**

Core (Vitest):
1. Each fixture `Concept` and `SpaceDesign` parses; over-long strings are cut and arrays
   truncated with a note; `"Remove_Wall"` and `"SWING"` parse after `lowerEnums`.
2. A concept hacking the sample's shelter wall: refused with the exact shelter line; the result
   has no shelter breach (`renovationBreaches`); other ops still apply.
3. A structural op: refused under `walls: 'allowed'` with the brief hint; applied and flagged
   under `'structural'`; under `'keep'` every op is refused with "you asked to keep all walls".
4. Ops on an outside wall, a bathroom wall and a window are refused with their lines.
5. `rooms[].at` names and uses rooms after the walls; a point in no room is refused; the shelter
   can't be renamed.
6. `spacesOf(sample)`: Living and dining with Dry kitchen as one space; Kitchen, Main bedroom,
   Bedroom separate; baths, shelter and ledge left out (4 spaces).
7. A wardrobe with `wall` and `along: null` backs onto the face towards the space (gap ≤ 1 mm),
   centred in the clear stretch, facing in.
8. An unknown `assetId` is dropped with its line; a built-in 6 m wide on a 2.4 m face is narrowed
   to the clear length with a "Narrowed…" note.
9. A wardrobe placed across the Bedroom door's sweep is slid clear; its issues are gone and the
   note gives the distance.
10. Two pieces overlapping 0.3 m that no move can separate: the lower-priority one is dropped.
11. A sink cabinet placed in the Living room is dropped with the wet-area line.
12. A walkway pinch caused by a moved-in sofa is widened by repair or listed as a problem with
    the walkway wording.
13. A new king bed that can't get through the bedroom door is listed with the delivery verdict.
14. A new wall leaving a bedroom with no window lists "has no window".
15. Brief with an elder on a walking frame: an 0.80 m door to their room lists the 0.85 m line.
16. Face finishes land on the side towards the space only; an invalid finish becomes the palette's
    walls colour with a note; the shelter's faces are unchanged.
17. Same inputs, records shuffled: the same level (deep equal), with the seeded id function.
18. `result.cost` equals `costEstimate(before, result.level, rates)` plus electrical lines;
    `budget` is 'over' when the low total passes the brief's high figure.
19. `acceptDesign` with every part: one undo step, Undo restores the project exactly; with no
    renovation it starts one; with only Living's furniture, only items in Living change; a
    space whose outline depends on the walls can't take furniture without the walls part.
20. `handEdits`: after accepting, moving one piece and repainting one face lists exactly those
    two, as locks on their space and aspect.
21. `estimateRun` on the sample with the table's claude-opus-5-5 prices gives the typical and
    high figures from the formula (to the cent); an unknown model gives tokens and `usd: null`;
    `quick` lowers both.
22. `usageOf` reads each provider's recorded final events into `Usage`; cost uses cached and
    cache-write rates; Gemini output counts thoughts.
23. A room-only iteration's prompt contains that space's faces, the feedback and the locked
    parts, and no other space's faces; the stable prefix is byte-identical across the steps of
    one run.
24. `designResult` for the sample with 40 pieces: under 300 ms (median of 7 under `PERF=1`,
    three times otherwise).

Web unit (Vitest, mocked providers, fake timers):
25. The runner calls the layout step, then the first space alone, then two at a time; a 429
    with `retry-after: 20` waits 20 s and retries at most twice, dropping to one at a time.
26. A quota error stops the run with done steps kept; Finish the design calls only the missing
    steps.
27. Stop aborts every in-flight request (their signals are aborted) and records the cut-off
    step as estimated.
28. The meter adds every step's usage in sessionStorage; passing the limit pauses the run before
    the next step; Finish continues, Stop keeps the partial version.

E2e (Playwright; providers mocked with `page.route` on `api.anthropic.com`,
`api.openai.com` and `generativelanguage.googleapis.com` serving recorded streams; any request
to those hosts that no fixture answers fails the test):
29. Sample: the brief, then the cost check shows the model name, "5 requests", "about US$" and
    "At most US$"; Back and Cancel send no request.
30. A run ticks its steps in order, the running total rises, and the done line shows tokens
    equal to the fixtures' usage sum and the US$ from the price table.
31. During and after the run, the preview shows the designed pieces and paint in plan and 3D;
    Back to my plan restores the plan; the downloaded project file is unchanged until Accept.
32. The fixture's shelter op is listed in Left out with the exact line; the shelter wall is
    unchanged in the preview.
33. Accept with everything ticked: After shows; the change list has the version's wall changes;
    the plan details' cost estimate updates; one Undo restores; the toast's Undo does the same.
34. Accept only Living and dining's furniture: only pieces there change.
35. Change something ▸ Kitchen, Furniture only, feedback "more storage": exactly one provider
    request, whose body contains "more storage" and the kitchen's faces and no other space's;
    V2 appears beside V1; Compare shows Before, V1 and V2.
36. After accepting, move the sofa by hand, then iterate on the whole design: the composer lists
    "Sofa (moved)"; the request marks it fixed; V3's sofa is where it was moved to.
37. Limit set to US$0.50: the cost check shows the limit line; mid-run the pause dialog appears;
    Stop here keeps the done steps.
38. A 429 (`retry-after: 1`) then success: "Waiting 1 s…" shows, then the step completes.
39. Stop mid-run: "Stopped. Kept 2 of 5 steps."; Finish the design sends only the remaining
    requests.
40. Reload: versions are listed and preview; the stored records contain no key (IndexedDB read
    in the test).
41. OpenAI and Gemini: one full mocked design each, with usage read from their final chunks.
42. A view-only link has no designer entry.
43. Phone, 390 px, fingers only: brief, cost check, run, swipe versions, preview, accept, change
    something; no sideways page scroll; targets ≥ 44 px; the composer stays above the keyboard.

## Out of scope

- Fetching prices, or reading the provider's real bill; image renders in the meter.
- Real products, prices of loose furniture, shopping links (slice 3; ideas row 14).
- Moving bathrooms, kitchens' wet areas, windows, the main door or the shelter; plumbing, gas,
  ceilings and lighting design beyond points; tiles on walls; curtains and blinds.
- Condo (MCST) rules, landed homes, several levels.
- Sending the plan image; designing from photos of the flat.
- A server-side proxy or keeping keys with an account; sharing versions (slice 3).
- Approvals: the design is advice; hacking still needs an HDB permit through an HDB-registered
  contractor (the existing footer line).
