import { describe, expect, it } from 'vitest';
import type { ExactEngine } from './engine';
import { DAY_NITS, KEY, MAX_EV, NIGHT_NITS, autoExposure, baseExposure, logMean } from './exposure';
import { ExactRun, METER_AT, type RunStatus, clock, progressText } from './run';
import { exactSettings, renderSize } from './settings';

/** An engine that draws a sample a step (the GPU always ready), at a given brightness. */
function fakeEngine(nits = 40) {
  const e = {
    canvas: {} as HTMLCanvasElement,
    samples: 0,
    lost: false,
    exposure: 1,
    shown: 0,
    meterings: [] as number[],
    sample() {
      e.samples++;
      return true;
    },
    async luminance() {
      e.meterings.push(e.samples);
      return nits;
    },
    show() {
      e.shown++;
    },
    start: async () => {},
    readPixels: async () => new Blob(),
    stop() {},
    dispose() {},
  };
  return e;
}

/** A run driven by hand: `frames(n)` runs n animation frames, each `dt` ms apart. */
function harness(target = 20, cap = 1_000, dt = 10) {
  const engine = fakeEngine();
  let t = 0;
  let queued: (() => void) | null = null;
  const seen: RunStatus[] = [];
  const run = new ExactRun(engine as unknown as ExactEngine, {
    target,
    cap,
    onChange: (s) => seen.push(s),
    now: () => t,
    frame: (cb) => {
      queued = cb;
      return 1;
    },
    cancelFrame: () => {
      queued = null;
    },
  });
  const frames = (n: number) => {
    for (let i = 0; i < n && queued; i++) {
      const cb: () => void = queued;
      queued = null;
      t += dt;
      cb();
    }
  };
  return {
    run,
    engine,
    seen,
    frames,
    get pending() {
      return queued !== null;
    },
    wait: (ms: number) => {
      t += ms;
    },
  };
}

describe('an exact render’s run', () => {
  it('draws to its sample target, then is done', () => {
    const h = harness(20);
    h.run.start();
    h.frames(100);
    expect(h.engine.samples).toBe(20);
    expect(h.run.status.phase).toBe('done');
    expect(h.pending).toBe(false);
    expect(h.seen.at(-1)?.phase).toBe('done');
  });

  it('shows its first picture once a whole sample is metered, not before', async () => {
    const h = harness(40);
    h.run.start();
    expect(h.run.status.picture).toBe(false);
    h.frames(1);
    expect(h.engine.meterings).toEqual([1]);
    expect(h.run.status.picture).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.run.status.picture).toBe(true);
    expect(h.seen.at(-1)?.picture).toBe(true);
  });

  it('takes more samples once done, from the same ones, twice as many', () => {
    const h = harness(16);
    h.run.start();
    h.frames(50);
    expect(h.run.status.phase).toBe('done');
    h.run.more();
    expect(h.run.status).toMatchObject({ phase: 'running', target: 32 });
    h.frames(50);
    expect(h.engine.samples).toBe(32);
    expect(h.run.status.phase).toBe('done');
  });

  it('meters the first picture, then sets the exposure for good at METER_AT samples', async () => {
    const h = harness(40);
    h.run.start();
    h.frames(40);
    await Promise.resolve();
    expect(h.engine.meterings).toEqual([1, METER_AT]);
    expect(h.engine.exposure).toBeCloseTo(autoExposure(40), 12);
  });

  it('stops at once and carries on from the same samples', () => {
    const h = harness(50);
    h.run.start();
    h.frames(10);
    h.run.stop();
    expect(h.run.status.phase).toBe('stopped');
    expect(h.pending).toBe(false);
    const at = h.engine.samples;
    h.frames(10);
    expect(h.engine.samples).toBe(at);
    h.run.carryOn();
    h.frames(5);
    expect(h.engine.samples).toBe(at + 5);
  });

  it('stops at the time cap, counting only time spent drawing, and carries on for as long again', () => {
    const h = harness(1_000, 100, 10);
    h.run.start();
    h.frames(5); // 50 ms
    h.run.stop();
    h.wait(10_000); // stopped: not counted
    h.run.carryOn();
    h.frames(100);
    expect(h.run.status.phase).toBe('capped');
    expect(h.engine.samples).toBe(10);
    expect(progressText(h.run.status)).toBe(
      'Stopped at 0 s: 10 samples. Carry on for a cleaner picture.',
    );
    h.run.carryOn();
    h.frames(100);
    expect(h.run.status.phase).toBe('capped');
    expect(h.engine.samples).toBe(20);
  });

  it('waits while the tab is hidden or the other side shows', () => {
    const h = harness(100);
    h.run.start();
    h.frames(3);
    h.run.setHidden(true);
    expect(h.pending).toBe(false);
    h.wait(5_000);
    expect(h.run.status.elapsed).toBe(30);
    h.run.setHidden(false);
    h.frames(2);
    h.run.setAway(true);
    h.frames(10);
    expect(h.engine.samples).toBe(5);
    h.run.setAway(false);
    h.frames(1);
    expect(h.engine.samples).toBe(6);
    expect(h.run.status.phase).toBe('running');
  });

  it('keeps the picture when the graphics card resets', () => {
    const h = harness(100);
    h.run.start();
    h.frames(3);
    h.engine.lost = true;
    h.frames(3);
    expect(h.run.status.phase).toBe('lost');
    expect(h.engine.samples).toBe(3);
    expect(progressText(h.run.status)).toContain('your picture so far is kept');
  });
});

describe('the progress line', () => {
  const s = (phase: RunStatus['phase'], samples: number, elapsed: number): RunStatus => ({
    phase,
    samples,
    target: 256,
    elapsed,
    picture: true,
  });
  it('counts finished samples, running or stopped, and prepares until the first picture', () => {
    expect(progressText(s('running', 48, 12_300))).toBe('Sample 48 of 256 · 0:12');
    expect(progressText({ ...s('running', 0, 0), picture: false })).toBe('Preparing the scene…');
    expect(progressText(s('stopped', 48, 12_300))).toBe('Stopped · 48 of 256 samples · 0:12');
    expect(progressText(s('done', 256, 41_000))).toBe('Done · 256 samples · 0:41');
    expect(progressText(s('capped', 140, 120_000))).toBe(
      'Stopped at 2 min: 140 samples. Carry on for a cleaner picture.',
    );
    expect(progressText(s('capped', 140, 90_000))).toBe(
      'Stopped at 1 min 30 s: 140 samples. Carry on for a cleaner picture.',
    );
    expect(clock(125_000)).toBe('2:05');
  });
});

describe('exposure', () => {
  it('brings the log-average to middle grey, within ±3 EV of a typical room at that hour', () => {
    const day = baseExposure(1);
    expect(day).toBeCloseTo(KEY / DAY_NITS, 12);
    expect(baseExposure(0)).toBeCloseTo(KEY / NIGHT_NITS, 12);
    expect(autoExposure(DAY_NITS, 1)).toBeCloseTo(day, 12);
    expect(autoExposure(2 * DAY_NITS, 1)).toBeCloseTo(day / 2, 12);
    expect(autoExposure(1e9, 1)).toBeCloseTo(day * 2 ** -MAX_EV, 12);
    expect(autoExposure(1e-6, 1)).toBeCloseTo(day * 2 ** MAX_EV, 12);
    // A dim room at night is lifted, but not to daylight.
    expect(autoExposure(1e-6, 0)).toBeCloseTo(baseExposure(0) * 2 ** MAX_EV, 12);
    expect(autoExposure(0, 1)).toBe(day);
    expect(autoExposure(Number.NaN, 0.5)).toBe(baseExposure(0.5));
  });

  it('takes the geometric mean, a black patch held at the floor', () => {
    expect(logMean([10, 1000])).toBeCloseTo(100, 9);
    expect(logMean([10, 0, 0, 0, 1000, 0, 0, 0], 4)).toBeCloseTo(100, 9);
    expect(logMean([0, 1e-3])).toBeCloseTo(1e-3, 12);
    expect(logMean([])).toBe(0);
  });
});

describe('render settings', () => {
  it('is Good: 256 samples, 1600 px long on a desktop, 1280 on a phone, capped at 90 s and 120 s', () => {
    const desk = exactSettings(false);
    expect(desk).toMatchObject({ samples: 256, long: 1600, cap: 90_000, bounces: 5 });
    const phone = exactSettings(true);
    expect(phone).toMatchObject({ samples: 256, long: 1280, cap: 120_000, bounces: 3 });
    expect(phone.transmissiveBounces).toBe(6);
    expect(exactSettings(false, { width: 160, height: 120, samples: 16 })).toMatchObject({
      samples: 16,
      box: { width: 160, height: 120 },
    });
  });

  it('sizes the picture at the view’s shape', () => {
    expect(renderSize(16 / 9, 1600)).toEqual({ width: 1600, height: 900 });
    expect(renderSize(390 / 844, 1280)).toEqual({ width: 591, height: 1280 });
    // A test's small box, keeping the shape.
    expect(renderSize(1440 / 900, 1600, { width: 160, height: 120 })).toEqual({
      width: 160,
      height: 100,
    });
    expect(renderSize(390 / 844, 1280, { width: 160, height: 120 })).toEqual({
      width: 55,
      height: 120,
    });
  });
});
