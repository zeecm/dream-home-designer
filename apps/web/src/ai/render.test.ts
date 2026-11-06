import { MAX_SHEET, type SceneFacts } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { HIGH_FIDELITY, RENDER_STYLES, renderPrompt } from './render';

describe('OpenAI render options', () => {
  it('asks for high input fidelity only of models known to take it', () => {
    expect(HIGH_FIDELITY.test('gpt-image-1')).toBe(true);
    expect(HIGH_FIDELITY.test('gpt-image-1-2025-04-23')).toBe(true);
    expect(HIGH_FIDELITY.test('gpt-image-1-mini')).toBe(false);
    expect(HIGH_FIDELITY.test('dall-e-2')).toBe(false);
  });
});

const bedroom: SceneFacts = {
  rooms: [
    {
      id: 'rm_bed2',
      name: 'Bedroom 2',
      width: 3,
      depth: 2.8,
      area: 8.4,
      ceilingHeight: 2.6,
      floor: 'Oak',
      walls: ['Sage'],
    },
  ],
  cameraRoomId: 'rm_bed2',
  height: 1.6,
  fovAcross: 60,
  fovUp: 40,
  view: 'eye',
  items: [
    {
      id: 'it_1',
      name: 'Single bed',
      size: { w: 1, d: 2, h: 0.5 },
      where: 'against the left wall',
      roomId: 'rm_bed2',
    },
    {
      id: 'it_2',
      name: 'Wardrobe',
      size: { w: 1.2, d: 0.6, h: 2.1 },
      where: 'against the right wall',
      roomId: 'rm_bed2',
    },
  ],
  moreItems: 0,
  openings: [
    {
      id: 'op_1',
      kind: 'door',
      name: 'door',
      width: 0.9,
      height: 2.1,
      sill: 0,
      where: 'in the middle of the picture',
      near: 'Bedroom 2',
      far: 'Living',
    },
  ],
  moreOpenings: 0,
};

describe('the render prompt', () => {
  it('asks for the same picture made real, and adds the room, the camera, doors and furniture', () => {
    const p = renderPrompt('scandi', bedroom);
    expect(p.startsWith('Edit this image. It is an exact 3D model of a real home')).toBe(true);
    expect(p).toContain('changing only how the surfaces look');
    expect(p).toContain('Never add a door, doorway, arch, opening, niche or window');
    // The rule is said again last.
    expect(p.endsWith('Nothing added, removed or moved.')).toBe(true);
    expect(p).toContain(
      'Doors, windows and openings in view, 1 and no others: a door 0.9 m wide, in the middle of the picture, into "Living".',
    );
    expect(p).toContain('pale wood, white walls');
    expect(p).toContain('This is "Bedroom 2", 3.0 m × 2.8 m (8.4 m²), ceiling 2.6 m.');
    expect(p).toContain('1.6 m above the floor');
    expect(p).toContain('60° field of view');
    expect(p).toContain(
      'The only furniture in view, 2 pieces and nothing else: "Single bed" 1.0 × 2.0 × 0.5 m (against the left wall), "Wardrobe" 1.2 × 0.6 × 2.1 m (against the right wall).',
    );
    expect(p).toContain('Keep the room exactly the size given here; it is small.');
    expect(p).toContain('leave solid walls solid and empty floor empty');
    // A new look changes the finishes, so they aren't listed.
    expect(p).not.toContain('Sage');
    expect(renderPrompt('as', bedroom)).toContain('walls Sage; floor Oak');
  });

  it('says plainly when the view is from above', () => {
    const p = renderPrompt('as', { ...bedroom, view: 'overhead', height: 7.2, cameraRoomId: null });
    expect(p).toContain('cut-away view from above');
    expect(p).toContain('7.2 m above the floor');
  });

  it('stays within its length, however long the names', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      ...(bedroom.items[0] as SceneFacts['items'][number]),
      id: `it_${i}`,
      name: 'A very long name for a piece of furniture someone added themselves'.repeat(3),
    }));
    const p = renderPrompt('as', { ...bedroom, items, moreItems: 40 });
    expect(p.length).toBeLessThan(renderPrompt('as').length + MAX_SHEET + 40);
    expect(p).toContain(
      'Do not add, remove, enlarge or move furniture, doors, windows or openings; leave solid walls solid and empty floor empty.',
    );
  });

  it('adds nothing for any look: the looks change finishes and light only', () => {
    for (const style of Object.keys(RENDER_STYLES) as (keyof typeof RENDER_STYLES)[]) {
      const p = renderPrompt(style, bedroom);
      expect(p).toContain('Add nothing: no furniture, rugs, lamps, curtains, pictures, plants');
      // No look asks for things that aren't there.
      expect(RENDER_STYLES[style]).not.toMatch(/plants|lamps on|pendant|décor/i);
    }
  });

  it('with no window in view, asks for indoor light, not daylight through windows', () => {
    const shut = renderPrompt('warm', { ...bedroom, openings: [] });
    expect(shut).not.toContain('through the windows');
    expect(shut).toContain('soft, even indoor light');
    expect(renderPrompt('warm', bedroom)).not.toContain('through the windows');
    const lit = renderPrompt('warm', {
      ...bedroom,
      openings: [{ ...(bedroom.openings[0] as SceneFacts['openings'][number]), kind: 'window' }],
    });
    expect(lit).toContain('natural daylight through the windows');
  });

  it('says an empty room stays empty', () => {
    const p = renderPrompt('warm', { ...bedroom, items: [] });
    expect(p).toContain('There is no furniture in view: keep it unfurnished');
  });

  it('without the facts, is the plain prompt', () => {
    expect(renderPrompt('as')).not.toContain('measured');
  });
});
