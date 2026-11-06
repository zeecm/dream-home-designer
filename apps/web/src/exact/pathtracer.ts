import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
// Not exported from the package's index in 0.0.23: the precision check, from its source.
import { PrecisionDetector } from 'three-gpu-pathtracer/src/detectors/PrecisionDetector.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  BAD_DEVICE,
  type ExactEngine,
  type ExactEngineOptions,
  ExactUnsupported,
  NO_START,
  NO_WEBGL2,
} from './engine';
import { logMean } from './exposure';
import { flattenForTracing } from './flatten';

/**
 * `ExactEngine` on three-gpu-pathtracer 0.0.23 (WebGL 2). Its `WebGLPathTracer` builds the
 * scene for tracing (BVH, packed materials and textures, lights, the sky's importance map);
 * we drive its two tracers ourselves: a quarter-size one gives a first picture at once, the
 * full-size one adds a tile per step. The picture is shown through our own passes: exposure
 * and AgX tone mapping, then an edge-keeping denoise that fades out as samples add up.
 */

/** The tracer's internals this adapter drives (the library is pinned, so they hold still). */
interface Tracer {
  samples: number;
  tiles: THREE.Vector2;
  material: THREE.ShaderMaterial & { bounces: number; transmissiveBounces: number };
  target: THREE.WebGLRenderTarget;
  alpha: boolean;
  isCompiling: boolean;
  setSize(w: number, h: number): void;
  update(): void;
  reset(): void;
  dispose(): void;
}
interface Internals {
  _pathTracer: Tracer;
  _lowResPathTracer: Tracer;
  _quad: FullScreenQuad;
}

/** Past this many samples the denoiser starts to fade, gone by twice as many. */
export const DENOISE_UNTIL = 64;
/** The first picture is traced at this fraction of the size. */
const LOW_RES = 0.25;
/** A shader compile longer than this is a device that can't. */
const COMPILE_LIMIT = 30_000;

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** The traced light, exposed and tone mapped (AgX) to display light, still linear. */
class TonePass extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: { map: { value: null }, toneMappingExposure: { value: 1 } },
      vertexShader: quadVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec2 vUv;
        #include <common>
        ${THREE.ShaderChunk.tonemapping_pars_fragment}
        void main() {
          vec4 c = texture2D(map, vUv);
          // A tracer without float blending keeps its samples premultiplied.
          vec3 rgb = c.a > 0.0 ? c.rgb / max(c.a, 1e-6) : c.rgb;
          gl_FragColor = vec4(AgXToneMapping(max(rgb, vec3(0.0))), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }
}

/**
 * The picture to the canvas: an edge-keeping smooth (glslSmartDeNoise, Michele Morrone,
 * BSD-2, as the library's DenoiseMaterial) mixed with the plain picture by `amount`, then
 * encoded as sRGB.
 */
class ShowPass extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: {
        map: { value: null },
        amount: { value: 1 },
        sigma: { value: 4 },
        threshold: { value: 0.08 },
      },
      vertexShader: quadVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform float amount;
        uniform float sigma;
        uniform float threshold;
        varying vec2 vUv;
        #define INV_SQRT_OF_2PI 0.39894228040143267793994605993439
        #define INV_PI 0.31830988618379067153776752674503
        vec4 smartDeNoise(sampler2D tex, vec2 uv) {
          float radius = round(sigma);
          float radQ = radius * radius;
          float invSigmaQx2 = 0.5 / (sigma * sigma);
          float invSigmaQx2PI = INV_PI * invSigmaQx2;
          float invThresholdSqx2 = 0.5 / (threshold * threshold);
          float invThresholdSqrt2PI = INV_SQRT_OF_2PI / threshold;
          vec4 centrPx = texture2D(tex, uv);
          float zBuff = 0.0;
          vec4 aBuff = vec4(0.0);
          vec2 size = vec2(textureSize(tex, 0));
          vec2 d;
          for (d.x = -radius; d.x <= radius; d.x++) {
            float pt = sqrt(radQ - d.x * d.x);
            for (d.y = -pt; d.y <= pt; d.y++) {
              float blurFactor = exp(-dot(d, d) * invSigmaQx2) * invSigmaQx2PI;
              vec4 walkPx = texture2D(tex, uv + d / size);
              vec4 dC = walkPx - centrPx;
              float deltaFactor = exp(-dot(dC.rgb, dC.rgb) * invThresholdSqx2) * invThresholdSqrt2PI * blurFactor;
              zBuff += deltaFactor;
              aBuff += deltaFactor * walkPx;
            }
          }
          return aBuff / zBuff;
        }
        void main() {
          vec4 plain = texture2D(map, vUv);
          gl_FragColor = amount > 0.0 ? mix(plain, smartDeNoise(map, vUv), amount) : plain;
          gl_FragColor.a = 1.0;
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }
}

/**
 * The picture's luminance in blocks (each the mean of up to 16 × 16 points across it), read
 * back small to set the exposure. Early samples are mostly dark specks around a few bright
 * ones: block means meter them as the finished picture will look, where single pixels
 * would read as black.
 */
class MeasurePass extends THREE.ShaderMaterial {
  constructor() {
    super({
      uniforms: { map: { value: null }, blocks: { value: new THREE.Vector2(1, 1) } },
      vertexShader: quadVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec2 blocks;
        varying vec2 vUv;
        void main() {
          vec2 size = vec2(textureSize(map, 0));
          vec2 block = size / blocks;
          vec2 origin = floor(vUv * blocks) * block;
          vec2 step = max(block / 16.0, vec2(1.0));
          float sum = 0.0;
          float n = 0.0;
          for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
              vec2 p = origin + (vec2(float(x), float(y)) + 0.5) * step;
              if (p.x >= origin.x + block.x || p.y >= origin.y + block.y) continue;
              vec4 c = texelFetch(map, ivec2(p), 0);
              vec3 rgb = c.a > 0.0 ? c.rgb / max(c.a, 1e-6) : c.rgb;
              float l = dot(max(rgb, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
              if (l == l && l < 1e30) {
                sum += l;
                n += 1.0;
              }
            }
          }
          gl_FragColor = vec4(n > 0.0 ? sum / n : 0.0, 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }
}

/** A material's uniform, by name (each pass declares the ones it sets). */
const u = (m: THREE.ShaderMaterial, name: string) => m.uniforms[name] as THREE.IUniform;

/** How different (display light, 0 to 1) a neighbour may be and still be smoothed in. */
export const denoiseThreshold = (n: number) => 0.08 + 0.5 / Math.sqrt(Math.max(1, n));

/** The denoiser's share of the picture after `n` samples: all of it, then fading out. */
export const denoiseAmount = (n: number) =>
  n <= DENOISE_UNTIL ? 1 : Math.max(0, 1 - (n - DENOISE_UNTIL) / DENOISE_UNTIL);

export class PathTracerEngine implements ExactEngine {
  readonly canvas = document.createElement('canvas');
  lost = false;
  private renderer: THREE.WebGLRenderer;
  private tracer: WebGLPathTracer;
  private inner: Internals;
  private display: THREE.WebGLRenderTarget;
  private measureTarget: THREE.WebGLRenderTarget;
  private tone = new TonePass();
  private showPass = new ShowPass();
  private measurePass = new MeasurePass();
  private quad = new FullScreenQuad(this.tone);
  private exposureValue = 1;
  private stopped = false;
  private disposed = false;
  private fence: WebGLSync | null = null;
  private issued = 0;
  private quick = 0;
  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  constructor(private readonly opts: ExactEngineOptions) {
    this.canvas.width = opts.width;
    this.canvas.height = opts.height;
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new ExactUnsupported(NO_WEBGL2, 'webgl2');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context: gl });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(opts.width, opts.height, false);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) {
      throw new ExactUnsupported(NO_WEBGL2, 'webgl2');
    }
    const precision = new PrecisionDetector(this.renderer).detect();
    if (!precision.pass) throw new ExactUnsupported(BAD_DEVICE, 'device');

    this.tracer = new WebGLPathTracer(this.renderer);
    this.inner = this.tracer as unknown as Internals;
    this.tracer.textureSize.set(opts.textureSize, opts.textureSize);
    this.tracer.bounces = opts.bounces;
    this.tracer.transmissiveBounces = opts.transmissiveBounces;
    // Smooths the bright sparks a glossy bounce off a lit surface can leave.
    this.tracer.filterGlossyFactor = 0.5;
    this.tracer.multipleImportanceSampling = true;
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    full.tiles.set(opts.tiles, opts.tiles);
    full.setSize(opts.width, opts.height);
    low.setSize(
      Math.max(1, Math.floor(opts.width * LOW_RES)),
      Math.max(1, Math.floor(opts.height * LOW_RES)),
    );
    const linear = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.display = new THREE.WebGLRenderTarget(opts.width, opts.height, linear);
    // Sized as it meters (see luminance()).
    this.measureTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
  }

  get samples(): number {
    return this.inner._pathTracer.samples;
  }

  get exposure(): number {
    return this.exposureValue;
  }

  set exposure(v: number) {
    this.exposureValue = v;
  }

  async start(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    signal?: AbortSignal,
  ): Promise<void> {
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    this.tracer.setScene(flattenForTracing(scene), camera);
    // Without float blending the tracer averages samples itself, in two targets.
    const alpha = !this.renderer.extensions.has('EXT_float_blend');
    full.alpha = alpha;
    low.alpha = alpha;
    low.material = full.material;
    full.reset();
    low.reset();
    // The first update sets the shader's defines for this scene and starts its compile
    // (in parallel where the browser can).
    full.update();
    const began = performance.now();
    while (full.isCompiling || low.isCompiling) {
      if (this.stopped || signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      if (this.lost) throw new ExactUnsupported(BAD_DEVICE, 'lost');
      if (performance.now() - began > COMPILE_LIMIT)
        throw new ExactUnsupported(NO_START, 'compile');
      await new Promise((r) => setTimeout(r, 16));
    }
    if (this.lost) throw new ExactUnsupported(BAD_DEVICE, 'lost');
    const gl = this.renderer.getContext();
    // A shader the driver couldn't link: no picture would ever come.
    const programs = this.renderer.info.programs ?? [];
    const program = programs[programs.length - 1] as
      | { diagnostics?: { runnable: boolean } }
      | undefined;
    if (program?.diagnostics && !program.diagnostics.runnable) {
      throw new ExactUnsupported(NO_START, 'compile');
    }
    if (gl.isContextLost()) throw new ExactUnsupported(BAD_DEVICE, 'lost');
  }

  /**
   * Whether the GPU has done the last step. Steps are never queued one behind another, so
   * Stop and Close answer at once, and a slow GPU isn't handed more than it can draw.
   */
  private done(): boolean {
    if (!this.fence) return true;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
    gl.deleteSync(this.fence);
    this.fence = null;
    this.adapt(performance.now() - this.issued);
    return true;
  }

  /**
   * Tiles sized to the GPU: a step that comes back within a frame gets bigger tiles (fewer a
   * side), one that takes over 100 ms smaller ones, so each step stays a frame or two.
   */
  private adapt(ms: number) {
    if (this.opts.adaptive === false) return;
    const full = this.inner._pathTracer;
    const n = full.tiles.x;
    const tilePx = (this.opts.width * this.opts.height) / (n * n);
    if (ms < 20) this.quick++;
    else this.quick = 0;
    let next = n;
    if (this.quick >= 4 && n > 1) next = n - 1;
    else if (ms > 100 && tilePx > 128 * 128 && n < 8) next = n + 1;
    // Only between samples: a sample's tiles are laid out as it starts.
    if (next !== n && Number.isInteger(full.samples)) {
      full.tiles.set(next, next);
      this.quick = 0;
    }
  }

  sample(): boolean {
    if (this.lost || this.stopped || !this.done()) return false;
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    // A whole quarter-size picture first (one tile, one sample), then the full size.
    if (low.samples < 1) {
      low.update();
      this.draw(low.target);
    } else {
      full.update();
      this.show();
    }
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.issued = performance.now();
    return true;
  }

  /** Tiles a side, as now (it adapts to the GPU). */
  get tiles(): number {
    return this.inner._pathTracer.tiles.x;
  }

  show(): void {
    if (this.lost) return;
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    this.draw(full.samples >= 1 ? full.target : low.target, full.samples);
  }

  private draw(target: THREE.WebGLRenderTarget, samples = 0) {
    const r = this.renderer;
    u(this.tone, 'map').value = target.texture;
    u(this.tone, 'toneMappingExposure').value = this.exposureValue;
    r.toneMappingExposure = this.exposureValue;
    this.quad.material = this.tone;
    r.setRenderTarget(this.display);
    this.quad.render(r);
    r.setRenderTarget(null);
    u(this.showPass, 'map').value = this.display.texture;
    u(this.showPass, 'amount').value = denoiseAmount(samples);
    // Early on, specks stand far from their neighbours: smoothed across wider differences
    // and further, tightening (edges kept) as the samples settle.
    u(this.showPass, 'threshold').value = denoiseThreshold(samples);
    u(this.showPass, 'sigma').value = samples < 4 ? 6 : 4;
    this.quad.material = this.showPass;
    this.quad.render(r);
  }

  async luminance(): Promise<number> {
    if (this.lost || this.stopped) return 0;
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    const source = full.samples >= 1 ? full.target : low.target;
    const r = this.renderer;
    // Blocks of the picture, each the mean of many pixels (an interior lit through its windows
    // is mostly dark specks around bright ones for its first samples): 12 across once samples
    // add up,
    // 4 across the first (quarter-size, one sample) picture, whose pixels are mostly specks.
    const across = Math.max(1, Math.min(full.samples >= 1 ? 12 : 4, Math.floor(source.width / 4)));
    const down = Math.max(1, Math.round((across * source.height) / source.width));
    const t = this.measureTarget;
    if (t.width !== across || t.height !== down) t.setSize(across, down);
    u(this.measurePass, 'map').value = source.texture;
    (u(this.measurePass, 'blocks').value as THREE.Vector2).set(t.width, t.height);
    this.quad.material = this.measurePass;
    r.setRenderTarget(t);
    this.quad.render(r);
    const px = new Float32Array(t.width * t.height * 4);
    const read = r.readRenderTargetPixelsAsync(t, 0, 0, t.width, t.height, px);
    r.setRenderTarget(null);
    await read;
    return logMean(px, 4);
  }

  readPixels(): Promise<Blob> {
    // Drawn and read in one go: the canvas needn't keep its picture between frames.
    this.show();
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
    );
  }

  stop(): void {
    this.stopped = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    if (this.fence) (this.renderer.getContext() as WebGL2RenderingContext).deleteSync(this.fence);
    this.fence = null;
    const { _pathTracer: full, _lowResPathTracer: low, _quad } = this.inner;
    // The library's own dispose() trips on a field it never sets; its parts are freed here.
    full.dispose();
    low.dispose();
    _quad.dispose();
    (_quad.material as THREE.Material).dispose();
    this.display.dispose();
    this.measureTarget.dispose();
    this.tone.dispose();
    this.showPass.dispose();
    this.measurePass.dispose();
    this.quad.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
