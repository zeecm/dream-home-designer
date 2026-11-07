# Spec: Storage meter

Project-manager, 7 Nov 2026. Roadmap "Planned" item 1. It builds on
[carpentry and cost](carpentry-cost.md) (built-in pieces, foot runs, the wardrobe rate),
[my furniture](my-furniture.md) (pieces by size and shape) and the
[ageing parents check](ageing-parents.md) (a per-browser household choice that moves into
the project with schema 11). Overall effort **M**, in two PRs plus a small part of schema 11.
**Slice 1 needs no schema change.**

**Problem.** "Not enough storage" is the most common complaint after an HDB renovation. Owners
size the wardrobe to the wall left over, not to the family, and find out on moving day that
the shoes don't fit by the door, the kitchen has no room for bulk buys and the luggage has
nowhere to go. A 4-room BTO has no store room, only the household shelter. Owners can't judge
"is 1.8 m of wardrobe enough for us two?" from a plan. This meter adds up what is drawn and
compares it, room by room, with what a household like theirs usually needs, in words and
sizes they already use (metres and foot runs, pairs of shoes).

## User stories
- As an owner, I see at a glance whether my plan has room for our clothes, shoes, kitchen
  things and everything else, for the people who will live here.
- I see it room by room: "Main bedroom: 1.20 m of wardrobe for two; about 2.00 m is usual."
- I tell it who sleeps where in a few taps (it guesses from the beds) and whether we own a
  little or a lot.
- When I add or resize a wardrobe, the meter changes at once, and a shortfall is given in foot
  run and dollars, as my carpenter will quote it.
- I compare Before and After to see what the renovation's carpentry gains.
- I copy a summary into the family chat.

## Decisions

**Value order** (value to owners against effort and risk):

| # | Item | Value | Effort | Schema | PR |
|---|---|---|---|---|---|
| A | Measure the pieces already in the catalogue: clothes, shoes, kitchen, everything else | Highest. The whole point; works on every plan today. | S+ | none | 1 |
| B | Household: guessed from the beds, edited per bedroom; "how much we own" | High. Without it there is nothing to compare with. | S | none | 1 |
| C | Panel, room chips on the plan, Inspector line, shortfall priced, Before/After, Copy | High. | S+ | none | 1 |
| D | New catalogue pieces Singapore owners use for storage: storage beds, platform bed, tall pantry, study and display cabinet, bay window seat | Medium-high. A hydraulic storage bed is the usual answer for a small HDB bedroom. | S+ | none | 2 |
| E | The household saved in the project (a share link sees the same) | Medium. | S− | part of **11** | with ageing slice 2 |

**Split.**
1. **PR 1 (M−): slice 1, A to C.** Pure core report plus web. No catalogue or schema change.
2. **PR 2 (S+): slice 1b, D.** Catalogue only, with their prices. A catalogue id is not a
   schema field.
3. **Slice 2 (S−): E.** Folded into the ageing check's schema 11 (one `household` object, one
   bump). Tech-lead to confirm. If ageing slice 2 has already shipped by then, this is
   schema 12 on its own.

**Where the household lives (slice 1).** Per browser, per project: localStorage
`dhd-storage-<projectId>` = `{ people: { [roomId]: { adults, children } }, others: { adults,
children }, amount: 'few' | 'typical' | 'lots', shelter: boolean }` (core `StorageSetting`, read
leniently by `parseStorageSetting`: counts clamped to 0–6, junk back to the default; the key is
removed when the value is the default). A separate key from
`dhd-ageing-<projectId>`, so the ageing check (being built now) isn't touched. They share an
object only when both move into the project (slice 2): `Project.household` gains `people`,
`others`, `amount` and `shelter` beside `check`, `bedroomId`, `bathroomId` and the flat type.
Not shared now on purpose: the two keys hold unrelated choices, and merging them mid-build
risks the ageing PR for no user gain.

**Measured, not counted.** We don't model rails, shelves or drawers inside a wardrobe (the
elevation view, Planned #2, is where that belongs). We measure what owners buy and
carpenters quote: wardrobe width, shoe cabinet shelves, kitchen cabinet fronts, cupboard
volume. Every number is advice; nothing ever blocks an edit.

## Sources

| Code | Source | Checked |
|---|---|---|
| **NDSS** | UK DCLG, *Technical housing standards: nationally described space standard* (2015, updated 2016), Table 1 and notes, <https://www.gov.uk/government/publications/technical-housing-standards-nationally-described-space-standard/technical-housing-standards-nationally-described-space-standard> | Read, 7 Nov 2026 |
| **ADG** | NSW, *Apartment Design Guide* (2015), objective 4G: storage besides kitchens, bathrooms and bedrooms, studio 4 m³, 1 bed 6, 2 bed 8, 3+ bed 10; at least half inside the apartment, <https://planning.nsw.gov.au/government-architect-nsw/housing-design/apartment-design-guide> | From several compliance tables quoting it; the guide's own text **not read** |
| **BW** | Boston Wardrobes, *Reach-in design guide*: 1800 mm per person, 600 mm deep, double hang needs 2.1 m, shoes 180–200 mm (women's) and 230–250 mm (men's) of shelf per pair on 300 mm deep shelves, <https://archipro.co.nz/assets/MemberUploads/Boston-Reach-in-Design-Guide.pdf> | Read (PDF text), 7 Nov 2026. A manufacturer's guide, generous by design |
| **NKBA** | NKBA kitchen planning guidelines: total shelf and drawer frontage 1400" (35.6 m) for a kitchen under 150 sq ft (13.9 m²), 1700" medium, 2000" large; subtotals may move if the total holds | From secondary pages quoting it (e.g. <https://simplycabinetry.squarespace.com/design-guidelines-nkba>); how NKBA counts shelves **not verified** |
| **SG** | Singapore retailer sizing guides: master bedroom wardrobes are usually 1.8–2.4 m (6–8 ft), about 0.6 m deep, e.g. <https://home.lazada.sg/wardrobe-cupboard-dimensions-for-hdb-master-and-common-bedrooms-sg/> | Search summaries of retailer guides; consistent but not authoritative |
| **MHA** | MHA, second reading wrap-up, Civil Defence Shelter and Fire Safety (Misc. Amendments) Bill: the household shelter may be used for storage, but kept usable, no permanent fixtures, <https://www.mha.gov.sg/media-room/newsroom/second-reading-of-the-civil-defence-shelter-and-fire-safety-miscellaneous-amendments-bill-wrap-up-speech/> | Search summary only; the speech text **not read** |
| **PM** | Project-manager's estimates from Singapore practice | **Not verified**; each such number is one constant in core, easy to change |

No Singapore code sets storage for homes. HDB doesn't publish one. So the targets are a
blend: UK and Australian minimums for the floor, Singapore wardrobe practice for the
middle, and a manufacturer's guide for "lots". The panel says so in one line.

## How storage is measured

Core `storageOf(item, ctx)` gives each piece's contribution to four measures, from a
`storage` class on its catalogue kind (`hanging`, `folded`, `shoes`, `base`, `base-run`, `sink`,
`wall`, `volume`; the models' set in `tools/models/catalogue.json`; a guard test fails for a
Storage, Built-in or Kitchen piece without one). `ctx` is `{ kind: RoomKind, sleeps }`. A piece is
in the room that holds its footprint's centre; if that is in a wall or a doorway, the room just
in front of it (centre + front × (d/2 + 0.1)); only then "Not in a room". Rooms are traced once
per change to the walls, corners or rooms (a drag shares them), and each item's room is kept by
the item object.

| Measure | Unit | What counts | How |
|---|---|---|---|
| **Clothes** | metres of wardrobe front (and ft run) | `wardrobe`, `built-in-wardrobe`; `chest-of-drawers`; a My-furniture `cabinet` shape at least 1.5 m tall and 0.5 m deep **in a room someone sleeps
in** (a bedroom, or a room with a bed or people: a studio) | Wardrobe: its width, if at least 1.5 m tall. Under 0.5 m deep (hangers can't hang across): half its width. Under 1.5 m tall: not clothes, goes to Everything else. Chest of drawers: half its width (folded clothes). |
| **Shoes** | pairs | `shoe-cabinet`, `built-in-shoe-cabinet` (not in a kitchen) | `floor(width / 0.22)` pairs per shelf × `floor((height − 0.10) / 0.18)` shelves. 0.22 m per pair is the middle of BW's 0.18–0.25; the 0.10 m plinth and 0.18 m shelf pitch are **PM**. So the 0.8 × 1.0 m cabinet holds 15 pairs and the full-height 0.9 × 2.6 m one 52. |
| **Kitchen** | metres of shelf and drawer front (NKBA's measure) | `kitchen-base`, `kitchen-hob`: width × 2. `kitchen-sink`: width × 1 (the pipes take the rest). `built-in-kitchen-base`: width × 2; when the level has no `kitchen-sink`, the widest run loses
0.8 m (one level over the sink), once per level and never below 0. `kitchen-wall`, `built-in-kitchen-wall`: width × `max(1, round(h / 0.35))` (0.7 m → 2). A `built-in-shoe-cabinet` in a room of kind kitchen is a **pantry**: width × `max(1, round((h − 0.10) / 0.35))` (2.6 m → 7). | Levels per cabinet are **PM** (NKBA counts each shelf and drawer; our level counts are typical HDB carpentry). Kitchen pieces count wherever they stand (an open kitchen in "Living and dining" still counts). The fridge is not counted. |
| **Everything else** | m³ (luggage, toys, bulk buys, the vacuum, books) | Top cabinets of any wardrobe over 2.2 m tall: w × d × (h − 2.1). `bookshelf`, `cube-bookcase`, `steel-shelves`, `steel-shelves-narrow`, `shelf-with-drawers`, `chinese-cabinet`, `tv-console`, `tv-console-slatted`, `built-in-tv-console`. A wardrobe under 1.5 m tall. A My-furniture `cabinet` not counted as clothes. The household shelter and any store room. | Pieces: outer w × d × h. Shelter (`SHELTER_ROOM`) and store rooms (name matches `/\bstor(e|age)\b|storeroom/i`: "Store",
"Storage room", "Storeroom"): **1 m³ per m² of floor** (the room's area to wall centre lines, a
PM figure that overstates a thick-walled shelter a little; racks on half the floor, 2 m high, **PM**), the shelter only while "Use the shelter for storage" is on (default on). |

**Not counted:** beds, bedside tables, nightstands, desks (even with drawers), consoles and
side tables, the vanity, fridge, washer, sofas, rugs, decor, lamps, people, My-furniture
`box`, `bed`, `sofa`, `table` shapes, and uploaded `.glb` models (we can't tell what they
are). Uploaded models are listed: "Not counted: Ikea Pax (your model). Storage can't be
told from a model."

**Rounding.** Clothes and kitchen to 0.05 m (ft run with `footRun`), pairs whole, volume to
0.1 m³. Sums use unrounded values. Divisions before a `floor` or `round` add 1e-9.

## Targets (the benchmarks)

The household picks how much it owns: **Few things · Typical (default) · Lots** ("Average" in
the first draft; UX: "Typical" reads as what most families have, not a grade).

| Measure | Few things | Typical | Lots | Basis |
|---|---|---|---|---|
| Clothes, per adult | 0.60 m | **1.00 m** | 1.80 m | Few: NDSS sets 0.36 m² of a single bedroom's built-in wardrobe and 0.72 m² of a double's aside as the wardrobe allowance, i.e. 0.60 m of a 0.60 m deep wardrobe per bed space (the reading is ours). Typical: SG, a couple's 1.8–2.4 m master wardrobe. Lots: BW, 1800 mm per person. |
| Clothes, per child (up to about 12) | 0.45 m | 0.60 m | 0.90 m | **PM** (Few: NDSS's single-bed allowance less a quarter) |
| Shoes at the door, per adult | 5 pairs | 8 | 15 | **PM** |
| Shoes, per child | 3 | 5 | 8 | **PM** |
| Shoes, for the household (slippers, guests) | 4 | 4 | 6 | **PM**. Shoes come off at the door in most Singapore homes. |
| Kitchen front, household | 4 m + 1.5 m per person | **6 m + 2 m per person** | 8 m + 2.5 m per person | **PM**, checked against a typical 4-room BTO kitchen (an L of base cabinets about 3.6 m with sink and hob, 2.1 m of wall cabinets beside the hood: about 10.6 m, short for four at 76%, enough for two). NKBA's 35.6 m for a small US kitchen is shown as a reference, not a target: US households stock more. |
| Everything else, by people 1 / 2 / 3–4 / 5+ | 2 / 3 / 4 / 5 m³ | **4 / 6 / 8 / 10 m³** | 5 / 8 / 10 / 12 m³ | Typical: ADG 4G (studio / 1 / 2 / 3+ bed, mapped to people by us). Few: ADG's half that must be inside the home. Lots: **PM**. ADG excludes bedroom wardrobes; we count wardrobe top cabinets here, since that is where HDB families put luggage. |

**Status** of each line: **Enough** at 100% or more; **Nearly** at 80–99%; under 80% the status
reads **"Needs 0.80 m more"** (the only words in amber). Compared with a 1e-6 tolerance, so 1.2 m
× 1.5 (1.7999…) against 1.80 m is Enough. ("Tight" and "Short" in the first draft: the walkway
line already says "tight", and clearances say "short of room".) **Nothing drawn** for a measure is
not a shortfall: no status word, a dashed empty bar, "No shoe cabinet drawn · about 28 pairs is
usual" and an [Add a shoe cabinet] link that arms the Furniture tool with it. No people: no
target and no status, only what is there.

**Where targets apply.**
- **Clothes:** per room with people, usually a bedroom (that room's people against that
  room's clothes), and for the home (everyone against all clothes, wherever they stand).
- **Shoes, kitchen, everything else:** for the home only. The panel lists each room's share.

**Example (furnished sample, Typical, from the beds: 2 adults in Main bedroom, 1 in Bedroom).**
Main bedroom 1.20 of 2.00 m, needs 0.80 m more. Bedroom: no wardrobe, about 1.00 m is usual.
Shoes: none drawn, about 28 pairs is usual. Kitchen 4.8 of 12.0 m (2.8 m of cabinets), needs
7.2 m more. Everything else 3.7 of 8 m³ (the TV console 0.36 plus the shelter's 3.39), needs
4.3 m³ more. The kitchen chip goes on the Kitchen (the kitchen room with the most front; the
sample also has a Dry kitchen).

## The household

**Guessed from the beds** (core `householdFromBeds(level)`), per room of any kind:
- `bed-queen`, `bed-king`, or a My-furniture `bed` at least 1.35 m wide: 2 adults;
- `bed-single`, `bed-super-single`, or a narrower `bed`: 1 adult;
- no bed: nobody.

Beds count by shape and width, not by id (`comesFlat === 'bed'` or a My-furniture `bed`), so a
queen made 0.9 m wide sleeps one and slice 1b's storage beds count for free. Single beds guess
adults (the larger target) and the intro says to change them. Rooms with people show "Guessed
from the beds" until edited.

**Edited** per room with people or of kind bedroom: "Adults [−] 2 [+]  Children [−] 0 [+]",
0–6 each. Below them, "Also living here, without a bed drawn" (adults and children, 0–6), for
someone on a sofa bed or a mattress in the study. [Reset to the beds] clears the edits.

**How much you own:** a three-way segmented control, Few things · Typical · Lots, with one
muted line under it: "Typical is what most Singapore families own. Choose Lots if your wardrobe
is full today." Below it, where the plan has a shelter, "Use the shelter for storage" (on).

## Behaviour

**Entry.**
- Plan details: one **Checks** heading holds Clearance, Electrical, Storage and Older person,
  one row each (a label, one line, one small button; the clearance row reads "Clearance", and
  Electrical has a line, "No points yet." or "12 points on the plan."). Storage's line names
  what is short or nearly, then what isn't drawn yet, e.g. "Clothes, kitchen and everything else
  could use more. No shoe cabinet drawn yet.", or "Enough for 3 people."; then [See storage], which
  replaces the plan details as Suggested points does (× and Esc close it; focus moves to its
  heading and back to the button). On a view link the row and the panel work (the viewer's own
  household); the rest of the details stay disabled.
- With no rooms: "Draw rooms first." With rooms but nobody: "You have 1.20 m of wardrobe.
  Add who lives here to compare." (said once; the meters keep their empty states).
- Intro (first open, muted): "Do you have room for everything? We add up wardrobes, shoe
  cabinets, kitchen cabinets and cupboards, and compare them with what a household like yours
  usually needs. We guessed who lives here from the beds; change it below."

**Panel** (desktop: in the right-hand panel's place; phone: the Suggested points half-height
sheet with the plan refitted above it, its footer pinned: [Copy summary] [Close], 44 px; on a
phone on its side [Copy] [Close]; the sheet's header gets a rule once its body scrolls). Order:
the finding (the summary line), the intro (first open), who lives here, the meters, how much you
own, the room cards, the notes, the disclaimer. Copy summary reads "Copied" for 2 s; a failure
says "Couldn't copy here." in sight.
1. **Who lives here**: one line, "3 people (guessed from the beds): 1 in Bedroom, 2 in Main
   bedroom [Change]", folded everywhere (unfolded only while nobody is counted). Unfolded, each
   room someone sleeps in (a bedroom, a room with a bed, or one whose people were edited, even to
   none) has stacked steppers, "Adults − 2 +" over "Children − 0 +" (32 px buttons, 44 px on a
   touch screen, labelled "More children in Bedroom"); one live line per change ("Bedroom: 1
   adult and 1 child"). People edited in the renovation for a room matched to the flat as it is
   are kept under that room's id; entries for rooms gone from the project are dropped.
2. **Four meters** for the home: Clothes, Shoes, Kitchen, Everything else. Each: the label and
   status word; a 6 px bar filled in ink with a 1 px tick at the target (`role="meter"`, its
   `aria-valuetext` the same words); "1.20 of 3.00 m (4 of 10 ft)", "15 of 28 pairs", "4.8 of
   12.0 m of shelves and drawers" with "From 2.8 m of cabinets", "3.7 of 8 m³". Enough adds
   "+0.40 m spare"; Nearly "0.20 m more is usual". Only a gap is amber (the fill and "Needs …
   more", `.warning-text`); never red, which means a physical clash. Everything else adds "About
   3 m of full-height cupboard would hold it." when it needs more, and "Most HDB flats have little
   room for bulky things. Wardrobe top cabinets, a storage bed or the shelter help."
3. **Room by room**, cards in this order: bedrooms (plan order), kitchen rooms, living rooms,
   shelter and store rooms, other rooms, then "Not in a room". Each card lists its counted
   pieces with their contribution ("Built-in wardrobe 1.80 m · top cabinets 0.5 m³") and, for
   bedrooms, its clothes line:
   - "1.20 m of wardrobe; about 2.00 m is usual. Needs about 0.80 m more: a 3 ft run, about
     $600–1,050 built in." (The card's heading names the room and its people; Copy writes "Main
     bedroom, 2 adults: …". The price is core `carpentryPrice('wardrobe', shortfall, rates)`,
     pulled out of `carpentryCost`, at the viewer's estimate rates, `dhd-rates`; in ink. Under
     0.15 m, no price: a foot run's minimum would overstate it.)
   - "No wardrobe yet; about 1.00 m is usual: a 3 ft run, about $600–1,050 built in." Enough:
     "… Enough." A room with clothes and nobody: "Nobody sleeps here; its 1.20 m of wardrobe
     counts for the whole home." (Copy names the room.) Kitchen pieces: "1.2 m of shelves and
     drawers". Targets drop a trailing ".0" ("12 m", "8 m³").
   - Tapping a piece opens its details with "‹ Back to storage", which returns to the panel where
     it was, focus on that card.
   - Short in the room but enough in the home: "Enough for the whole home: 1.20 m more stands
     in Living and dining."
   - A room with clothes but nobody: "Nobody sleeps here: 1.20 m, counted for the home."
4. **Notes** (muted): pieces not counted; "The shelter is counted as storage: keep it clear
   enough to use in an emergency, with no fixings in its walls." (MHA); kitchen: "For
   reference, US kitchen guidance asks for about 35 m in a small kitchen."
5. **Disclaimer:** "A rough guide from UK and Australian housing standards, a wardrobe
   maker's guide and Singapore practice. No Singapore rule sets storage. Count your own clothes
   and shoes if you can."
6. [Copy] gives a plain-text summary (household, four meters, room lines, disclaimer) for a
   chat. No Print in slice 1.

Tapping a room card's name pans to the room and outlines it on the plan (left out of
exports); tapping a piece line selects the piece, whose details start "‹ Back to storage".

**Before and After.** The panel reports the version shown. With a renovation, each meter adds
a muted "Before: 1.20 m", and a room card adds "+1.80 m in the renovation". The household is
by room id; a room new in After gets its people from the beds until edited.

**Plan** (desktop and phone), only while the panel or sheet is open:
- **Room chips** under the label of each room with people: "Wardrobe 1.20 of 2.00 m"; at the
  kitchen: "Shelves 4.8 of 12 m" (not "Cabinets": the fronts outnumber the run). A neutral pill,
  amber (`--pill-warning-*`) only when something drawn needs more; with nothing drawn, a dashed
  neutral pill, "No wardrobe · about 1.00 m usual" ("No kitchen cabinets"). Never the clearance
  red. On a narrow plan, 11 px and short: "1.2 of 2.0 m", "No wardrobe". Chips are drawn under
  the clearance and ageing marks, and their labels keep off the chips (as off room names).
- **Add a shoe cabinet** (and the others, where nothing is drawn; not on a view link or over a
  designer's preview) arms the piece, scrolls it into view in the catalogue, says "Shoe cabinet
  chosen. Click the plan where it goes; Esc to cancel.", and puts a bar over the plan, "Click
  (Tap) where the shoe cabinet goes · Cancel". The panel stays; once placed, it's back in Select
  with the piece counted.
- (The selected piece's contribution beside it on the plan: left out; its details say it.)
- All `data-export="skip"`: not in the PNG, print, contractor sheet, 3D or walk.

**Live.** Adding, deleting, resizing or turning a piece updates the meters in the same frame
(no grid search: a sum over items, well under 1 ms). When a counted piece is dropped or a
resize ends, the live region reads its room's line, after any clearance and ageing line.

**Inspector** (a counted piece): a **Storage** line after Clearances, e.g. "Storage: 1.80 m
of wardrobe (6 ft) and 0.5 m³ of top cabinets", "Storage: about 15 pairs of shoes", "Storage:
4.80 m of shelf and drawer front", "Storage: 0.4 m³". An uploaded model: "Not counted as
storage." Hidden for pieces that never count (a bed, a sofa).

**View links.** The panel works, with the viewer's own household and rates (per browser).

**Phone.** The sheet holds the household line and [Change], the steppers (44 px targets),
meters and cards stacked; nothing scrolls sideways; tapping a card pans the plan above the
sheet. With a tool picked (from an Add link), the catalogue shows at the top of the sheet.

## Core API (as built, `packages/core/src/storage.ts`)

The first draft's shape, kept for reference; as built: `storageOf(item, ctx: RoomCtx)`,
`StorageSetting` (zod) for the household, `meter`/`meterStatus` with status
`'enough' | 'nearly' | 'short' | 'none'` and a `gap`, `shortfallPrice`, `pieceIn`,
`storageRoomOf`, `storageReport(level, setting, alias?)` (alias: `matchRooms` for After, so a
room hacked and drawn again keeps its people) and `storageGain(before, after, match)`.

```ts
type StorageMeasure = 'clothes' | 'shoes' | 'kitchen' | 'other';
type Amount = 'few' | 'typical' | 'lots';
interface People { adults: number; children: number }
interface Household {
  people: Record<string, People>;          // by room id; missing rooms use the beds
  others: People; amount: Amount; shelter: boolean;
}
interface PieceStorage { itemId: string; clothes: number; shoes: number; kitchen: number; other: number }
type Status = 'enough' | 'tight' | 'short';
interface Meter { have: number; target?: number; status?: Status }
storageOf(item: Item, roomKind: RoomKind, level: Level): PieceStorage | null;
householdFromBeds(level: Level): Record<string, People>;
storageTargets(people: People[], amount: Amount): Record<StorageMeasure, number>;
storageReport(level: Level, household: Household): {
  people: number;                          // everyone, beds or edited, plus others
  home: Record<StorageMeasure, Meter>;
  rooms: { roomId: string; people: People; fromBeds: boolean; pieces: PieceStorage[];
           clothes?: Meter; shortfall?: number; roomStorage?: number /* shelter, store */ }[];
  outside: PieceStorage[];                 // not in a room
  notCounted: string[];                    // uploaded models
};
```

Constants (one place, for the unverified numbers): `PAIR_WIDTH` 0.22, `SHOE_PITCH` 0.18,
`SHOE_PLINTH` 0.10, `HANG_MIN_DEPTH` 0.5, `WARDROBE_MIN_HEIGHT` 1.5, `TOP_CABINET_FROM` 2.1,
`ROOM_STORE_PER_M2` 1.0, and the targets table. Divisions before a `floor` or `round` take a
1e-9 tolerance, so 0.90 / 0.18 gives 5 shelves, not 4.

## Edge cases
- **No beds and no edits:** nobody; meters show "have" only, with the "Add who lives here"
  prompt.
- **A bedroom renamed, deleted or missing in this version:** its entry is ignored (kept in
  storage, harmless); other rooms are unaffected.
- **Beds in a living room (a studio):** counted; the living room gets a clothes line.
- **A wardrobe across a room boundary or a doorway:** the room of its footprint's centre.
- **Pieces outside every room** (the corridor if it isn't a room, outside the walls): home
  totals only, under "Not in a room".
- **Two wardrobes meeting at a corner:** both at full width. The corner's dead space isn't
  deducted (out of scope).
- **A wall cabinet over a base cabinet, or a wardrobe hung over a desk:** each counts.
- **A resized free-standing wardrobe** 2.4 m tall: top cabinets above 2.1 m count as
  Everything else, as for built-ins.
- **A shoe cabinet in the kitchen** (a built-in, used as a pantry): kitchen front, no pairs.
  A free-standing `shoe-cabinet` in a kitchen still counts as shoes.
- **A kitchen with no kitchen room** (the run in "Living and dining"): kitchen front counts;
  the kitchen chip goes on the room the run is in.
- **No shelter in the plan:** no shelter line, no note. A room named "Store" in an older flat
  counts like the shelter, without the shelter note.
- **The shelter in After:** it can't change in a renovation; same volume.
- **Many people** (up to 6 per room, 6 others): targets grow linearly; Everything else stops
  at the 5+ row.
- **Very small pieces** (a 0.2 m shoe cabinet): 0 pairs, shown as "0 pairs (too narrow)".
- **Multi-level homes:** the level shown, as the ageing check. Maisonettes later.

## Out of scope
- Inside a wardrobe: rails, shelves, drawers, double hang (the elevation view, Planned #2).
- An inventory of what the family owns, or per-person wardrobes within a room.
- Bathroom storage (vanity, mirror cabinets), the service yard (washer, mops, laundry),
  balconies, fridge capacity.
- "Where could a wardrobe go?" ghosts along free walls, checked for clearance (proposed
  below).
- Saying what an uploaded model is ("count this as a wardrobe"): needs a per-item field, a
  schema change. Use My furniture's cabinet shape meanwhile.
- Storage on the contractor sheet or in the estimate (the shortfall price is a hint, not a
  line).
- Suggesting hacking for a walk-in wardrobe (the AI designer may; this meter doesn't).

## Slice 1b: storage pieces (PR 2, catalogue only)

| id | Name | Size w × d × h (m) | Counts as | Priced (rates, editable) |
|---|---|---|---|---|
| `bed-queen-storage` | Queen storage bed (lift-up) | 1.52 × 2.0 × 1.0 | bed (2 adults) + 1.52 × 1.9 × 0.25 m³ under the mattress | not carpentry |
| `bed-super-single-storage` | Super single storage bed | 1.07 × 2.0 × 1.0 | bed (1 adult) + 1.07 × 1.9 × 0.25 m³ | not carpentry |
| `built-in-platform-bed` | Platform bed with drawers | 2.0 × 2.2 × 0.45 | 2 adults (a queen mattress on top) + w × d × 0.3 m³ | new carpentry kind `platform`, per ft run of width, **$150–300, PM, not verified** |
| `built-in-pantry` | Tall kitchen pantry | 0.6 × 0.6 × ceiling | kitchen front, width × 7 | `tall` |
| `built-in-study-cabinet` | Study or display cabinet | 1.2 × 0.4 × ceiling | Everything else, w × d × h | `tall` |
| `built-in-bay-seat` | Bay window seat with storage | 1.8 × 0.5 × 0.45 | Everything else, w × d × h | `low` |

- Storage beds use the bed's clearance zones and `householdFromBeds`; the platform bed gets
  bed-side zones too (tech-lead: as its own `bed` shape).
- Bay seats suit older HDB flats and condos with bay windows; placed against the window wall.

## Slice 2: the household in the project (with ageing schema 11)
- `Project.household` gains `people?: Record<roomId, {adults, children}>`, `others?`,
  `amount?`, `shelter?` beside the ageing fields. One no-op migration, `SCHEMA_VERSION` and Go
  `SchemaVersion` 11 together, regenerated `testdata/hdb4room.json` (all in the ageing PR).
- The browser value seeds it once. View links then see the owner's household.
- Deploy the API first, then check production accepts a v11 save.

## Acceptance criteria

As built: core in `storage.test.ts` (AC 1–16 table-driven, plus the tech-lead's cases and a
50-piece timing test), words in `apps/web/src/storage/text.test.ts`, e2e in
`apps/web/e2e/storage.spec.ts` on `e2e/furnished.dreamhome.json` (core's furnished sample,
kept in step by a unit test).

### Slice 1 (PR 1)

Core (Vitest):
1. Built-in wardrobe 1.80 × 0.60 × 2.60: clothes 1.80, other 0.54 m³ (1.8 × 0.6 × 0.5).
   Free-standing `wardrobe` 1.20 × 0.60 × 2.10: clothes 1.20, other 0.
2. That wardrobe resized to 0.45 m deep: clothes 0.60. Resized to 1.20 m tall: clothes 0,
   other 0.864 m³.
3. `chest-of-drawers` (1.201 m wide): clothes 0.6005 (`toBeCloseTo`).
4. `shoe-cabinet` 0.8 × 0.35 × 1.0: 15 pairs. `built-in-shoe-cabinet` 0.9 × 2.6: 52 pairs.
   The same built-in in a room named Kitchen: 0 pairs, kitchen 6.30 m.
5. The sample's run (base 0.6, sink 0.8, base 0.6, hob 0.8): kitchen 4.80 m. A 2.4 m
   `built-in-kitchen-base` in a kitchen with no sink cabinet: 4.00 m; with a sink cabinet in
   the room: 4.80 m. A 2.4 m `built-in-kitchen-wall` (0.7 m high): 4.80 m.
6. `bookshelf` 0.8 × 0.3 × 1.8: other 0.432 m³ (shown 0.4).
7. A 2.0 m² room named "Household shelter": other 2.0 m³; `shelter` false: 0. A 1.5 m² room
   named "Store": 1.5 m³ whatever `shelter` is.
8. Bed, bedside, desk, `metal-desk`, fridge, washer, sofa, vanity: `null`. An uploaded model:
   `null` and listed in `notCounted`. A My-furniture cabinet 1.0 × 0.6 × 2.0 in a bedroom:
   clothes 1.00; in a living room: other 1.2 m³. A My-furniture box: `null`.
9. `householdFromBeds`: queen or king → 2 adults; single or super single → 1; a custom bed
   1.52 wide → 2, 1.07 → 1; two singles in one room → 2; no bed → none.
10. `storageTargets` for 2 adults and 1 child, Typical: clothes 2.60, shoes 25 (16 + 5 + 4),
    kitchen 12.00, other 8. Few things and Lots match the targets table for the same people.
11. Status at 100% enough, 80% nearly, 79.9% short; nothing drawn `none`. No people: no
    `target`, no `status`.
12. Main bedroom, queen bed, 1.20 m wardrobe, Typical: clothes `{have 1.2, target 2.0,
    status 'short'}`, `shortfall` 0.80; 3 ft priced at the default wardrobe rate is
    $600–1,050.
13. A 1.20 m wardrobe in the living room and nobody there: the living room has no clothes
    target; the home's clothes `have` includes it; a short bedroom gets the "Enough for the
    whole home" note when the home total is enough.
14. A piece whose centre is in no room goes to `outside` and the home totals only.
15. Edited people override the beds for that room only; `others` add to the home targets
    only.
16. Furnished sample, Typical, from the beds: matches the example in "Targets" (a reviewed
    snapshot). Same level twice: identical report, same order.

E2e (desktop, and a 390 px phone by finger):
17. Plan details shows the Storage row with a summary; [See storage] opens the panel with the
    intro, "Guessed from the beds" on Main bedroom (2 adults) and Bedroom (1 adult), four meters and
    room cards.
18. Add a Built-in wardrobe to Bedroom: its line goes from "No wardrobe" to "1.80 m of
    wardrobe; about 1.00 m is usual. Enough." and the room chip to a neutral "Wardrobe 1.80 of
    1.00 m", without a reload. Undo restores both.
19. Resize the Main bedroom wardrobe to 2.40 m by its handle: the card and chip show 2.40 of
    2.00 m, Enough, when the drag ends; the Inspector reads "Storage: 2.40 m of wardrobe
    (8 ft)".
20. Add a child to Bedroom with the stepper: the target rises by 0.60 m; the tag "Guessed from
    the beds" goes; the choice survives a reload; [Reset to the beds] restores it.
21. Choose Lots: every target changes to the Lots row and the choice survives a reload.
22. Turn "Use the shelter for storage" off: Everything else drops by the shelter's area; the shelter
    note goes.
23. Inspector Storage lines for a wardrobe, a shoe cabinet, a base cabinet and a bookshelf; an
    uploaded model says "Not counted as storage"; a sofa shows no line.
24. Room chips show only while the panel is open; PNG, print and the contractor sheet show
    none of it; 3D unchanged.
25. [Copy] gives the household, four meters, room lines and the disclaimer as text.
26. With a renovation adding a built-in wardrobe in After: After shows "Before: 1.20 m" and
    "+1.80 m in the renovation"; Before shows its own numbers.
27. Phone: 17–20 by finger on the sheet; steppers at least 44 px; no sideways scroll; tapping
    a room card pans the plan above the sheet.
28. A view link: the panel opens and uses the viewer's household; editing the household
    doesn't change the project (no save, no version bump).

### Slice 1b (PR 2)
29. The six pieces are in the catalogue (beds in Bedroom, the rest in Built-in), place
    against walls and draw in 3D; built-ins reach the ceiling.
30. A queen storage bed counts 2 adults and 0.72 m³ (1.52 × 1.9 × 0.25); a platform bed 2.0 ×
    2.2 counts 1.32 m³ and is priced 7 ft at the platform rate in the estimate.
31. A pantry 0.6 m wide in the kitchen adds 4.20 m of kitchen front and a tall-cabinet
    estimate line.

### Slice 2 (with schema 11)
32. A v10 document parses with no household. Edits to people, amount and shelter save in the
    project, undo, and a share link shows the same report. The browser value seeds it once.
33. Production accepts a v11 save with a household (after the API deploy, before the merge).

## New ideas this spec suggests (for `ideas.md`)
| Problem | Idea | Value | Effort |
|---|---|---|---|
| A shortfall without a place to fix it | "Where could a wardrobe go?": ghost built-ins on free walls in short rooms, sized to the shortfall, kept clear of doors, windows, sockets and clearance zones; [Add] as one undo step | High: turns the meter into an answer | M |
| Owners argue about whose things go where | Per-person wardrobes: split a wardrobe between named people and see each one's share | Medium | S+ |
| The AI designer ignores storage | Give the AI designer the household and targets, and score its versions on the meter | Medium-high, small once the meter exists | S |
