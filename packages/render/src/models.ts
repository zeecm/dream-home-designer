import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Where LevelMeshes gets furniture models: a copy of one if it has loaded, or null. */
export interface ModelSource {
  /** A copy of the model (sharing its geometry and materials), or null while it loads. */
  get(file: string): THREE.Object3D | null;
  has(file: string): boolean;
}

/**
 * Loads each catalogue model once (GLB, meshopt-compressed) from `base` and hands out
 * copies. Listeners hear when one arrives, so the scene can swap its stand-in box for it.
 * The copies' meshes are marked `userData.shared`: their geometry belongs to the library.
 */
export class ModelLibrary implements ModelSource {
  private readonly loaded = new Map<string, THREE.Object3D>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  /** Tries so far per file: a dropped connection gets two more, after 5 and 30 seconds. */
  private readonly tries = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  constructor(private readonly base: string) {}

  get(file: string): THREE.Object3D | null {
    const model = this.loaded.get(file);
    if (model) return model.clone(true);
    if (!this.loading.has(file) && !this.failed.has(file)) this.load(file);
    return null;
  }

  has(file: string): boolean {
    return this.loaded.has(file);
  }

  /** Calls `fn` whenever a model finishes loading; returns the unsubscribe. */
  onLoad(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private load(file: string) {
    this.loading.add(file);
    this.loader.loadAsync(this.base + file).then(
      (gltf) => {
        gltf.scene.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            // Kept cheap to draw, since a furnished flat holds dozens of these: only big
            // pieces cast shadows, and only leaves and glass (cut-out or see-through) are
            // drawn from both sides.
            o.geometry.computeBoundingSphere();
            o.castShadow = (o.geometry.boundingSphere?.radius ?? 0) > 0.5;
            o.receiveShadow = true;
            for (const m of [o.material].flat() as THREE.Material[]) {
              if (!m.transparent && m.alphaTest === 0) m.side = THREE.FrontSide;
            }
            o.userData.shared = true;
          }
        });
        this.loading.delete(file);
        this.loaded.set(file, gltf.scene);
        for (const fn of this.listeners) fn();
      },
      () => {
        this.loading.delete(file);
        const n = (this.tries.get(file) ?? 0) + 1;
        this.tries.set(file, n);
        // Missing or broken: the stand-in box stays, retried twice, never every frame.
        this.failed.add(file);
        if (n <= 2) {
          setTimeout(
            () => {
              this.failed.delete(file);
              this.load(file);
            },
            n === 1 ? 5_000 : 30_000,
          );
        }
      },
    );
  }

  dispose(): void {
    for (const model of this.loaded.values()) {
      model.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        for (const m of [o.material].flat() as THREE.Material[]) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      });
    }
    this.loaded.clear();
  }
}
