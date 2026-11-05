import { describe, expect, it } from 'vitest';
import { WALLPAPERS, customPaint, finish } from './finishes';

describe('finish', () => {
  it('knows paints, floors and wallpapers by id, and any colour mixed as a paint', () => {
    expect(finish('paint-sage')?.name).toBe('Sage');
    expect(finish('wallpaper-brick')?.name).toBe('White brick');
    expect(WALLPAPERS.every((w) => finish(w.id))).toBe(true);
    const id = customPaint('#3A6B8C');
    expect(id).toBe('paint-#3a6b8c');
    expect(finish(id)).toMatchObject({ color: '#3a6b8c', name: 'Colour #3a6b8c' });
    expect(finish('paint-#zzz')).toBeUndefined();
  });
});
