// three-gpu-pathtracer 0.0.23 ships its detectors (and utils) as source without types.
declare module 'three-gpu-pathtracer/src/core/utils/sceneUpdateUtils.js' {
  import type { Light, Object3D } from 'three';
  export function getLights(scene: Object3D): Light[];
}
declare module 'three-gpu-pathtracer/src/detectors/PrecisionDetector.js' {
  import type { WebGLRenderer } from 'three';
  export class PrecisionDetector {
    constructor(renderer: WebGLRenderer);
    detect(): { pass: boolean; message: string };
  }
}
