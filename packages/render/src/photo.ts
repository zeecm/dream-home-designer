import { finish } from '@dhd/core';
import * as THREE from 'three';
import { type MaterialSource, paletteEntry, wallpaperTexture } from './materials';

/**
 * The exact render's materials: physically based versions of the 3D view's, keyed by the
 * same material ids. Colours stay the finish's own (the plan's swatch), so the picture shows
 * what was chosen; only how the surface takes light changes (a matt emulsion, a lacquered
 * floor, powder-coated aluminium). Real textures (planks, grout, grain) come later.
 */
export interface PhotoParams {
  color: string;
  roughness: number;
  metalness?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenRoughness?: number;
  specularIntensity?: number;
  transmission?: number;
  ior?: number;
  thickness?: number;
  emissive?: string;
}

/** A lamp's shade: glowing when the lamps are on. */
export const SHADE_GLOW = '#ffe2b8';
/** How bright a lit shade glows, in the scene's units (cd/m², as the lamps' candela). */
export const SHADE_LUMINANCE = 60;

const WOOD_FLOOR = { roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.35 };
const FABRIC = { roughness: 0.95, sheen: 1, sheenRoughness: 0.7 };

/** Parameters by id, past the colour (which is the 3D view's). */
const TABLE: Record<string, Omit<PhotoParams, 'color'>> = {
  'wood-oak': WOOD_FLOOR,
  'wood-walnut': WOOD_FLOOR,
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
  'furniture-fabric': FABRIC,
  'furniture-fabric-light': FABRIC,
  'furniture-white': { roughness: 0.45 },
  'furniture-charcoal': { roughness: 0.45 },
  'furniture-metal': { metalness: 1, roughness: 0.35 },
  'furniture-glass': { roughness: 0.05, clearcoat: 1 },
  'furniture-ceramic': { roughness: 0.2, clearcoat: 1 },
  'furniture-leaf': { roughness: 0.7, sheen: 0.3 },
  'furniture-figure': { roughness: 0.85 },
  faceplate: { roughness: 0.3, emissive: '#000000' },
  'furniture-placeholder': { roughness: 1 },
};

/** A matt emulsion: presets, custom `paint-#rrggbb` and ceilings. */
const PAINT = { roughness: 0.9, specularIntensity: 0.3 };

export const CLEAR_GLASS: PhotoParams = {
  color: '#f4faf8',
  roughness: 0,
  transmission: 1,
  ior: 1.5,
  thickness: 0,
};
export const FROSTED_GLASS: PhotoParams = {
  color: '#f4faf8',
  roughness: 0.45,
  transmission: 1,
  ior: 1.5,
  thickness: 0,
};

/** The exact render's parameters for material `id` (lamps on: a shade glows). */
export function photoParams(id: string, lamps = false): PhotoParams {
  const base = paletteEntry(id);
  const color = base.color;
  if (id === 'furniture-lamp') {
    return { color, roughness: 0.9, ...(lamps ? { emissive: SHADE_GLOW } : {}) };
  }
  const row = TABLE[id];
  if (row) return { color, ...row };
  // Paints (and wallpapers, which keep their own roughness and are drawn with their pattern).
  if (id.startsWith('paint-') && finish(id)) return { color, ...PAINT };
  return { color, roughness: base.roughness };
}

/** A path tracer's per-material flag: false lets light through it to the lamp inside. */
type Traced = THREE.MeshPhysicalMaterial & { castShadow?: boolean };

/** `photoParams` as a material; a wallpaper gets its pattern as its map. */
export function photoMaterial(id: string, lamps = false): THREE.MeshPhysicalMaterial {
  const p = photoParams(id, lamps);
  const map = wallpaperTexture(id);
  const m = physical(p, map);
  m.name = id;
  // A shade holds its lamp's bulb: the bulb's light passes through it (it glows instead).
  if (id === 'furniture-lamp') (m as Traced).castShadow = false;
  return m;
}

function physical(p: PhotoParams, map: THREE.Texture | null = null): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: map ? '#ffffff' : p.color,
    map,
    roughness: p.roughness,
    metalness: p.metalness ?? 0,
    clearcoat: p.clearcoat ?? 0,
    clearcoatRoughness: p.clearcoatRoughness ?? 0,
    sheen: p.sheen ?? 0,
    sheenRoughness: p.sheenRoughness ?? 1,
    sheenColor: p.sheen ? p.color : '#000000',
    specularIntensity: p.specularIntensity ?? 1,
    transmission: p.transmission ?? 0,
    ior: p.ior ?? 1.5,
    thickness: p.thickness ?? 0,
    emissive: p.emissive ?? '#000000',
  });
  if (p.emissive && p.emissive !== '#000000') m.emissiveIntensity = SHADE_LUMINANCE;
  return m;
}

/**
 * The exact render's material set, handed to `LevelMeshes` in place of the 3D view's
 * `MaterialCache`: the same ids, so the same meshes, only lit for real.
 */
export class PhotoMaterials implements MaterialSource {
  private cache = new Map<string, THREE.MeshPhysicalMaterial>();
  private models = new Map<string, THREE.Material>();
  readonly glass = physical(CLEAR_GLASS);
  readonly frosted = physical(FROSTED_GLASS);

  constructor(private readonly lamps = false) {
    this.glass.name = 'glass';
    this.frosted.name = 'frosted';
  }

  get(id: string): THREE.MeshPhysicalMaterial {
    let m = this.cache.get(id);
    if (!m) {
      m = photoMaterial(id, this.lamps);
      this.cache.set(id, m);
    }
    return m;
  }

  /**
   * A model's own material made ready for the render: a standard one kept with its maps; a
   * Basic, Lambert or Phong one (an uploaded model's) made standard with the same colour and
   * map; plain see-through glass (as the model pipeline makes it) made transmissive. In a
   * lamp (`shade`), nothing blocks the bulb's light. The model's material is left as it is
   * (the 3D view shares it).
   */
  model(src: THREE.Material, shade = false): THREE.Material {
    const key = `${src.uuid}/${shade}`;
    let m = this.models.get(key);
    if (m) return m;
    m = convertModelMaterial(src);
    if (shade) {
      if (m === src) m = src.clone();
      (m as Traced).castShadow = false;
    }
    this.models.set(key, m);
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      m.map?.dispose();
      m.dispose();
    }
    for (const [key, m] of this.models) {
      // Only the copies made here; a model's own material belongs to the library.
      if (!key.startsWith(`${m.uuid}/`)) m.dispose();
    }
    this.glass.dispose();
    this.frosted.dispose();
    this.cache.clear();
    this.models.clear();
  }
}

/** See `PhotoMaterials.model`; returns `src` itself when it needs nothing. */
export function convertModelMaterial(src: THREE.Material): THREE.Material {
  if (src instanceof THREE.MeshStandardMaterial) {
    // Plain glass (no texture, see-through): transmissive, as the windows are.
    if (src.transparent && src.opacity < 1 && !src.map) {
      const m = physical({
        ...CLEAR_GLASS,
        color: `#${src.color.getHexString()}`,
        roughness: src.roughness,
      });
      m.name = src.name;
      return m;
    }
    return src;
  }
  if (
    src instanceof THREE.MeshBasicMaterial ||
    src instanceof THREE.MeshLambertMaterial ||
    src instanceof THREE.MeshPhongMaterial
  ) {
    const m = new THREE.MeshStandardMaterial({
      color: src.color,
      map: src.map,
      roughness: 0.8,
      side: src.side,
      transparent: src.transparent,
      opacity: src.opacity,
      alphaTest: src.alphaTest,
    });
    m.name = src.name;
    return m;
  }
  return src;
}
