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
            o.castShadow = true;
            o.receiveShadow = true;
            o.userData.shared = true;
          }
        });
        this.loading.delete(file);
        this.loaded.set(file, gltf.scene);
        for (const fn of this.listeners) fn();
      },
      () => {
        // Missing or broken: the stand-in box stays, rather than retrying every frame.
        this.loading.delete(file);
        this.failed.add(file);
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
