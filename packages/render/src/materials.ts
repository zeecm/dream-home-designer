import * as THREE from 'three';

/**
 * Phase 0 palette: flat colours keyed by material id. Phase 3 swaps these for PBR
 * textures from the catalogue manifest without changing any ids in saved projects.
 */
const palette: Record<string, { color: string; roughness: number }> = {
  'paint-white': { color: '#f2efe9', roughness: 0.9 },
  'wood-oak': { color: '#c49a6c', roughness: 0.7 },
  'wood-walnut': { color: '#7a5233', roughness: 0.65 },
  'tile-grey': { color: '#b8b8b4', roughness: 0.4 },
};
const fallback = { color: '#ff00ff', roughness: 1 };

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
      m = new THREE.MeshStandardMaterial({ color: p.color, roughness: p.roughness });
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
