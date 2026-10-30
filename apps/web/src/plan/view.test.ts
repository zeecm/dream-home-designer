import { describe, expect, it } from 'vitest';
import { fitBounds, gridStep, panBy, screenToWorld, worldToScreen, zoomAt } from './view';

const size = { width: 800, height: 600 };

describe('plan view', () => {
  it('screen and world transforms are inverses', () => {
    const v = { cx: 3, cy: 4, zoom: 40 };
    const p = { x: 1.25, y: -2 };
    const back = screenToWorld(v, size, worldToScreen(v, size, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    expect(worldToScreen(v, size, { x: 3, y: 4 })).toEqual({ x: 400, y: 300 });
  });

  it('zooming keeps the point under the cursor still', () => {
    const v = { cx: 0, cy: 0, zoom: 50 };
    const cursor = { x: 620, y: 140 };
    const before = screenToWorld(v, size, cursor);
    const z = zoomAt(v, size, cursor, 1.7);
    const after = screenToWorld(z, size, cursor);
    expect(z.zoom).toBeCloseTo(85);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('panning moves the world with the pointer', () => {
    const v = panBy({ cx: 0, cy: 0, zoom: 100 }, 50, -20);
    expect(v).toEqual({ cx: -0.5, cy: 0.2, zoom: 100 });
  });

  it('fits a plan inside the padding', () => {
    const v = fitBounds({ min: { x: 0, y: 0 }, max: { x: 11, y: 8.5 } }, size, 50);
    expect(v.cx).toBe(5.5);
    expect(v.cy).toBe(4.25);
    expect(v.zoom).toBeCloseTo(Math.min(700 / 11, 500 / 8.5));
  });

  it('chooses a readable grid for the zoom', () => {
    expect(gridStep(200)).toEqual({ minor: 0.1, major: 1 });
    expect(gridStep(40)).toEqual({ minor: 0.5, major: 2.5 });
    expect(gridStep(15)).toEqual({ minor: 1, major: 5 });
  });
});
