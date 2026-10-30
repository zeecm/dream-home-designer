import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Where LevelMeshes gets furniture models: a copy of one if it has loaded, or null. */
export interface ModelSource {
  /** A copy of the model (sharing its geometry and materials), or null while it loads. */
  get(file: string): THREE.Object3D | null;
  has(file: string): boolean;
  /**
   * An uploaded model's own size once loaded (width x, height y, depth z), which the scene
   * fits to its catalogue size; undefined for the catalogue's models, built to size.
   */
  natural?(file: string): THREE.Vector3 | undefined;
}

/** Fetches an uploaded model's bytes by its content key (`sha256:<hex>`). */
export type ModelFetch = (key: string) => Promise<ArrayBuffer>;

const UPLOADED = 'sha256:';

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
  private readonly sizes = new Map<string, THREE.Vector3>();

  /** `fetchUploaded` gets uploaded models' bytes; without it they stay as boxes. */
  constructor(
    private readonly base: string,
    private readonly fetchUploaded?: ModelFetch,
  ) {}

  natural(file: string): THREE.Vector3 | undefined {
    return this.sizes.get(file);
  }

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

  /** The model's scene: a catalogue file from `base`, or an uploaded one, centred. */
  private async scene(file: string): Promise<THREE.Object3D> {
    if (!file.startsWith(UPLOADED)) return (await this.loader.loadAsync(this.base + file)).scene;
    if (!this.fetchUploaded) throw new Error('uploaded models are not available here');
    const gltf = await this.loader.parseAsync(await this.fetchUploaded(file), '');
    // Made anywhere, by anyone: centred on its footprint with its base on the floor, as the
    // catalogue's models are built, and its size kept so the scene can fit it.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const root = new THREE.Group();
    if (!box.isEmpty()) {
      const c = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
      this.sizes.set(file, box.getSize(new THREE.Vector3()));
    }
    root.add(gltf.scene);
    return root;
  }

  private load(file: string) {
    this.loading.add(file);
    this.scene(file).then(
      (scene) => {
        scene.traverse((o) => {
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
        this.loaded.set(file, scene);
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
