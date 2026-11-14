import {
  type Change,
  type DesignResult,
  type FreeLine,
  type FreeOutcome,
  type Project,
  type ProposalOption,
  freeName,
  furnitureKind,
  gaveWayWords,
  isAppRef,
  roleOf,
  roomIdAt,
  spacesOf,
} from '@dhd/core';
import { create } from 'zustand';
import { useStore } from '../../../store';
import { readFree, requestFree, requestResult } from '../results';
import { designOpts } from '../state';
import {
  type CardModel,
  cardChanges,
  cardRunReport,
  declinedPieces,
  madeWith,
  nowOf,
  optionCard,
} from './cards';
import { act, actProposal, newId, nowIso, say, useTalk } from './useTalk';

/**
 * The app's free fixes on a card (spec docs/specs/designer-listens.md, UX "The free fixes: shown
 * and undone"). The pieces the app placed itself are ordinary rows, tagged By the app (their
 * refs start `app:`), ticked like any other; one left out is a Decision at Accept, never on
 * untick. Place … · free asks the results worker for a dry run of the free fixes on the card as
 * it is: offered only when it would place something, it adds the pieces to the same option (no
 * new tab, no request), with a log line whose Undo takes them out again.
 */

export { declinedPieces };

/**
 * A change row the app placed itself: the piece it is about (its first: a row says a bedside
 * table or chairs with their bed or table) has an `app:` ref.
 */
export function isAppChange(c: Change, r: DesignResult): boolean {
  const head = c.items.target[0];
  return !!head && isAppRef(r.refs[head]);
}

const lower = (s: string) => (s ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s);

/**
 * "a queen bed in Main bedroom, against the wall opposite the window" from the row "Add a queen
 * bed against the wall opposite the window" in Main bedroom.
 */
export function placedWords(c: Change): string {
  if (c.verb !== 'add') {
    const name = c.name.replace(/^the /, '');
    return `${/^[aeiou8]/i.test(name) ? 'an' : 'a'} ${name} in ${c.groupName}`;
  }
  // What goes with it is the answer's own ("with a bedside table"): not said as the app's.
  const rest = c.text.replace(/^Add /, '').replace(/, with .*$/, '');
  const m = /^(an? .+?)(?=,| against | by | in front of | under | facing | beside |$)(.*)$/.exec(
    rest,
  );
  const what = m?.[1] ?? rest;
  const tail = (m?.[2] ?? '').replace(/^,\s*/, '').trim();
  return `${lower(what)} in ${c.groupName}${tail ? `, ${tail}` : ''}`;
}

/** The roles that meet each must-have check, by its code. */
const MUST_ROLES: Record<string, string[]> = {
  bed: ['bed'],
  seats: ['sofa', 'armchair'],
  dining: ['dining-table', 'dining-chair', 'stool'],
  desks: ['desk'],
};
/** A must-have, as Accept's question names it ("Accept without a bed?"). */
export const MUST_WHAT: Record<string, string> = {
  bed: 'a bed',
  seats: 'the seats',
  dining: 'a dining table',
  desks: 'a desk',
};

/**
 * The card's unticked row with the version's piece for a must-have check (a bed in that room,
 * seats or the table in that space), or null: the row the ticks leave out, whether the person
 * unticked it or the card did from the first (it fails a check of its own).
 */
export function mustHaveRow(
  check: { key: string; roomId?: string | null },
  changes: readonly Change[],
  ticked: readonly string[],
  r: DesignResult,
): Change | null {
  const code = check.key.split('|')[1] ?? '';
  const roles = MUST_ROLES[code];
  const roomId = check.roomId;
  if (!roles || !roomId) return null;
  const rooms = spacesOf(r.level).find((s) => s.rooms.includes(roomId))?.rooms ?? [roomId];
  return (
    changes.find(
      (c) =>
        !ticked.includes(c.id) &&
        c.items.target.some((id) => {
          const it = r.level.items[id];
          if (!it || !roles.includes(roleOf(furnitureKind(it.assetId)))) return false;
          const room = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
          return (
            !!room && (code === 'bed' || code === 'desks' ? room === roomId : rooms.includes(room))
          );
        }),
    ) ?? null
  );
}

/**
 * "Kept your queen bed, moved by the app to the wall by Bedroom, free": a row where the app's
 * piece stands for the person's own (moved or turned), said as theirs.
 */
export function ownedWords(c: Change): string {
  const name = c.name.replace(/^the /, '');
  if (c.verb === 'turn') return `Kept your ${name} in ${c.groupName}, turned by the app, free`;
  const where = c.text.replace(/^Move the .+?(?= to | against | by | in |,|$)/, '').trim();
  return `Kept your ${name}, moved by the app ${where || `in ${c.groupName}`}, free`;
}

/** The lead's lines for the pieces the app placed: "Placed by the app, free: a queen bed in …". */
export function freeLines(
  changes: readonly Change[],
  r: DesignResult,
  /** The rows ticked: an app row unticked is said as left out. */
  ticked?: readonly string[],
): string[] {
  return changes
    .filter((c) => c.verb !== 'remove' && isAppChange(c, r))
    .map((c) => {
      if (ticked && !ticked.includes(c.id)) {
        // The person's own piece the app moved: it stays where it stands, theirs.
        if (c.verb === 'move' || c.verb === 'turn') {
          return `Your ${c.name.replace(/^the /, '')} stays where it stands: the app’s ${c.verb} isn’t ticked.`;
        }
        return `Left out of what you’ve ticked: ${placedWords(c)}, placed by the app, free.`;
      }
      // A piece a fix round's answer dropped and the app put back (the runner says so), and an
      // extra of the answer that gave way for it (the free pass says so on its row).
      const gave = gaveWayOf(c.why);
      const more = gave ? `; ${gave}` : '';
      // The person's own piece the app's stands for (the same kind where theirs was): theirs,
      // kept and moved, never "placed".
      if (c.verb === 'move' || c.verb === 'turn') {
        return `${ownedWords(c)}${more}.`;
      }
      const head = /^Put back by the app/.test(c.why ?? '') ? 'Put back' : 'Placed';
      return `${head} by the app, free: ${placedWords(c)}${more}.`;
    });
}

/** "a queen bed and a 3-seat sofa": what the app placed itself, for the run-end announcement. */
export function freePlacedWords(changes: readonly Change[], r: DesignResult): string | null {
  const names = changes
    .filter((c) => c.verb !== 'remove' && isAppChange(c, r))
    .map((c) => {
      const id = c.items.target[0];
      const name = freeName(id ? (r.level.items[id]?.assetId ?? '') : '');
      return `${/^[aeiou8]/i.test(name) ? 'an' : 'a'} ${name}`;
    });
  if (!names.length) return null;
  return names.length === 1
    ? (names[0] as string)
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "one bedside table no longer fits and is left out", from an app piece's reason. */
export const gaveWayOf = (why: string | null | undefined): string | null => {
  const m = /(One .+? no longer fits? and (?:is|are) left out)\.?$/.exec(why ?? '');
  return m?.[1] ? lower(m[1]) : null;
};

/** The room and role of a row the app placed (its first piece), for a Decision. */
export function appRowOf(c: Change, r: DesignResult): { room: string; role: string } | null {
  const id = c.items.target[0];
  const it = id ? r.level.items[id] : undefined;
  if (!it) return null;
  const room = roomIdAt(r.level, { x: it.position.x, y: it.position.z });
  return room ? { room, role: roleOf(furnitureKind(it.assetId)) } : null;
}

/** The pieces a free fix would place that stand on their own (a table's chairs go with it). */
const heads = (out: FreeOutcome) => {
  const refs = new Set(out.added.map((a) => a.ref));
  return out.added.filter((a) => {
    const item = out.spaces[a.space]?.design?.items.find((i) => i.ref === a.ref);
    return !(item?.near && refs.has(item.near));
  });
};

const SHORT: Record<string, string> = {
  bed: 'bed',
  sofa: 'sofa',
  armchair: 'chair',
  'dining-table': 'table',
  'dining-chair': 'chair',
  desk: 'desk',
};

/** "Place a queen bed · free", "Place 3 missing pieces · free"; on the bar "Place a bed · free". */
export function freeLabel(out: FreeOutcome, short = false): string {
  const h = heads(out);
  const one = h.length === 1 ? h[0] : undefined;
  if (one) {
    const name = short ? (SHORT[one.role] ?? 'piece') : freeName(one.assetId);
    return `Place ${/^[aeiou8]/i.test(name) ? 'an' : 'a'} ${name} · free`;
  }
  return short ? `Place ${h.length} pieces · free` : `Place ${h.length} missing pieces · free`;
}

/**
 * A card's dry run of the free fixes on the plan as it is (from the worker, free): what it would
 * place and what it couldn't, or null while it is worked out or the card can't take one.
 */
export function freeOffer(project: Project, card: CardModel): FreeOutcome | null {
  if (card.kind !== 'proposal' || !card.option || card.status === 'running') return null;
  if (card.status === 'failed') return null;
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  const out = readFree(
    b.now,
    b.before,
    card.input,
    designOpts(project, card.levelId, madeWith(card)),
    { declined: declinedPieces() },
  );
  return out;
}

/** Bumped when a free fix lands on a card: the phone's sheet folds to peek to show it. */
export const useFreePlaced = create(() => ({ n: 0, card: null as string | null }));

/**
 * Must-haves each card's ticks leave out (a bed unticked), by card key: the On the table bar
 * counts them with the card's own failures.
 */
export const useTickedOut = create<Record<string, number>>(() => ({}));
/** Said by a card as it renders: written after it, and only when it changed. */
export function publishTickedOut(key: string, n: number) {
  if ((useTickedOut.getState()[key] ?? 0) === n) return;
  queueMicrotask(() => useTickedOut.setState({ [key]: n }));
}

/** Placing on a card now (the button reads "Placing…"). */
export const useFreeBusy = create(() => ({ card: null as string | null }));

/** An option with the pieces a free fix added put into its answers (the rest as it was). */
export function withFree(
  o: ProposalOption,
  out: Pick<FreeOutcome, 'added' | 'spaces'>,
): ProposalOption {
  const spaces = new Set(out.added.map((a) => a.space));
  return {
    ...o,
    spaces: Object.fromEntries(
      Object.entries(o.spaces).map(([k, s]) => {
        const d = out.spaces[k]?.design;
        if (!spaces.has(k) || !d || !s.design) return [k, s];
        const items = d.items.filter((i) =>
          out.added.some((a) => a.space === k && a.ref === i.ref),
        );
        return [k, { ...s, design: { ...s.design, items: [...s.design.items, ...items] } }];
      }),
    ),
  };
}

/** An option with a free fix's pieces taken out of its answers again (its line's Undo). */
export function withoutFree(o: ProposalOption, free: Pick<FreeLine, 'refs'>): ProposalOption {
  const out = new Set(free.refs.map((x) => `${x.space}|${x.ref}`));
  return {
    ...o,
    spaces: Object.fromEntries(
      Object.entries(o.spaces).map(([k, s]) => [
        k,
        s.design
          ? {
              ...s,
              design: {
                ...s.design,
                items: s.design.items.filter((i) => !out.has(`${k}|${i.ref}`)),
              },
            }
          : s,
      ]),
    ),
  };
}

/**
 * The Decisions an Accept records for the app's own rows left out ("Left out: the app's queen
 * bed in Main bedroom"), by room and role so the free fix doesn't offer them there again.
 */
export function appDecisions(
  left: readonly Change[],
  r: DesignResult,
): { text: string; free: { room: string; role: string } | null }[] {
  return left
    .filter((c) => isAppChange(c, r))
    .map((c) => ({
      text: `Left out: the app’s ${c.name.replace(/^the /, '')} in ${c.groupName}`,
      free: appRowOf(c, r),
    }));
}

/**
 * Place … · free: the free fixes worked out afresh, put into the option's answers (the same
 * card, no request), the new rows ticked as rows are, a log line with Undo, and one
 * announcement. The id of the line, or null when nothing was placed.
 */
export async function placeFree(card: CardModel): Promise<string | null> {
  const p = card.proposal;
  const o = card.option;
  if (!p || !o || useFreeBusy.getState().card) return null;
  const project = useStore.getState().editor.doc;
  const b = nowOf(project, card.levelId);
  if (!b) return null;
  useFreeBusy.setState({ card: card.key });
  try {
    const opts = designOpts(project, card.levelId, madeWith(card));
    const out = await requestFree(b.now, b.before, card.input, opts, {
      declined: declinedPieces(),
    });
    if (!out.added.length) return null;
    const patch = (x: ProposalOption) => withFree(x, out);
    // The rows it adds, ticked as the card ticks rows (none yet: all that pass, as before).
    const nextOption = patch(o);
    const nextCard = optionCard(p, nextOption, card.levelId);
    const r2 = await requestResult(b.now, b.before, nextCard.input, opts);
    const changes = cardChanges(project, nextCard, r2);
    const refs = new Set(out.added.map((a) => a.ref));
    const added = changes.filter(
      (c) => isAppChange(c, r2) && c.items.target.some((id) => refs.has(r2.refs[id] ?? '')),
    );
    const letter = o.letter;
    await actProposal(p.id, (x) =>
      x
        ? {
            ...x,
            options: x.options.map((y) =>
              y.letter === letter && y.designId === o.designId
                ? {
                    ...patch(y),
                    ...(y.ticks ? { ticks: [...y.ticks, ...added.map((c) => c.id)] } : {}),
                  }
                : y,
            ),
          }
        : x,
    );
    // Each piece by its row, or (no row: it stands where the plan has one) by its name and room.
    const named = new Set(added.flatMap((c) => c.items.target.map((id) => r2.refs[id])));
    const words = [
      ...added.map(placedWords),
      ...out.added
        .filter((a) => !named.has(a.ref) && heads(out).includes(a))
        .map((a) => {
          const name = freeName(a.assetId);
          const room = r2.level.rooms[a.roomId]?.name ?? 'the room';
          return `${/^[aeiou8]/i.test(name) ? 'an' : 'a'} ${name} in ${room}`;
        }),
    ];
    // What of the answer gave way for it, said with it (never silently), only where the card
    // still changes something (with no change from the plan as it is, nothing gave way there).
    const gave = out.gaveWay?.length && changes.length ? gaveWayWords(out.gaveWay) : null;
    const text = `Placed by the app, free: ${words.join('; ')}${gave ? `; ${gave}` : ''}.`;
    const id = newId('turn');
    await act({
      type: 'event',
      id,
      at: nowIso(),
      event: {
        type: 'note',
        text,
        free: {
          proposalId: p.id,
          letter,
          refs: out.added.map((a) => ({ space: a.space, ref: a.ref })),
          undone: false,
        },
      },
    });
    const rep = cardRunReport(nextCard, r2, changes);
    const n = rep.failures.length;
    const what = words.map((w) => w.replace(/,.*$/, '')).join(' and ');
    say(
      `Placed ${what}${gave ? `; ${gave}` : ''}. ${n ? `${n} still ${n === 1 ? 'doesn’t' : 'don’t'} pass.` : 'Passes all checks.'} Undo is available.`,
    );
    useFreePlaced.setState((s) => ({ n: s.n + 1, card: card.key }));
    useTalk.setState({ shown: card.key });
    return id;
  } finally {
    useFreeBusy.setState({ card: null });
  }
}

/** Whether a free fix's line still offers Undo: the newest such line, not undone, not accepted. */
export function freeUndoable(eventId: string): boolean {
  const s = useTalk.getState();
  const turns = s.conv?.turns ?? [];
  let newest: string | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.kind === 'event' && t.event.type === 'note' && t.event.free) {
      newest = t.id;
      break;
    }
  }
  if (newest !== eventId) return false;
  const t = turns.find((x) => x.id === eventId);
  const free = t?.kind === 'event' && t.event.type === 'note' ? t.event.free : undefined;
  if (!free || free.undone) return false;
  // Once accepted after it, the plan has them: Undo the accept instead.
  const at = turns.findIndex((x) => x.id === eventId);
  return !turns
    .slice(at + 1)
    .some(
      (x) =>
        x.kind === 'event' &&
        x.event.type === 'accepted' &&
        x.event.proposalId === free.proposalId &&
        !x.event.undone,
    );
}

/**
 * After the line's Undo, focus goes to the card's Place … · free again once its dry run has
 * offered it (on a phone at peek, the bar's); never left on a button that has gone.
 */
export function focusFreeButton() {
  const until = Date.now() + 3000;
  const look = () => {
    const peek = document.documentElement.dataset.talkSheet === 'peek';
    const btn = document.querySelector<HTMLButtonElement>(
      peek ? '[data-free-fix="bar"]' : '[data-free-fix=""]',
    );
    if (btn) {
      btn.focus();
      return;
    }
    if (Date.now() < until) setTimeout(look, 50);
  };
  look();
}

/** The line's Undo: the pieces it added come out of the option's answers again. */
export async function undoFree(eventId: string): Promise<void> {
  const t = useTalk.getState().conv?.turns.find((x) => x.id === eventId);
  const free = t?.kind === 'event' && t.event.type === 'note' ? t.event.free : undefined;
  if (!free || !freeUndoable(eventId)) return;
  await actProposal(free.proposalId, (p) =>
    p
      ? {
          ...p,
          options: p.options.map((o) => (o.letter === free.letter ? withoutFree(o, free) : o)),
        }
      : p,
  );
  await act({ type: 'freeUndone', eventId });
  say('Took out what the app placed.');
}
