import { FLOOR_FINISHES, PAINTS, WALLPAPERS, customPaint } from '@dhd/core';
import {
  Color,
  DoubleSide,
  FrontSide,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';
import { paletteEntry } from './materials';
import {
  CLEAR_GLASS,
  PhotoMaterials,
  convertModelMaterial,
  photoMaterial,
  photoParams,
} from './photo';

const hex = (m: { color: Color }) => `#${m.color.getHexString()}`;

/** The exact render's parameters by id, as the spec's materials table gives them. */
const TABLE: Record<string, Partial<Record<string, number>>> = {
  'wood-oak': { roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 },
  'wood-walnut': { roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 },
  'vinyl-ash': { roughness: 0.55, specularIntensity: 0.4 },
  'tile-grey': { roughness: 0.3 },
  'tile-white': { roughness: 0.3 },
  marble: { roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 },
  concrete: { roughness: 0.45 },
  'carpet-grey': { roughness: 1, sheen: 0.6, sheenRoughness: 0.8 },
  door: { roughness: 0.45 },
  aluminium: { roughness: 0.45, metalness: 0 },
  'furniture-wood': { roughness: 0.55 },
  'furniture-wood-dark': { roughness: 0.55 },
  'furniture-fabric': { roughness: 0.95, sheen: 1, sheenRoughness: 0.7 },
  'furniture-fabric-light': { roughness: 0.95, sheen: 1, sheenRoughness: 0.7 },
  'furniture-white': { roughness: 0.45 },
  'furniture-charcoal': { roughness: 0.45 },
  'furniture-metal': { metalness: 1, roughness: 0.35 },
  'furniture-glass': { roughness: 0.05, clearcoat: 1, transmission: 0 },
  'furniture-ceramic': { roughness: 0.2, clearcoat: 1 },
  'furniture-leaf': { roughness: 0.7, sheen: 0.3 },
  'furniture-figure': { roughness: 0.85 },
  'furniture-placeholder': { roughness: 1 },
};

describe('photoMaterial', () => {
  it('gives every floor finish, paint, wallpaper and palette id its parameters and its colour', () => {
    const ids = new Set([
      ...FLOOR_FINISHES.map((f) => f.id),
      ...PAINTS.map((f) => f.id),
      ...WALLPAPERS.map((f) => f.id),
      ...Object.keys(TABLE),
      'faceplate',
      'faceplate-detail',
      'furniture-lamp',
    ]);
    for (const id of ids) {
      const m = photoMaterial(id);
      expect(m, id).toBeInstanceOf(MeshPhysicalMaterial);
      const row = TABLE[id];
      if (row) {
        for (const [k, v] of Object.entries(row)) {
          expect((m as unknown as Record<string, number>)[k], `${id}.${k}`).toBeCloseTo(
            v as number,
            6,
          );
        }
      } else if (id.startsWith('paint-')) {
        // A matt emulsion.
        expect(m.roughness, id).toBe(0.9);
        expect(m.specularIntensity, id).toBe(0.3);
      } else if (id.startsWith('wallpaper-')) {
        // Its own roughness; its pattern is drawn on (a canvas, only in a browser).
        expect(m.roughness, id).toBe(paletteEntry(id).roughness);
      }
      // The finish's colour, as the plan's swatch shows it (a pattern draws on white).
      if (!m.map) expect(hex(m), id).toBe(hex({ color: new Color(paletteEntry(id).color) }));
      expect(m.transmission, id).toBe(0);
    }
  });

  it('mixes a custom paint to its colour, matt', () => {
    const m = photoMaterial(customPaint('#123456'));
    expect(hex(m)).toBe('#123456');
    expect(m.roughness).toBe(0.9);
  });

  it('makes faceplates plain (no glow) and lamp shades glow only with the lamps on', () => {
    expect(hex({ color: photoMaterial('faceplate').emissive })).toBe('#000000');
    expect(hex({ color: photoMaterial('furniture-lamp').emissive })).toBe('#000000');
    const lit = photoMaterial('furniture-lamp', true);
    expect(hex({ color: lit.emissive })).toBe('#ffe2b8');
    expect(lit.emissiveIntensity).toBeGreaterThan(0);
    // The bulb inside shines through its shade.
    expect((lit as unknown as { castShadow: boolean }).castShadow).toBe(false);
  });

  it('flags an unknown id in magenta', () => {
    expect(hex(photoMaterial('no-such-finish'))).toBe('#ff00ff');
  });

  it('makes window glass clear and transmissive, and frosted glass rough', () => {
    const set = new PhotoMaterials();
    const glass = set.glass as MeshPhysicalMaterial;
    expect(glass.transmission).toBe(1);
    expect(glass.roughness).toBe(0);
    expect(glass.ior).toBe(1.5);
    expect(glass.thickness).toBe(0);
    expect(hex(glass)).toBe(CLEAR_GLASS.color);
    const frosted = set.frosted as MeshPhysicalMaterial;
    expect(frosted.transmission).toBe(1);
    expect(frosted.roughness).toBe(0.45);
    expect(photoParams('door').roughness).toBe(0.45);
    set.dispose();
  });
});

describe('model materials', () => {
  it('keeps a standard material, makes plain see-through glass transmissive, and Phong standard', () => {
    const wood = new MeshStandardMaterial({ color: '#884422' });
    expect(convertModelMaterial(wood)).toBe(wood);
    const pane = new MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.3 });
    const glass = convertModelMaterial(pane) as MeshPhysicalMaterial;
    expect(glass).toBeInstanceOf(MeshPhysicalMaterial);
    expect(glass.transmission).toBe(1);
    const phong = new MeshPhongMaterial({ color: '#336699' });
    const std = convertModelMaterial(phong) as MeshStandardMaterial;
    expect(std).toBeInstanceOf(MeshStandardMaterial);
    expect(hex(std)).toBe('#336699');
  });

  it('hands out only two-sided materials, model copies included', () => {
    const set = new PhotoMaterials(true);
    for (const id of ['wood-oak', 'paint-white', 'furniture-lamp', 'door', 'no-such-finish']) {
      set.get(id);
    }
    const own = new MeshStandardMaterial({ color: '#884422' });
    expect(set.model(own)).not.toBe(own);
    set.model(new MeshPhongMaterial({ color: '#336699' }));
    set.model(new MeshStandardMaterial({ transparent: true, opacity: 0.3 }), true);
    const all = set.all();
    expect(all.length).toBe(10);
    for (const m of all) expect(m.side, m.name).toBe(DoubleSide);
    // The library's own is left as it was.
    expect(own.side).toBe(FrontSide);
    set.dispose();
  });

  it('lets a lamp model’s bulb shine through it, without touching the library’s material', () => {
    const set = new PhotoMaterials(true);
    const shade = new MeshStandardMaterial({ color: '#ffffff' });
    const used = set.model(shade, true);
    expect(used).not.toBe(shade);
    expect((used as unknown as { castShadow: boolean }).castShadow).toBe(false);
    expect((shade as unknown as { castShadow?: boolean }).castShadow).toBeUndefined();
    expect(set.model(shade, true)).toBe(used);
    set.dispose();
  });
});
