import { FLOOR_FINISHES, PAINTS, WALLPAPERS, finish } from '@dhd/core';
import * as THREE from 'three';
import { TILE, isWallpaper, wallpaperCanvas } from './wallpaper';

/**
 * Phase 0 palette: flat colours keyed by material id. Phase 3 swaps these for PBR
 * textures from the catalogue manifest without changing any ids in saved projects.
 */
const palette: Record<string, { color: string; roughness: number; emissive?: string }> = {
  ...Object.fromEntries(
    [...FLOOR_FINISHES, ...PAINTS, ...WALLPAPERS].map((f) => [
      f.id,
      { color: f.color, roughness: f.roughness },
    ]),
  ),
  door: { color: '#c9b08a', roughness: 0.6 },
  // Sockets' and switches' plates, an aircon unit, its trunking and compressor.
  faceplate: { color: '#ffffff', roughness: 0.3, emissive: '#3a3a3a' },
  'faceplate-detail': { color: '#55595e', roughness: 0.5 },
  // Glass partitions' and fixed glass's frames: powder-coated aluminium.
  aluminium: { color: '#3d4247', roughness: 0.45 },
  'furniture-wood': { color: '#b98c5f', roughness: 0.6 },
  'furniture-wood-dark': { color: '#5b4030', roughness: 0.6 },
  'furniture-fabric': { color: '#7d8590', roughness: 0.95 },
  'furniture-fabric-light': { color: '#ddd7cb', roughness: 0.95 },
  'furniture-white': { color: '#f2f0eb', roughness: 0.5 },
  'furniture-charcoal': { color: '#34373b', roughness: 0.5 },
  'furniture-metal': { color: '#b9bec4', roughness: 0.35 },
  'furniture-glass': { color: '#22272b', roughness: 0.1 },
  'furniture-ceramic': { color: '#fbfbf9', roughness: 0.2 },
  'furniture-leaf': { color: '#5d8a4e', roughness: 0.8 },
  'furniture-figure': { color: '#a7b0b9', roughness: 0.85 },
  // A model still loading: a quiet box of its size.
  'furniture-placeholder': { color: '#d6dade', roughness: 1 },
  // A lit shade: it glows whatever falls on it.
  'furniture-lamp': { color: '#fff4e0', roughness: 0.9, emissive: '#ffe2b8' },
};
const fallback: (typeof palette)[string] = { color: '#ff00ff', roughness: 1 };

/** A material id's colour and roughness as the 3D view draws it (magenta for an unknown id). */
export function paletteEntry(id: string): { color: string; roughness: number; emissive?: string } {
  const custom = palette[id] ? undefined : finish(id);
  return palette[id] ?? (custom ? { color: custom.color, roughness: custom.roughness } : fallback);
}

/** Where `LevelMeshes` gets its materials: the 3D view's, or the exact render's. */
export interface MaterialSource {
  get(id: string): THREE.Material;
  /** Clear glass: windows, glass walls, clear-glazed door leaves. */
  readonly glass: THREE.Material;
  /** Frosted or fluted glass in a door. */
  readonly frosted: THREE.Material;
}

/** A wallpaper's pattern as a texture, tiled at its real size (wall UVs run in metres). */
export function wallpaperTexture(id: string): THREE.CanvasTexture | null {
  const paper = isWallpaper(id) ? wallpaperCanvas(id) : null;
  if (!paper) return null;
  const map = new THREE.CanvasTexture(paper);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / TILE, 1 / TILE);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

export class MaterialCache implements MaterialSource {
  private cache = new Map<string, THREE.Material>();
  readonly glass = new THREE.MeshStandardMaterial({
    color: '#9cc7e0',
    transparent: true,
    opacity: 0.25,
    roughness: 0.05,
    depthWrite: false,
  });

  /** Frosted or fluted glass in a door: light passes, the view doesn't. */
  readonly frosted = new THREE.MeshStandardMaterial({
    color: '#eef3f6',
    transparent: true,
    opacity: 0.72,
    roughness: 0.6,
    depthWrite: false,
  });

  get(id: string): THREE.Material {
    let m = this.cache.get(id);
    if (!m) {
      // A custom paint carries its colour in its id.
      const p = paletteEntry(id);
      const map = wallpaperTexture(id);
      m = new THREE.MeshStandardMaterial({
        color: map ? '#ffffff' : p.color,
        map,
        roughness: p.roughness,
        emissive: p.emissive ?? '#000000',
      });
      m.name = id;
      this.cache.set(id, m);
    }
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      if (m instanceof THREE.MeshStandardMaterial) m.map?.dispose();
      m.dispose();
    }
    this.glass.dispose();
    this.frosted.dispose();
    this.cache.clear();
  }
}
