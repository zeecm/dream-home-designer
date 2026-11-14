import { furnitureKind } from '../furniture';
import type { Level } from '../schema';
import { lockCovers } from './handEdits';
import { type Person, type Role, peopleOf, roleOf, seatsOf } from './principles';
import { checkSig } from './report';
import { piecesNoWorse } from './resolve';
import { type DesignOptions, type DesignResult, type ResultCheck, designResult } from './result';
import { type DesignInput, type DesignItem, LIMITS, type SpaceDesign } from './schema';
import { roomIdAt } from './spaces';
import { personLabel } from './talk/firstMeeting';
import { pieceWords } from './talk/probe';
import { clean } from './util';

/**
 * Free fixes (spec docs/specs/designer-listens.md §3, lead decisions "Free fixes: a post-pass on
 * the answer"): when a P1 must-have check fails (someone without a bed, seats under the
 * household's need, no dining table, no desk for someone working from home), the app adds the
 * missing catalogue piece to the answer itself, as an ordinary answer item whose ref starts
 * `app:`, and places the version again with `designResult` (the solver's usual budgets). The
 * new answer is kept only if strictly fewer hard checks fail, no new failure signature appears
 * (house rules, kept pieces and HDB rules included), and no piece is left out, short of room or
 * moved that wasn't before (`piecesNoWorse`; an extra such as a bedside table may make room).
 * At most two tries a space: every missing essential together, then the one that matters most
 * alone (beds first). Pure, and deterministic: it reads only the failing
 * checks, never the brief alone, so it never invents a requirement the checks don't have.
 * `solveSpace` and `designResult` are untouched, so a version where nothing fails is placed
 * exactly as before.
 */

/**
 * The piece that heads each must-have, by its check's code: the one whose decline waives it. A
 * supporting piece declined (a dining chair, an armchair) only stops the app adding that piece
 * again; the must-have itself is still fixed, reported and asked about (tech lead S2).
 */
const HEADS: Record<string, string> = {
  bed: 'bed',
  seats: 'sofa',
  dining: 'dining-table',
  desks: 'desk',
};

/**
 * Whether a must-have check (`P1|bed|room|…`) is one the person chose (a Decision: they left
 * the app's bed out of that room): theirs, never a failure to fix there. A decline lasts for
 * that room until its Decision is deleted.
 */
export function isDeclined(
  key: string,
  roomId: string,
  declined: readonly { room: string; role: string }[],
): boolean {
  const [principle, code] = key.split('|');
  const head = principle === 'P1' && code ? HEADS[code] : undefined;
  return !!head && declined.some((d) => d.room === roomId && d.role === head);
}

/** The ref prefix of the app's own pieces. A model's ref never has it (`parseSpaceDesign`). */
export const APP_REF = 'app:';
export const isAppRef = (ref: string | null | undefined): boolean =>
  !!ref && ref.startsWith(APP_REF);

/** The checks a free fix answers: P1's must-haves, by code. */
const ORDER = ['bed', 'seats', 'dining', 'desks'];
const ESSENTIAL = new Set(ORDER);

/** A piece the app added, and the check it is for. */
export interface FreeAdd {
  /** The stored answer's key (the space). */
  space: string;
  ref: string;
  assetId: string;
  roomId: string;
  role: Role;
  /** The check key it answers. */
  key: string;
}

/** A missing essential the app couldn't place, in the person's words (with numbers). */
export interface FreeMiss {
  space: string;
  roomId: string;
  key: string;
  assetId: string;
  role: Role;
  text: string;
}

/** A piece of the answer the app took out: a dining chair with no table, a bedside with no bed. */
export interface FreeRemove {
  space: string;
  ref: string;
  assetId: string;
  roomId: string | null;
  role: Role;
}

export interface FreeOutcome {
  /** The version's answers with the kept additions (the input's own object when none). */
  spaces: DesignInput['spaces'];
  added: FreeAdd[];
  /** Orphans taken out (`FreeOptions.orphans`): only pieces this answer added. */
  removed?: FreeRemove[];
  missed: FreeMiss[];
  /** Extras of the answer that no longer fit once the app's pieces went in (said with them). */
  gaveWay: { space: string; ref: string; assetId: string }[];
  /** Placings tried (each a `designResult`). */
  tries: number;
}

/** A piece's reason once it gave way for the app's: "Made way for the queen bed the app placed." */
export const madeWayFor = (assetId: string) =>
  `Made way for the ${freeName(assetId)} the app placed.`;
/** Whether an answer's piece gave way for the app's (its reason says so). */
export const madeWay = (why: string | null | undefined) =>
  /^Made way for the .+ the app placed\.$/.test(why ?? '');

/** "one bedside table no longer fits and is left out" (without a full stop). */
export function gaveWayWords(lost: readonly { assetId: string }[]): string {
  const names = lost.map((l) => `one ${freeName(l.assetId)}`);
  const list =
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} no longer ${names.length > 1 ? 'fit and are' : 'fits and is'} left out`;
}

export interface FreeOptions {
  /** Only these spaces (by result or stored key); every designed space when absent. */
  spaces?: readonly string[];
  /** Pieces the person left out before (by room and role): never offered again. */
  declined?: readonly { room: string; role: string }[];
  /**
   * The refs of pieces the answer carries over from the one it changes, by space: theirs, so
   * never an extra that may give way ("no worse" leaves out only what this answer added).
   */
  theirs?: Readonly<Record<string, readonly string[]>>;
  /**
   * Also take out the answer's orphans (criterion 12): a dining chair with no dining table or
   * desk in its space, a bedside table with no bed. Never a kept piece, one carried over
   * (`theirs`), the app's own, or one another piece goes with. A run's free pass asks for it;
   * the card's dry run doesn't (its Undo only takes pieces out again).
   */
  orphans?: boolean;
}

/** What a free fix is judged by: the version's failing hard checks and its pieces. */
interface Side {
  keys: Set<string>;
  sigs: Set<string>;
  dropped: number;
  soft: number;
  broken: number;
}

/**
 * Extras a room can do without (as the benchmark counts them): a bedside table with no room by
 * a new bed's head, a lamp, a rug. One of these may make room for a missing essential; any other
 * piece left out, moved or narrowed is worse.
 */
const EXTRAS = new Set<Role>(['bedside', 'side-table', 'light', 'decor', 'rug', 'coffee-table']);

function sideOf(r: DesignResult, design: DesignInput, theirs: FreeOptions['theirs'] = {}): Side {
  const hard = r.checks.filter((c) => c.hard && !c.already);
  const answerItem = (n: { ref?: string; space?: string }) => {
    const s = r.spaces.find((x) => x.key === n.space);
    const items = (s?.storedKey && design.spaces[s.storedKey]?.design?.items) || [];
    return { stored: s?.storedKey ?? null, item: items.find((i) => i.ref === n.ref) };
  };
  const counts = (n: { ref?: string; space?: string }) => {
    if (!n.ref) return true;
    const { stored, item: a } = answerItem(n);
    // A piece kept by its alias, carried over from the answer it changes, or the app's own
    // always counts.
    if (!a || a.keep || isAppRef(n.ref)) return true;
    if ([n.space, stored].some((k) => !!k && theirs[k]?.includes(a.ref))) return true;
    return !EXTRAS.has(roleOf(furnitureKind(a.assetId)));
  };
  return {
    keys: new Set(hard.map((c) => c.key)),
    sigs: new Set(hard.map((c) => checkSig(r, c))),
    // Pieces left out that matter (the app's own included: one it can't place is no fix).
    dropped: r.dropped.filter((n) => !!n.ref && counts(n)).length,
    // The answer's own pieces moved, narrowed or turned to fit.
    soft: r.repaired.filter((n) => !isAppRef(n.ref) && counts(n)).length,
    broken: hard.filter((c) => c.principle === 'P2').length,
  };
}

/** Kept only if strictly better and no worse in any way (acceptResolve's rule, by signature). */
export function freeBetter(before: Side, after: Side): boolean {
  return (
    piecesNoWorse(before, after) &&
    [...after.sigs].every((s) => before.sigs.has(s)) &&
    after.keys.size < before.keys.size
  );
}

const BLANK: Omit<DesignItem, 'ref' | 'assetId' | 'why'> = {
  keep: null,
  wall: null,
  along: null,
  at: null,
  rotation: null,
  width: null,
  depth: null,
  height: null,
  against: null,
  faces: null,
  near: null,
  zone: null,
};

const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/** What the household calls a person ("You", "Partner", "Sophie"). */
function labelOf(p: Person, brief: DesignInput['brief']): string {
  return personLabel(p, brief);
}
interface Want {
  item: DesignItem;
  roomId: string;
  key: string;
  role: Role;
}

/** The pieces a failing must-have check needs, as answer items (refs made unique by `ref`). */
function essentialsFor(
  c: ResultCheck,
  r: DesignResult,
  rooms: readonly string[],
  answer: SpaceDesign,
  brief: DesignInput['brief'],
  ref: (stem: string) => string,
): Want[] {
  const roomId = c.roomId as string;
  const parts = c.key.split('|');
  const code = parts[1];
  const people = peopleOf(brief);
  const household = people.filter((p) => p.kind !== 'helper').length;
  const inSpace = Object.values(r.level.items).filter((it) => {
    const id = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
    return !!id && rooms.includes(id);
  });
  const kinds = inSpace.map((it) => ({ it, kind: furnitureKind(it.assetId) }));
  const byRole = (role: Role) => kinds.filter((k) => roleOf(k.kind) === role);
  const refOfRole = (role: Role) =>
    answer.items.find((a) => roleOf(furnitureKind(a.assetId)) === role)?.ref ?? null;
  const tv = refOfRole('tv');
  const make = (assetId: string, stem: string, extra: Partial<DesignItem>, why: string): Want => {
    const item: DesignItem = { ...BLANK, ref: ref(stem), assetId, why, ...extra };
    return { item, roomId, key: c.key, role: roleOf(furnitureKind(assetId)) };
  };
  switch (code) {
    case 'bed': {
      const who = parts[3] ?? '';
      const p = people.find((x) => x.key === who);
      const assetId =
        !p || p.kind === 'adult' || p.kind === 'helper' ? 'bed-super-single' : 'bed-single';
      const name = p ? labelOf(p, brief) : null;
      return [
        make(
          assetId,
          'bed',
          { against: 'wall', zone: 'sleep' },
          name ? `A bed for ${name}: nobody had one.` : 'A bed: the room had none.',
        ),
      ];
    }
    case 'seats': {
      const want = Math.min(household, 3);
      const seats = kinds.reduce(
        (t, k) => t + (k.kind ? seatsOf(k.kind, k.it.scale.x * k.kind.size.w) : 0),
        0,
      );
      const short = want - seats;
      if (short <= 0) return [];
      const why = `Seats for the household: ${want} needed, ${seats} placed.`;
      if (short === 1 && byRole('sofa').length) {
        return [
          make(
            'armchair',
            'chair',
            { against: 'free', zone: 'lounge', faces: tv, near: refOfRole('sofa') },
            why,
          ),
        ];
      }
      return [make('sofa-3', 'sofa', { against: 'wall', zone: 'lounge', faces: tv }, why)];
    }
    case 'dining': {
      const want = Math.min(household, 6);
      const tables = byRole('dining-table');
      const chairs = byRole('dining-chair').length + byRole('stool').length;
      const out: Want[] = [];
      let table = refOfRole('dining-table');
      if (!tables.length) {
        const t = make(
          want > 4 ? 'dining-6' : 'dining-4',
          'table',
          { against: 'free', zone: 'dine' },
          `A dining table for the household of ${household}.`,
        );
        out.push(t);
        table = t.item.ref;
      }
      for (let i = chairs; i < want; i++) {
        out.push(
          make(
            'dining-chair',
            'chair',
            { against: 'free', zone: 'dine', near: table, faces: table },
            'A chair at the dining table.',
          ),
        );
      }
      return out;
    }
    case 'desks': {
      const want = Math.max(1, brief.lifestyle.wfh);
      const desks = byRole('desk').length;
      const out: Want[] = [];
      for (let i = desks; i < want; i++) {
        const d = make(
          'desk',
          'desk',
          { against: 'wall', zone: 'work' },
          'A desk for working from home.',
        );
        out.push(
          d,
          make(
            'desk-chair',
            'dchair',
            { against: 'free', zone: 'work', near: d.item.ref, faces: d.item.ref },
            'A chair at the desk.',
          ),
        );
      }
      return out;
    }
    default:
      return [];
  }
}

/** One queen bed for a couple without one in the same room, in place of two single beds. */
function coupleBeds(wants: Want[], brief: DesignInput['brief']): Want[] {
  const people = peopleOf(brief);
  const out: Want[] = [];
  const done = new Set<Want>();
  for (const w of wants) {
    if (done.has(w) || w.role !== 'bed') continue;
    const adults = wants.filter(
      (x) =>
        x.role === 'bed' &&
        x.roomId === w.roomId &&
        !done.has(x) &&
        people.find((p) => p.key === x.key.split('|')[3])?.kind === 'adult',
    );
    if (adults.length < 2) continue;
    const [a, b] = adults as [Want, Want];
    done.add(a);
    done.add(b);
    const names = [a, b].map((x) => {
      const p = people.find((q) => q.key === x.key.split('|')[3]);
      return p ? labelOf(p, brief) : '';
    });
    out.push({
      ...a,
      item: {
        ...a.item,
        assetId: 'bed-queen',
        why: `A bed for ${andList(names)}: nobody had one.`,
      },
    });
  }
  return [...out, ...wants.filter((w) => !done.has(w))];
}

/** The piece's name as said ("queen bed", "3-seat sofa"). */
export const freeName = (assetId: string): string => {
  const k = furnitureKind(assetId);
  return k ? pieceWords(k.name).toLowerCase() : 'piece';
};

const m2 = (v: number) => `${v.toFixed(2)} m`;
const an = (w: string) => (/^[aeiou8]/i.test(w) ? `an ${w}` : `a ${w}`);

/** Why a piece couldn't be placed, in the person's words, from the try that left it out. */
function missText(
  r: DesignResult,
  was: ReadonlySet<string>,
  w: Want,
  space: string,
  room: string,
): string {
  const name = freeName(w.item.assetId);
  const note = r.dropped.find((n) => n.ref === w.item.ref && n.space === space);
  if (note?.code === 'no-wall' && note.need !== undefined && note.longest !== undefined) {
    return `No ${name} fits in ${room}: the longest free wall is ${m2(note.longest)}, and ${an(name)} needs ${m2(note.need)}.`;
  }
  if (note?.code === 'no-wall') {
    return `No ${name} fits in ${room}: the walls long enough for it are taken by other pieces.`;
  }
  if (note) return `No ${name} fits in ${room}: it had no place clear of the other pieces.`;
  // Placed, but at a cost: how many other checks it would fail, and the first in the app's words.
  const worse = r.checks.filter((c) => c.hard && !c.already && !was.has(c.key));
  // What blocks it, first, with one of the checks it would break as an example (QA).
  const first = worse[0]?.text.replace(/\.$/, '');
  const example = first ? `${first[0]?.toLowerCase()}${first.slice(1)}` : '';
  return worse.length
    ? `The app didn’t place ${an(name)} in ${room}: it would only fit by breaking ${
        worse.length === 1
          ? `another check${example ? `: “${example}”` : ''}`
          : `${worse.length} other checks${example ? `, such as “${example}”` : ''}`
      }.`
    : `The app didn’t place ${an(name)} in ${room}: it would leave other pieces out.`;
}

/**
 * The free fixes for a version on `base`: each designed space whose must-have checks fail gets
 * the missing pieces, kept only when they make it strictly better. Spaces in turn, each from
 * what the spaces before it kept.
 */
export function freeEssentials(
  base: Level,
  before: Level,
  design: DesignInput,
  opts: DesignOptions = {},
  o: FreeOptions = {},
): FreeOutcome {
  let current = design;
  let r = designResult(base, before, current, opts);
  const added: FreeAdd[] = [];
  const missed: FreeMiss[] = [];
  let tries = 0;
  const gaveWay: FreeOutcome['gaveWay'] = [];
  const declined = new Set((o.declined ?? []).map((d) => `${d.room}|${d.role}`));
  for (const s of r.spaces) {
    const key = s.storedKey;
    if (!key || s.status !== 'done') continue;
    if (o.spaces && !o.spaces.includes(s.key) && !o.spaces.includes(key)) continue;
    const answer = current.spaces[key]?.design;
    // Answers by position (v1) too: the app's piece is placed against the longest free wall, as
    // the v1 placer does, and is kept only by the same rule (strictly better, nothing worse).
    if (!answer) continue;
    // Never where the person kept the furniture (a lock, or changed by hand since accepting).
    const held = (design.request?.locks ?? []).some(
      (l) => l.aspect === 'furniture' && (l.space === '*' || lockCovers(l, s.rooms)),
    );
    if (held) continue;
    const failing = r.checks.filter((c) => {
      const code = c.key.split('|')[1] ?? '';
      return (
        c.hard &&
        !c.already &&
        !c.unfixable &&
        c.principle === 'P1' &&
        ESSENTIAL.has(code) &&
        !!c.roomId &&
        s.rooms.includes(c.roomId)
      );
    });
    if (!failing.length) continue;
    // A role the app already placed for here and couldn't keep isn't added twice.
    const appRoles = new Set(
      answer.items
        .filter((a) => isAppRef(a.ref))
        .map((a) => roleOf(furnitureKind(a.assetId)) as string),
    );
    const used = new Set(answer.items.map((a) => a.ref));
    const ref = (stem: string) => {
      let n = 1;
      let out = `${APP_REF}${stem}`;
      while (used.has(out)) out = `${APP_REF}${stem}${++n}`;
      used.add(out);
      return out;
    };
    const wants = coupleBeds(
      failing.flatMap((c) => essentialsFor(c, r, s.rooms, answer, current.brief, ref)),
      current.brief,
    ).filter(
      (w) =>
        // Never a piece they left out there, nor what goes with a must-have they declined.
        !declined.has(`${w.roomId}|${w.role}`) &&
        !isDeclined(w.key, w.roomId, o.declined ?? []) &&
        !appRoles.has(w.role),
    );
    if (!wants.length) continue;
    // Two tries at most: every missing essential together, then the one that matters most
    // alone (beds, then seats, a dining table, desks) with what goes with it.
    const codeOf = (w: Want) => w.key.split('|')[1] ?? '';
    const first = ORDER.find((c) => wants.some((w) => codeOf(w) === c));
    const alone = wants.filter((w) => codeOf(w) === first);
    const sets = alone.length < wants.length ? [wants, alone] : [wants];
    // The answer's bedside tables that go with no bed of its own (their bed was left out, or
    // never asked for): placed before the app's bed, they can take the walls it needs (the
    // owner's replay: a merged Master bedroom, its bedsides against the long wall, and the queen
    // bed then only by a desk chair's way). When the bed doesn't fit as they stand, they go by
    // the app's bed instead; failing that, they make way for it. Never taken out as orphans
    // while a bed for the room's sleepers can be placed (essentials first, orphans after).
    const bedWant = wants.find((w) => w.role === 'bed');
    const refs = new Set(answer.items.map((a) => a.ref));
    const bedRefs = new Set(
      answer.items.filter((a) => roleOf(furnitureKind(a.assetId)) === 'bed').map((a) => a.ref),
    );
    // Only this answer's own: a kept piece or one carried over (theirs) is never moved or lost.
    const theirsHere = new Set([...(o.theirs?.[key] ?? []), ...(o.theirs?.[s.key] ?? [])]);
    const loose = bedWant
      ? answer.items.filter(
          (a) =>
            roleOf(furnitureKind(a.assetId)) === 'bedside' &&
            !a.keep &&
            !theirsHere.has(a.ref) &&
            !isAppRef(a.ref) &&
            !(a.near && refs.has(a.near) && bedRefs.has(a.near)),
        )
      : [];
    const looseRefs = new Set(loose.map((a) => a.ref));
    const withBeds = sets.find((set) => set.some((w) => w.role === 'bed'));
    type Try = { set: Want[]; items: SpaceDesign['items']; madeWay: string[] };
    const tryList: Try[] = sets.map((set) => ({ set, items: answer.items, madeWay: [] }));
    if (bedWant && withBeds && loose.length) {
      tryList.push(
        {
          set: withBeds,
          items: answer.items.map((a) =>
            looseRefs.has(a.ref) ? { ...a, near: bedWant.item.ref } : a,
          ),
          madeWay: [],
        },
        {
          set: withBeds,
          items: answer.items.filter((a) => !looseRefs.has(a.ref)),
          madeWay: [...looseRefs],
        },
      );
    }
    const was = sideOf(r, current, o.theirs);
    let kept: { wants: Want[]; r: DesignResult; design: DesignInput; madeWay: string[] } | null =
      null;
    let lastTry: DesignResult | null = null;
    for (const t of tryList) {
      // The last try (the bedsides made way): each put back by the bed, one at a time, while
      // it breaks nothing the bed alone didn't (one bedside, as a tight room allows).
      if (t.madeWay.length && kept === null) {
        const nextOf = (items: SpaceDesign['items']): DesignInput => ({
          ...current,
          spaces: {
            ...current.spaces,
            [key]: {
              ...(current.spaces[key] as DesignInput['spaces'][string]),
              design: { ...answer, items: [...items, ...t.set.map((w) => w.item)] },
            },
          },
        });
        let items = t.items;
        let next = nextOf(items);
        tries++;
        let rn = designResult(base, before, next, opts);
        lastTry ??= rn;
        if (!freeBetter(was, sideOf(rn, next, o.theirs))) continue;
        const madeWay = [...t.madeWay];
        for (const side of loose) {
          const more = [...items, { ...side, near: bedWant?.item.ref ?? side.near }];
          const n2 = nextOf(more);
          tries++;
          const r2 = designResult(base, before, n2, opts);
          const a = sideOf(rn, next, o.theirs);
          const b = sideOf(r2, n2, o.theirs);
          const placed = !r2.dropped.some((d) => d.space === key && d.ref === side.ref);
          if (
            placed &&
            piecesNoWorse(a, b) &&
            [...b.sigs].every((x) => a.sigs.has(x)) &&
            b.keys.size <= a.keys.size
          ) {
            items = more;
            next = n2;
            rn = r2;
            madeWay.splice(madeWay.indexOf(side.ref), 1);
          }
        }
        kept = { wants: t.set, r: rn, design: next, madeWay };
        break;
      }
      const next: DesignInput = {
        ...current,
        spaces: {
          ...current.spaces,
          [key]: {
            ...(current.spaces[key] as DesignInput['spaces'][string]),
            design: { ...answer, items: [...t.items, ...t.set.map((w) => w.item)] },
          },
        },
      };
      tries++;
      const rn = designResult(base, before, next, opts);
      lastTry ??= rn;
      if (freeBetter(was, sideOf(rn, next, o.theirs))) {
        kept = { wants: t.set, r: rn, design: next, madeWay: t.madeWay };
        break;
      }
    }
    const room = (id: string) => r.level.rooms[id]?.name ?? s.name;
    if (kept) {
      // The extras of the answer that gave way (a bedside table with no room by the new bed's
      // head): said with the piece, on its row and wherever the app says what it placed.
      const was = new Set(r.dropped.map((n) => `${n.space}|${n.ref}`));
      const items = kept.design.spaces[key]?.design?.items ?? [];
      const lost = kept.r.dropped.flatMap((n) => {
        const a = n.ref && !isAppRef(n.ref) ? items.find((i) => i.ref === n.ref) : undefined;
        return a && n.space === s.key && !was.has(`${n.space}|${n.ref}`)
          ? [{ space: key, ref: a.ref, assetId: a.assetId }]
          : [];
      });
      current = kept.design;
      if (lost.length) {
        // Said once, in the card's left-out line (UX, B2): each piece that gave way says what it
        // made way for, as data on the answer ("Made way for the queen bed the app placed.").
        const head = kept.wants[0]?.item;
        const said = head ? madeWayFor(head.assetId) : '';
        const gone = new Set(lost.map((l) => l.ref));
        const d = current.spaces[key]?.design;
        if (d) {
          current = {
            ...current,
            spaces: {
              ...current.spaces,
              [key]: {
                ...(current.spaces[key] as DesignInput['spaces'][string]),
                design: {
                  ...d,
                  items: d.items.map((i) =>
                    gone.has(i.ref) ? { ...i, why: clean(said, LIMITS.why) } : i,
                  ),
                },
              },
            },
          };
        }
        gaveWay.push(...lost);
      }
      // The answer's bedsides that made way for the app's bed (its last try): said as such.
      for (const ref of kept.madeWay) {
        const a = answer.items.find((i) => i.ref === ref);
        if (a) gaveWay.push({ space: key, ref: a.ref, assetId: a.assetId });
      }
      r = kept.r;
      for (const w of kept.wants) {
        added.push({
          space: key,
          ref: w.item.ref,
          assetId: w.item.assetId,
          roomId: w.roomId,
          role: w.role,
          key: w.key,
        });
      }
    }
    // What wasn't placed: said with why, from the first try (every piece together).
    for (const w of wants) {
      if (kept?.wants.includes(w)) continue;
      // A chair at the app's own table or desk goes with it: said once, with it.
      if (isAppRef(w.item.near)) continue;
      missed.push({
        space: key,
        roomId: w.roomId,
        key: w.key,
        assetId: w.item.assetId,
        role: w.role,
        text: missText(lastTry ?? r, was.keys, w, key, room(w.roomId)),
      });
    }
  }
  const removed: FreeRemove[] = [];
  if (o.orphans) {
    for (const s of r.spaces) {
      const key = s.storedKey;
      if (!key || s.status !== 'done') continue;
      if (o.spaces && !o.spaces.includes(s.key) && !o.spaces.includes(key)) continue;
      const answer = current.spaces[key]?.design;
      if (!answer) continue;
      const held = (design.request?.locks ?? []).some(
        (l) => l.aspect === 'furniture' && (l.space === '*' || lockCovers(l, s.rooms)),
      );
      if (held) continue;
      const out = orphansOf(r, s, key, answer, o.theirs?.[key] ?? o.theirs?.[s.key] ?? []);
      if (!out.length) continue;
      const gone = new Set(out.map((x) => x.ref));
      const next: DesignInput = {
        ...current,
        spaces: {
          ...current.spaces,
          [key]: {
            ...(current.spaces[key] as DesignInput['spaces'][string]),
            design: { ...answer, items: answer.items.filter((i) => !gone.has(i.ref)) },
          },
        },
      };
      tries++;
      const rn = designResult(base, before, next, opts);
      const was = sideOf(r, current, o.theirs);
      const now = sideOf(rn, next, o.theirs);
      // The free pass's rule, with the orphans counted: no more hard failures (a chair with no
      // table fails one, so it usually goes down), none new, and nothing else worse.
      if (
        piecesNoWorse(was, now) &&
        [...now.sigs].every((x) => was.sigs.has(x)) &&
        now.keys.size <= was.keys.size
      ) {
        current = next;
        r = rn;
        removed.push(...out);
      }
    }
  }
  // Essentials first, orphans after, and once more where the orphans made room: the answer this
  // returns is one a dry run (the card's Place … · free) would place nothing more in, so the
  // card never offers what the run refused.
  const roomed = [...new Set(removed.map((x) => x.space))].filter((k) =>
    missed.some((m) => m.space === k),
  );
  if (roomed.length) {
    const again = freeEssentials(base, before, { ...design, spaces: current.spaces }, opts, {
      ...o,
      orphans: false,
      spaces: roomed,
    });
    tries += again.tries;
    if (again.added.length) {
      current = { ...current, spaces: again.spaces };
      added.push(...again.added);
      gaveWay.push(...again.gaveWay);
      for (let i = missed.length - 1; i >= 0; i--)
        if (roomed.includes(missed[i]?.space ?? '')) missed.splice(i, 1);
      missed.push(...again.missed);
      // A bedside taken out "with no bed" where a bed then went in made way for it instead.
      const bedIn = new Set(again.added.filter((a) => a.role === 'bed').map((a) => a.space));
      for (let i = removed.length - 1; i >= 0; i--) {
        const x = removed[i];
        if (x && x.role === 'bedside' && bedIn.has(x.space)) {
          removed.splice(i, 1);
          gaveWay.push({ space: x.space, ref: x.ref, assetId: x.assetId });
        }
      }
    }
  }
  return {
    spaces: current.spaces,
    added,
    ...(removed.length ? { removed } : {}),
    missed,
    gaveWay,
    tries,
  };
}

/** What an orphan needs in its space to belong: a table (or a desk) for a chair, a bed. */
const BELONGS: Partial<Record<Role, Role[]>> = {
  'dining-chair': ['dining-table', 'desk'],
  bedside: ['bed'],
};

/**
 * The answer's orphans in a space: a dining chair with no dining table or desk anywhere in it, a
 * bedside table with no bed. Only pieces this answer added (no keep, not carried over, not the
 * app's), and never one another piece faces or goes beside.
 */
function orphansOf(
  r: DesignResult,
  s: DesignResult['spaces'][number],
  key: string,
  answer: SpaceDesign,
  theirs: readonly string[],
): FreeRemove[] {
  const inSpace = Object.values(r.level.items).filter((it) => {
    const id = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
    return !!id && s.rooms.includes(id);
  });
  const roles = new Set(inSpace.map((it) => roleOf(furnitureKind(it.assetId))));
  const pointed = new Set(answer.items.flatMap((i) => [i.near, i.faces].filter(Boolean)));
  const placedRoom = (ref: string) => {
    const id = Object.keys(r.refs).find((k) => r.refs[k] === ref && r.level.items[k]);
    const it = id ? r.level.items[id] : undefined;
    return it ? roomIdAt(r.level, { x: it.position.x, y: it.position.z }) : null;
  };
  return answer.items.flatMap((a): FreeRemove[] => {
    const role = roleOf(furnitureKind(a.assetId));
    const needs = BELONGS[role];
    if (!needs || a.keep || isAppRef(a.ref) || theirs.includes(a.ref) || pointed.has(a.ref))
      return [];
    if (needs.some((n) => roles.has(n))) return [];
    return [{ space: key, ref: a.ref, assetId: a.assetId, roomId: placedRoom(a.ref), role }];
  });
}

/**
 * The app's line for the orphans it took out of a space: "Took out 2 dining chairs the answer
 * added in Living and dining, with no table to go with them."
 */
/**
 * The app's line for the answer's pieces taken out to make room for the app's bed (they are no
 * longer in the answer, so no left-out line can say them): "Took out a bedside table the
 * designer added in Master bedroom to make room for the queen bed the app placed."
 */
export function madeWayLines(out: FreeOutcome, spaceName: (key: string) => string): string[] {
  const lines: string[] = [];
  for (const key of new Set(out.gaveWay.map((g) => g.space))) {
    const items = out.spaces[key]?.design?.items ?? [];
    const gone = out.gaveWay.filter((g) => g.space === key && !items.some((i) => i.ref === g.ref));
    const bed = out.added.find((a) => a.space === key && a.role === 'bed');
    const first = gone[0];
    if (!first || !bed) continue;
    const name = freeName(first.assetId);
    const what = gone.length === 1 ? an(name) : `${gone.length} ${name}s`;
    lines.push(
      `Took out ${what} the designer added in ${spaceName(key)} to make room for the ${freeName(bed.assetId)} the app placed.`,
    );
  }
  return lines;
}

export function orphanLines(removed: readonly FreeRemove[], spaceName: (key: string) => string) {
  const groups = new Map<string, FreeRemove[]>();
  for (const x of removed) {
    const k = `${x.space}|${x.role}`;
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()].map((g) => {
    const first = g[0] as FreeRemove;
    const n = g.length;
    const name = freeName(first.assetId);
    const what = n === 1 ? an(name) : `${n} ${name}s`;
    const lacks = first.role === 'bedside' ? 'no bed' : 'no table';
    return `Took out ${what} the designer added in ${spaceName(first.space)}, with ${lacks} to go with ${n === 1 ? 'it' : 'them'}.`;
  });
}
