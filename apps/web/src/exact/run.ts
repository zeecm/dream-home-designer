import type { ExactEngine } from './engine';
import { autoExposure } from './exposure';

/**
 * Runs an exact render to its sample target or its time cap, whichever comes first: a step
 * a frame (the engine says when the GPU is ready for the next), the exposure metered on the
 * first picture and set for good at METER_AT samples, paused while the tab is hidden (the
 * time spent hidden doesn't count), stopped and carried on at will.
 */

/** The exposure is set once more, for good, at this many samples (so it doesn't pump). */
export const METER_AT = 8;

export type RunPhase =
  /** Drawing samples. */
  | 'running'
  /** Stopped by Stop: the picture so far is kept. */
  | 'stopped'
  /** Stopped at the time cap. */
  | 'capped'
  /** At the sample target. */
  | 'done'
  /** The graphics context was lost: the picture so far is kept. */
  | 'lost';

export interface RunStatus {
  phase: RunPhase;
  /** Whole samples drawn. */
  samples: number;
  target: number;
  /** Time spent drawing, ms (not counting time stopped or hidden). */
  elapsed: number;
  /** A picture is on the canvas (the first, quarter-size one counts). */
  picture: boolean;
}

export interface RunOptions {
  target: number;
  /** Drawing stops here, ms, until carried on (each Carry on allows as long again). */
  cap: number;
  /** The daylight (0 night to 1 day) the scene is lit for: where the exposure centres. */
  light?: number;
  onChange: (s: RunStatus) => void;
  now?: () => number;
  frame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export class ExactRun {
  private phase: RunPhase = 'running';
  private hidden = false;
  /** The tab shown elsewhere (the dialog's other side): drawing waits. */
  private away = false;
  private elapsed = 0;
  private since: number | null = null;
  private limit: number;
  private id: number | null = null;
  private picture = false;
  private metered = false;
  private final = false;
  private disposed = false;
  private lastSamples = -1;
  private readonly now: () => number;
  private readonly frame: (cb: () => void) => number;
  private readonly cancelFrame: (id: number) => void;

  constructor(
    private readonly engine: ExactEngine,
    private readonly opts: RunOptions,
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.frame = opts.frame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = opts.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.limit = opts.cap;
  }

  get status(): RunStatus {
    return {
      phase: this.phase,
      samples: Math.floor(this.engine.samples),
      target: this.opts.target,
      elapsed: this.elapsed + (this.since === null ? 0 : this.now() - this.since),
      picture: this.picture,
    };
  }

  start(): void {
    this.schedule();
  }

  /** Stop: no more samples until Carry on; the picture stays. */
  stop(): void {
    if (this.phase !== 'running') return;
    this.phase = 'stopped';
    this.halt();
    this.emit();
  }

  /** Carry on from the same samples (after Stop, or past the time cap for as long again). */
  carryOn(): void {
    if (this.phase !== 'stopped' && this.phase !== 'capped') return;
    if (this.phase === 'capped') this.limit = this.elapsed + this.opts.cap;
    this.phase = 'running';
    this.schedule();
    this.emit();
  }

  /** The tab hidden (or shown again): drawing waits, and the clock with it. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.halt();
    else this.schedule();
  }

  /** The other side of the dialog shown (or this one again): the same as hidden. */
  setAway(away: boolean): void {
    this.away = away;
    if (away) this.halt();
    else this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.halt();
    this.phase = this.phase === 'running' ? 'stopped' : this.phase;
  }

  private halt() {
    if (this.id !== null) this.cancelFrame(this.id);
    this.id = null;
    if (this.since !== null) this.elapsed += this.now() - this.since;
    this.since = null;
  }

  private schedule() {
    if (this.phase !== 'running' || this.hidden || this.away || this.id !== null) return;
    if (this.since === null) this.since = this.now();
    this.id = this.frame(() => this.tick());
  }

  private tick() {
    this.id = null;
    if (this.phase !== 'running') return;
    const e = this.engine;
    if (e.lost) {
      this.phase = 'lost';
      this.halt();
      this.emit();
      return;
    }
    if (e.sample()) {
      if (!this.picture) {
        // Metered on the first picture, so it opens at about the right brightness.
        this.picture = true;
        this.meter(false);
      } else if (!this.metered && e.samples >= METER_AT) {
        this.metered = true;
        this.meter(true);
      }
    }
    const status = this.status;
    if (status.samples >= this.opts.target) {
      this.phase = 'done';
      this.halt();
    } else if (status.elapsed >= this.limit) {
      this.phase = 'capped';
      this.halt();
    } else {
      this.schedule();
    }
    // Told of each new whole sample, and of each change of phase.
    if (status.samples !== this.lastSamples || this.phase !== 'running') this.emit();
  }

  /** Meters the picture (read back without stalling) and shows it at its new exposure. */
  private meter(final: boolean) {
    const e = this.engine;
    void e.luminance().then(
      (nits) => {
        // A first metering that comes back after the final one is too late to use.
        if (this.disposed || (!final && this.final)) return;
        if (final) this.final = true;
        e.exposure = autoExposure(nits, this.opts.light);
        e.show();
      },
      () => {},
    );
  }

  private emit() {
    const s = this.status;
    this.lastSamples = s.samples;
    this.opts.onChange(s);
  }
}

/** 41_000 → "0:41"; 125_000 → "2:05". */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The progress line under the picture. */
export function progressText(s: RunStatus): string {
  const time = clock(s.elapsed);
  switch (s.phase) {
    case 'done':
      return `Done · ${s.samples} samples · ${time}`;
    case 'capped':
      return `Stopped at ${capText(s.elapsed)}: ${s.samples} samples. Carry on for a cleaner picture.`;
    case 'stopped':
      return `Stopped · ${s.samples} of ${s.target} samples · ${time}`;
    case 'lost':
      return 'The graphics card reset; your picture so far is kept. Try again.';
    default:
      return `Sample ${Math.min(s.target, s.samples + 1)} of ${s.target} · ${time}`;
  }
}

/** "1 min 30 s", "2 min", "45 s": the time cap in words. */
function capText(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}
