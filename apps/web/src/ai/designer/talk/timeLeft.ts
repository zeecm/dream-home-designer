/**
 * About how long a design run has left, as its running card says it (docs/specs/
 * locked-phone-runs.md, part 1): the steps not finished, each timed by this run's own
 * finished steps of its kind (their median), else a default; rooms go two at a time. Worked
 * out again only when a step ends or a fix round starts, never on a ticking clock.
 */

export type TimedKind = 'layout' | 'room' | 'fix';

/** Before a step of a kind has finished in this run: about how long one takes (ms). */
export const DEFAULT_MS: Record<TimedKind, number> = { layout: 45_000, room: 30_000, fix: 20_000 };
/** Rooms designed side by side. */
const AT_ONCE = 2;
const MINUTE = 60_000;

export interface StepLike {
  kind: 'layout' | 'room';
  status: string;
  fixing: { round: number; problems: number } | null;
}

const open = (s: StepLike) => s.status === 'waiting' || s.status === 'running';

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? (a[m] as number) : ((a[m - 1] as number) + (a[m] as number)) / 2;
}

/** How long one step of each kind takes, by this run's finished steps. */
export function stepTimes(times: { kind: TimedKind; ms: number }[]): Record<TimedKind, number> {
  const of = (k: TimedKind) => median(times.filter((t) => t.kind === k).map((t) => t.ms));
  return {
    layout: of('layout') ?? DEFAULT_MS.layout,
    room: of('room') ?? DEFAULT_MS.room,
    fix: of('fix') ?? DEFAULT_MS.fix,
  };
}

/** The time left (ms) for the steps not finished. */
export function msLeft(steps: StepLike[], times: { kind: TimedKind; ms: number }[]): number {
  const t = stepTimes(times);
  const layout = steps.some((s) => s.kind === 'layout' && open(s)) ? t.layout : 0;
  // A room being fixed has its answer: what is left of it is the fix round.
  const rooms = steps.filter((s) => s.kind === 'room' && open(s) && !s.fixing).length;
  const fixing = steps.filter((s) => s.kind === 'room' && open(s) && s.fixing).length;
  return layout + Math.ceil(rooms / AT_ONCE) * t.room + Math.ceil(fixing / AT_ONCE) * t.fix;
}

export interface TimeLeft {
  ms: number;
  /** "about 3 min left", "less than a minute left", "almost done". */
  text: string;
  /** What a step finishing or a fix starting last worked it out from (to know when to again). */
  at: string;
}

/** What the time left is worked out again at: a step finished, or a fix round started. */
export const timeLeftMark = (steps: StepLike[]) =>
  `${steps.filter((s) => !open(s)).length}:${steps.filter((s) => s.fixing).length}:${steps.length}`;

/**
 * The time left, said as the card says it. `prev`: the last one said; it never goes up by more
 * than a minute from it unless a fix round has started since.
 */
export function timeLeft(
  steps: StepLike[],
  times: { kind: TimedKind; ms: number }[],
  prev: TimeLeft | null,
): TimeLeft {
  const at = timeLeftMark(steps);
  let ms = msLeft(steps, times);
  const fixStarted = steps.filter((s) => s.fixing).length > (prev ? fixingIn(prev.at) : 0);
  if (prev && !fixStarted) ms = Math.min(ms, prev.ms + MINUTE);
  const left = steps.filter(open).length;
  const text =
    left <= 1
      ? 'almost done'
      : ms < MINUTE
        ? 'less than a minute left'
        : `about ${Math.max(1, Math.round(ms / MINUTE))} min left`;
  return { ms, text, at };
}

const fixingIn = (mark: string) => Number(mark.split(':')[1] ?? 0);
