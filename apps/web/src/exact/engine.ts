import type * as THREE from 'three';

/**
 * The exact render's engine, behind our own interface so the library under it (today
 * `three-gpu-pathtracer` 0.0.23 on WebGL 2) can be swapped for a WebGPU one when three.js is
 * upgraded. It draws progressively into its own canvas: each `sample()` call is a small step
 * of GPU work (one tile), and the picture sharpens as the steps add up.
 */
export interface ExactEngineOptions {
  /** The picture's size in pixels (the canvas's drawing buffer). */
  width: number;
  height: number;
  /** Light bounces (5 on a desktop, 3 on a phone); through glass, 6. */
  bounces: number;
  transmissiveBounces: number;
  /** Every texture is packed at this size (px square). */
  textureSize: number;
  /** The picture is drawn in this many tiles a side, one per step, to start with. */
  tiles: number;
  /** Tiles grow and shrink to keep each step about a frame's work (default on). */
  adaptive?: boolean;
}

export interface ExactEngine {
  readonly canvas: HTMLCanvasElement;
  /**
   * Builds the scene for tracing (its BVH, materials, textures, lights and sky) and compiles
   * the tracer's shader; resolves when samples can be drawn. Rejects with `ExactUnsupported`
   * when this device's graphics can't run it.
   */
  start(scene: THREE.Scene, camera: THREE.PerspectiveCamera, signal?: AbortSignal): Promise<void>;
  /**
   * One step: a tile of the next sample, then the picture shown. False (and nothing done)
   * while the GPU is still on the last step: call it once a frame.
   */
  sample(): boolean;
  /** Samples drawn so far (fractional while a sample's tiles are under way). */
  readonly samples: number;
  /** The graphics context was lost (a GPU reset): no more samples; the canvas keeps its picture. */
  readonly lost: boolean;
  /**
   * The picture's log-average luminance so far (cd/m²), for the exposure: read back from the
   * GPU without stalling it (0 if the context is lost).
   */
  luminance(): Promise<number>;
  /** Multiplies the scene's light before tone mapping (AgX), applied at display. */
  exposure: number;
  /** Draws the picture shown again (after an exposure change, say) without a new sample. */
  show(): void;
  /** The picture as a PNG of its own pixels. */
  readPixels(): Promise<Blob>;
  /** Stops any work still pending (a compile); the picture stays. */
  stop(): void;
  /** Frees its GPU memory and its context; the canvas is left to the caller to remove. */
  dispose(): void;
}

/** This browser or device can't run the exact render; `message` says why, for people. */
export class ExactUnsupported extends Error {
  constructor(
    message: string,
    readonly reason: 'webgl2' | 'device' | 'compile' | 'lost',
  ) {
    super(message);
    this.name = 'ExactUnsupported';
  }
}

export const NO_WEBGL2 = 'Exact renders need WebGL 2, which this browser doesn’t have.';
export const BAD_DEVICE = 'This device’s graphics can’t run the exact render.';
export const NO_START = 'Couldn’t start the exact render on this device.';

/** Whether this browser has WebGL 2 with float render targets (asked once, on a spare canvas). */
export function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/** The path tracer, loaded only when an exact render is asked for (it is ~55 KB gzip). */
export async function loadEngine(opts: ExactEngineOptions): Promise<ExactEngine> {
  const { PathTracerEngine } = await import('./pathtracer');
  return new PathTracerEngine(opts);
}
