// three-gpu-pathtracer 0.0.23 ships its detectors as source without types.
declare module 'three-gpu-pathtracer/src/detectors/PrecisionDetector.js' {
  import type { WebGLRenderer } from 'three';
  export class PrecisionDetector {
    constructor(renderer: WebGLRenderer);
    detect(): { pass: boolean; message: string };
  }
}
