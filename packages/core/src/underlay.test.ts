import { describe, expect, it } from 'vitest';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { type EditorDoc, dispatch, emptyHistory, undo } from './history';
import { Project } from './schema';
import {
  calibrateUnderlay,
  placeUnderlay,
  rotateUnderlay,
  setUnderlay,
  setUnderlayOpacity,
  underlayToWorld,
  worldToUnderlay,
} from './underlay';

const withImage = (): EditorDoc => {
  const s: EditorDoc = { doc: hdb4RoomProject(), history: emptyHistory() };
  return dispatch(
    s,
    setUnderlay(placeUnderlay('img_test', { width: 1000, height: 800 }, { x: 5, y: 4 })),
  );
};

describe('underlay', () => {
  it('is placed centred on the point given, at the guessed width', () => {
    const u = placeUnderlay('k', { width: 1000, height: 800 }, { x: 5, y: 4 }, 10);
    expect(underlayToWorld(u, { x: 500, y: 400 })).toEqual({ x: 5, y: 4 });
    expect(
      underlayToWorld(u, { x: 1000, y: 0 }).x - underlayToWorld(u, { x: 0, y: 0 }).x,
    ).toBeCloseTo(10);
  });

  it('maps pixels to the plan and back, rotated', () => {
    const u = {
      ...placeUnderlay('k', { width: 1000, height: 800 }, { x: 0, y: 0 }),
      rotation: 0.4,
    };
    const w = underlayToWorld(u, { x: 123, y: 456 });
    const back = worldToUnderlay(u, w);
    expect(back.x).toBeCloseTo(123);
    expect(back.y).toBeCloseTo(456);
  });

  it('calibration scales about the first point', () => {
    const s0 = withImage();
    const p1 = { x: 2, y: 1 };
    const p2 = { x: 2 + 3.5, y: 1 }; // 3.5 m apart on screen
    const s = dispatch(s0, calibrateUnderlay(p1, p2, 7)); // really 7 m
    const before = s0.doc.underlay!;
    const after = s.doc.underlay!;
    expect(after.scale).toBeCloseTo(before.scale * 2);
    // the pixel under p1 is still at p1; the pixel under p2 is now 7 m from p1
    const px1 = worldToUnderlay(before, p1);
    const px2 = worldToUnderlay(before, p2);
    const w1 = underlayToWorld(after, px1);
    const w2 = underlayToWorld(after, px2);
    expect(w1.x).toBeCloseTo(2);
    expect(w1.y).toBeCloseTo(1);
    expect(Math.hypot(w2.x - w1.x, w2.y - w1.y)).toBeCloseTo(7);
    expect(() => Project.parse(s.doc)).not.toThrow();
    expect(undo(s).doc).toEqual(s0.doc);
  });

  it('rotation turns about the pivot', () => {
    const s0 = withImage();
    const pivot = { x: 5, y: 4 };
    const px = worldToUnderlay(s0.doc.underlay!, pivot);
    const s = dispatch(s0, rotateUnderlay(Math.PI / 2, pivot));
    const w = underlayToWorld(s.doc.underlay!, px);
    expect(w.x).toBeCloseTo(5);
    expect(w.y).toBeCloseTo(4);
    expect(s.doc.underlay?.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('opacity is clamped and removal clears the underlay', () => {
    let s = dispatch(withImage(), setUnderlayOpacity(1.7));
    expect(s.doc.underlay?.opacity).toBe(1);
    s = dispatch(s, setUnderlay(null));
    expect(s.doc.underlay).toBeNull();
  });

  it('calibration rejects nonsense', () => {
    expect(() => calibrateUnderlay({ x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toThrow();
    expect(() => calibrateUnderlay({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toThrow();
  });
});
