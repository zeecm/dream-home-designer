import { FLOOR_FINISHES, PAINTS } from '@dhd/core';
import * as THREE from 'three';

/**
 * Phase 0 palette: flat colours keyed by material id. Phase 3 swaps these for PBR
 * textures from the catalogue manifest without changing any ids in saved projects.
 */
const palette: Record<string, { color: string; roughness: number; emissive?: string }> = {
  ...Object.fromEntries(
    [...FLOOR_FINISHES, ...PAINTS].map((f) => [f.id, { color: f.color, roughness: f.roughness }]),
  ),
  door: { color: '#c9b08a', roughness: 0.6 },
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
  // A model still loading: a quiet box of its size.
  'furniture-placeholder': { color: '#d6dade', roughness: 1 },
  // A lit shade: it glows whatever falls on it.
  'furniture-lamp': { color: '#fff4e0', roughness: 0.9, emissive: '#ffe2b8' },
};
const fallback: (typeof palette)[string] = { color: '#ff00ff', roughness: 1 };

export class MaterialCache {
  private cache = new Map<string, THREE.Material>();
  readonly glass = new THREE.MeshStandardMaterial({
    color: '#9cc7e0',
    transparent: true,
    opacity: 0.25,
    roughness: 0.05,
    depthWrite: false,
  });

  get(id: string): THREE.Material {
    let m = this.cache.get(id);
    if (!m) {
      const p = palette[id] ?? fallback;
      m = new THREE.MeshStandardMaterial({
        color: p.color,
        roughness: p.roughness,
        emissive: p.emissive ?? '#000000',
      });
      m.name = id;
      this.cache.set(id, m);
    }
    return m;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    this.glass.dispose();
    this.cache.clear();
  }
}
