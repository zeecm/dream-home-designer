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

/**
 * Past this many samples the denoiser starts to fade, gone DENOISE_FADE samples later (a
 * room lit only through its windows is still grainy at Good's 256, so it fades slowly).
 */
export const DENOISE_UNTIL = 64;
export const DENOISE_FADE = 448;
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
 * encoded as sRGB. Its licence notice is in the shader text itself, so it ships with it.
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
        // smartDeNoise, from glslSmartDeNoise: https://github.com/BrutPitt/glslSmartDeNoise
        // Copyright (c) 2018-2019 Michele Morrone. All rights reserved.
        // Redistribution and use in source and binary forms, with or without modification,
        // are permitted provided that the following conditions are met: 1. Redistributions of
        // source code must retain the above copyright notice, this list of conditions and the
        // following disclaimer. 2. Redistributions in binary form must reproduce the above
        // copyright notice, this list of conditions and the following disclaimer in the
        // documentation and/or other materials provided with the distribution.
        // THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
        // EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
        // OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT
        // SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
        // INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
        // TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
        // BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
        // CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY
        // WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
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
export const denoiseThreshold = (n: number) => 0.1 + 0.9 / Math.sqrt(Math.max(1, n));

/** The denoiser's share of the picture after `n` samples: all of it, then fading out. */
export const denoiseAmount = (n: number) =>
  n <= DENOISE_UNTIL ? 1 : Math.max(0, 1 - (n - DENOISE_UNTIL) / DENOISE_FADE);

export class PathTracerEngine implements ExactEngine {
  readonly canvas = document.createElement('canvas');
  readonly snapshot = document.createElement('canvas');
  /** The tracer has drawn in this context (its shader is built on the GPU, not just linked). */
  drawn = false;
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
  private claims = 0;
  /** The whole sample the snapshot was last taken at (-1: none yet). */
  private kept = -1;
  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  private opts: ExactEngineOptions;

  constructor(opts: ExactEngineOptions) {
    this.opts = opts;
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new ExactUnsupported(NO_WEBGL2, 'webgl2');
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context: gl });
      this.renderer = renderer;
      renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      if (!renderer.extensions.has('EXT_color_buffer_float')) {
        throw new ExactUnsupported(NO_WEBGL2, 'webgl2');
      }
      const precision = new PrecisionDetector(renderer).detect();
      if (!precision.pass) throw new ExactUnsupported(BAD_DEVICE, 'device');
      this.tracer = new WebGLPathTracer(renderer);
    } catch (e) {
      // Nothing kept: the context goes now, not when the page does.
      this.canvas.removeEventListener('webglcontextlost', this.onLost);
      renderer?.dispose();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw e;
    }
    this.inner = this.tracer as unknown as Internals;
    // Smooths the bright sparks a glossy bounce off a lit surface can leave.
    this.tracer.filterGlossyFactor = 0.5;
    this.tracer.multipleImportanceSampling = true;
    const linear = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.display = new THREE.WebGLRenderTarget(1, 1, linear);
    // Sized as it meters (see luminance()).
    this.measureTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.configure(opts);
  }

  configure(opts: ExactEngineOptions): void {
    this.opts = opts;
    const { width, height } = opts;
    this.renderer.setSize(width, height, false);
    this.snapshot.width = width;
    this.snapshot.height = height;
    this.tracer.textureSize.set(opts.textureSize, opts.textureSize);
    this.tracer.bounces = opts.bounces;
    this.tracer.transmissiveBounces = opts.transmissiveBounces;
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    full.tiles.set(opts.tiles, opts.tiles);
    full.setSize(width, height);
    // The library's quarter-size preview isn't used: the first picture shown is a whole,
    // metered sample.
    low.setSize(1, 1);
    this.display.setSize(width, height);
  }

  claim(): number {
    this.claims++;
    return this.claims;
  }

  release(token: number): void {
    if (token !== this.claims || this.disposed) return;
    this.stopped = true;
    this.clearFence();
    if (this.lost) return;
    // The scene's BVH, materials, textures and sky go (an empty scene in their place), and
    // the pictures shrink to nothing; the compiled shader stays for the next render.
    this.tracer.setScene(new THREE.Scene(), new THREE.PerspectiveCamera());
    const { _pathTracer: full, _lowResPathTracer: low } = this.inner;
    full.setSize(1, 1);
    low.setSize(1, 1);
    this.display.setSize(1, 1);
    this.measureTarget.setSize(1, 1);
  }

  private clearFence() {
    if (this.fence && !this.lost) {
      (this.renderer.getContext() as WebGL2RenderingContext).deleteSync(this.fence);
    }
    this.fence = null;
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
    const full = this.inner._pathTracer;
    this.stopped = false;
    this.clearFence();
    this.quick = 0;
    this.kept = -1;
    this.snapshot.getContext('2d')?.clearRect(0, 0, this.snapshot.width, this.snapshot.height);
    this.configure(this.opts);
    this.tracer.setScene(flattenForTracing(scene), camera);
    // Without float blending the tracer averages samples itself, in two targets.
    const alpha = !this.renderer.extensions.has('EXT_float_blend');
    full.alpha = alpha;
    full.reset();
    // The first update sets the shader's defines for this scene and starts its compile
    // (in parallel where the browser can).
    full.update();
    const began = performance.now();
    while (full.isCompiling) {
      if (this.stopped || signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      if (this.lost) throw new ExactUnsupported(BAD_DEVICE, 'lost');
      if (performance.now() - began > COMPILE_LIMIT)
        throw new ExactUnsupported(NO_START, 'compile');
      await new Promise((r) => setTimeout(r, 16));
    }
    if (this.lost) throw new ExactUnsupported(BAD_DEVICE, 'lost');
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw new ExactUnsupported(BAD_DEVICE, 'lost');
    // A shader the driver couldn't link: no picture would ever come. (Without
    // KHR_parallel_shader_compile some drivers, SwiftShader among them, compile on the first
    // draw instead; that stall can't be timed from here.)
    for (const p of this.renderer.info.programs ?? []) {
      const program = (p as { program?: WebGLProgram }).program;
      if (program && !gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new ExactUnsupported(NO_START, 'compile');
      }
    }
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
    else if (ms > 100 && tilePx > 256 * 256 && n < 8) next = n + 1;
    // Only between samples: a sample's tiles are laid out as it starts.
    if (next !== n && Number.isInteger(full.samples)) {
      full.tiles.set(next, next);
      this.quick = 0;
    }
  }

  sample(): boolean {
    if (this.lost || this.stopped || !this.done()) return false;
    // A tile of the next sample; the picture shown is only ever of whole samples' worth
    // (covered until the first is metered).
    this.inner._pathTracer.update();
    this.show();
    this.drawn = true;
    this.keep();
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.issued = performance.now();
    return true;
  }

  /**
   * Copies the picture just drawn to the snapshot: the first, then every 4 samples (the copy
   * is a read back from the GPU, so not every step).
   */
  private keep(force = false) {
    const n = Math.floor(this.inner._pathTracer.samples);
    if (!force && this.kept >= 0 && n < this.kept + 4) return;
    this.kept = n;
    const c = this.snapshot.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, this.snapshot.width, this.snapshot.height);
    c.drawImage(this.canvas, 0, 0, this.snapshot.width, this.snapshot.height);
  }

  /** Tiles a side, as now (it adapts to the GPU). */
  get tiles(): number {
    return this.inner._pathTracer.tiles.x;
  }

  show(): void {
    if (this.lost) return;
    const full = this.inner._pathTracer;
    this.draw(full.target, full.samples);
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
    u(this.showPass, 'sigma').value = samples < 16 ? 7 : samples < 64 ? 5 : 4;
    this.quad.material = this.showPass;
    this.quad.render(r);
  }

  async luminance(): Promise<number> {
    if (this.lost || this.stopped) return 0;
    const full = this.inner._pathTracer;
    const source = full.target;
    const r = this.renderer;
    // Blocks of the picture, each the mean of many pixels (an interior lit through its windows
    // is mostly dark specks around bright ones for its first samples): 6 across for the first
    // samples, 12 once they add up.
    const across = Math.max(1, Math.min(full.samples >= 4 ? 12 : 6, Math.floor(source.width / 4)));
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
    // Drawn and read in one go: the canvas needn't keep its picture between frames. A lost
    // context has none: the snapshot is what is left.
    const from = this.lost ? this.snapshot : this.canvas;
    if (!this.lost) {
      this.show();
      this.keep(true);
    }
    return new Promise((resolve, reject) =>
      from.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
    );
  }

  stop(): void {
    this.stopped = true;
    // What is on screen now is kept, should the context be lost later.
    if (!this.lost) {
      this.show();
      this.keep(true);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.clearFence();
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
    if (!this.lost) this.renderer.forceContextLoss();
  }
}
