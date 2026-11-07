/**
 * Slice 0 spike (dev only, `/dev/exact-spike.html` on the dev server; not built or shipped):
 * the furnished sample flat with lamps, from eye height, through the exact render's engine.
 * Logs how long each step takes and the samples per second to `window.spike`. Query:
 * `w`, `h` (picture px), `samples`, `hour`, `room` (living, main or a room id), `tiles`,
 * `adapt=0` (fixed tiles), `glass=0` (panes left out), `view=orbit`, `ceil=0`, `models=0`,
 * `probe=auto|<window id>` (the sun patch through a window against the shade beside it),
 * `scene=plane` (`sun=1`: the ground alone), `sync=1` (wait for the GPU every step);
 * `portals=1`, `plain=1` (no furniture or lamps), `flat=hdb4` (the 4-room fixture), `day=`, `pose=x,y,yaw[,across]`, `clamp=<n>|auto`,
 * and to weigh the portals' light: `nosun=1`, `mis=0` (no light sampling), `gk=<k>` (the
 * ground's share reaching in, for GROUND_REACHES), `glow=0`, `darkground=1`. Logs black pixels, specks and luminance at
 * 32 and 64 samples and the last (`stats at`), of the picture as shown (specks spread; `raw=1`:
 * as traced), and `speck=<k>`.
 */
import {
  DEFAULT_SITE,
  type Level,
  type SceneCamera,
  dayOfYear,
  daylightReach,
  eyeLevelCamera,
  hdb4RoomLevel,
  lampsAuto,
  roomIdAt,
  sampleFlatProject,
  skyOpenings,
} from '@dhd/core';
import {
  EXACT_EXTRAS,
  ModelLibrary,
  PORTAL,
  buildExactScene,
  exactCamera,
  exactDaylight,
  portalLight,
  sampleClamp,
} from '@dhd/render';
// The test fixture of a furnished flat, straight from core's source (a dev page only).
import {
  furnishedSample,
  withPieces,
} from '../../../../packages/core/src/fixtures/furnishedSample';
import { loadEngine } from './engine';
import { autoExposure } from './exposure';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => Number(q.get(k) ?? d);
const W = num('w', 1600);
const H = num('h', 900);
const TARGET = num('samples', 64);
const HOUR = num('hour', 16);
const TILES = num('tiles', 3);
const ROOM = q.get('room') ?? 'living';
const GLASS = q.get('glass') !== '0';
const MODELS = q.get('models') !== '0';
const ORBIT = q.get('view') === 'orbit';
/** `portals=1`: lights in the sky's openings (as the app does from inside), the sky lighting none. */
const PORTALS = q.get('portals') === '1';
/** `plain=1`: the sample flat as visitors get it (no furniture or lamps). */
const PLAIN = q.get('plain') === '1';
/** `pose=x,y,yaw[,across]`: the walk's camera there (110° across by default). */
const POSE = q.get('pose');
/** `clamp=<cd/m²>|auto`: no sample brighter than this (`auto`: as the app sets it). */
const CLAMP = q.get('clamp') ?? '';

/** Black (no light at all), dark (under 5% of the median) and firefly (over 4× its 5 × 5
 * neighbourhood's median) pixel shares, and the mean, of the traced (raw) picture. */
function stats(px: Float32Array, w: number, h: number) {
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lum[i] =
      0.2126 * (px[i * 4] ?? 0) + 0.7152 * (px[i * 4 + 1] ?? 0) + 0.0722 * (px[i * 4 + 2] ?? 0);
  }
  const sorted = Float32Array.from(lum).sort();
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  let black = 0;
  let dark = 0;
  let fire = 0;
  let sum = 0;
  const nb: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = lum[y * w + x] ?? 0;
      sum += l;
      if (l <= 0) black++;
      if (l < 0.05 * median) dark++;
      nb.length = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) nb.push(lum[yy * w + xx] ?? 0);
        }
      }
      nb.sort((a, b) => a - b);
      const local = nb[Math.floor(nb.length / 2)] ?? 0;
      if (l > 4 * local && l > 0.05 * median) fire++;
    }
  }
  const n = w * h;
  return {
    black: (100 * black) / n,
    dark: (100 * dark) / n,
    fireflies: (100 * fire) / n,
    mean: sum / n,
    // The room alone: the mean of pixels within 5x the median (not the view out, nor specks).
    room: (() => {
      let t = 0;
      let k = 0;
      for (const l of lum) {
        if (l <= 5 * median) {
          t += l;
          k++;
        }
      }
      return k ? t / k : 0;
    })(),
    median,
  };
}

const log = (s: string) => {
  const el = document.getElementById('log');
  if (el) el.textContent += `${s}\n`;
  console.log(s);
};

function level(): Level {
  if (q.get('flat') === 'hdb4') return hdb4RoomLevel();
  if (PLAIN) return sampleFlatProject().levels[0] as Level;
  // Lamps to light the night: a ceiling light in each main room, a floor lamp, a pendant.
  return withPieces(
    furnishedSample(),
    [
      ['ceiling-light', { x: 8.3, y: 3.2 }],
      ['ceiling-light', { x: 1.5, y: 1.5 }],
      ['floor-lamp', { x: 9.6, y: 5.5 }],
      ['pendant', { x: 8.6, y: 3.6 }],
      ['table-lamp', { x: 5.4, y: 0.4 }],
      ['globe-pendant', { x: 4.9, y: 0.9 }],
      ['potted-ficus', { x: 9.7, y: 2.2 }],
      ['armchair-wood-leather', { x: 7.2, y: 2.4 }],
      ['coffee-table-marble', { x: 7.6, y: 4.4 }],
    ],
    'it_spike',
  );
}

/** Looking into a room from above its middle, as the orbit view would. */
function orbitInto(l: Level, roomId: string, aspect: number): SceneCamera {
  const r = l.rooms[roomId];
  const pts = (r?.loop ?? []).map((id: string) => l.vertices[id]).filter((v) => !!v) as {
    x: number;
    y: number;
  }[];
  const cx = pts.reduce((s, p) => s + p.x, 0) / Math.max(1, pts.length);
  const cy = pts.reduce((s, p) => s + p.y, 0) / Math.max(1, pts.length);
  return {
    position: { x: cx - 3, y: 8, z: cy + 4 },
    target: { x: cx, y: 0, z: cy },
    fov: (40 * Math.PI) / 180,
    aspect,
  };
}

async function main() {
  const t0 = performance.now();
  const lap = (what: string) => log(`${what}: ${(performance.now() - t0).toFixed(0)} ms`);
  const l = level();
  const roomId =
    ROOM === 'living' ? 'rm_living-and-dining' : ROOM === 'main' ? 'rm_main-bedroom' : ROOM;
  const above = orbitInto(l, roomId, W / H);
  let eye: { roomId: string | null; camera: SceneCamera } | null = ORBIT
    ? { roomId: null, camera: above }
    : eyeLevelCamera(l, above);
  if (!eye) throw new Error('no eye camera');
  if (POSE) {
    const [x = 0, y = 0, yaw = 0, across = 110] = POSE.split(',').map(Number);
    const half = (across * Math.PI) / 360;
    eye = {
      roomId: roomIdAt(l, { x, y }),
      camera: {
        position: { x, y: 1.6, z: y },
        target: { x: x + Math.cos(yaw), y: 1.6, z: y + Math.sin(yaw) },
        fov: 2 * Math.atan(Math.tan(half) / (W / H)),
        aspect: W / H,
      },
    };
  }
  // `probe=<window id>`: where the sun through that window lands on the floor, looked at from
  // across the room, with a patch beside it in shade to compare.
  const probeId = q.get('probe');
  let probe: { lit: { x: number; z: number }; shade: { x: number; z: number } } | null = null;
  if (probeId) {
    const { planGeometry, framePoint, sunDirection, sunPosition, roomsBeside } = await import(
      '@dhd/core'
    );
    const d = sunDirection(DEFAULT_SITE, sunPosition(DEFAULT_SITE, dayOfYear(new Date()), HOUR));
    // `auto`: the outside window the sun shines most squarely into.
    const facing = (p: ReturnType<typeof planGeometry>['openings'][number]) => {
      const [left, right] = roomsBeside(l, p.wallId);
      if ((left === null) === (right === null)) return -1;
      const out = left === null ? p.frame.n : { x: -p.frame.n.x, y: -p.frame.n.y };
      return (out.x * d.x + out.y * d.z) / Math.hypot(d.x, d.z);
    };
    const windows = planGeometry(l).openings.filter((p) => p.kind === 'window');
    const o =
      probeId === 'auto'
        ? windows.sort((a, b) => facing(b) - facing(a))[0]
        : windows.find((p) => p.opening.id === probeId);
    if (!o) throw new Error(`no ${probeId}`);
    log(`probe window ${o.opening.id}, facing the sun ${facing(o).toFixed(2)}`);
    const c = framePoint(o.frame, (o.span[0] + o.span[1]) / 2, 0);
    const y = o.opening.sill + o.opening.height / 2;
    const lit = { x: c.x - (d.x * y) / d.y, z: c.y - (d.z * y) / d.y };
    // A step along the wall, out of the patch.
    const shade = { x: lit.x + o.frame.d.x * 1.6, z: lit.z + o.frame.d.y * 1.6 };
    probe = { lit, shade };
    // From 3 m further into the room, at eye height, looking down at the patch.
    const away = { x: lit.x - d.x / Math.hypot(d.x, d.z), z: lit.z - d.z / Math.hypot(d.x, d.z) };
    eye = {
      roomId: eye.roomId,
      camera: {
        position: { x: lit.x + (away.x - lit.x) * 3, y: 1.6, z: lit.z + (away.z - lit.z) * 3 },
        target: { x: (lit.x + shade.x) / 2, y: 0, z: (lit.z + shade.z) / 2 },
        fov: (60 * Math.PI) / 180,
        aspect: W / H,
      },
    };
    log(`probe: sun lands at ${lit.x.toFixed(2)}, ${lit.z.toFixed(2)}`);
  }
  const models = new ModelLibrary('/models/');
  if (MODELS) {
    // Ask for every model, then wait for them (or 10 s).
    const { furnitureKind } = await import('@dhd/core');
    const files = Object.values(l.items)
      .map((it) => furnitureKind(it.assetId)?.model)
      .filter((f): f is string => !!f);
    for (const f of files) models.get(f);
    const until = performance.now() + 10_000;
    while (files.some((f) => !models.has(f)) && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    lap(`models (${files.filter((f) => models.has(f)).length}/${files.length})`);
  }
  // `day=<n>`: the day of the year (310, 6 Nov, by default: the measurements' day).
  const day = num('day', 310);
  const lit = exactDaylight(DEFAULT_SITE, day, HOUR);
  // `nosun=1`: the sky alone (to check the sky's light against a reference that finds it only
  // by chance, `mis=0`, which is unbiased whatever the sky sampling does).
  const daylight = q.get('nosun') === '1' ? { ...lit, sun: null } : lit;
  const lamps = lampsAuto(l, eye.roomId, daylight.light);
  const ceilings = !ORBIT && q.get('ceil') !== '0';
  const built = buildExactScene(l, {
    ceilings,
    models,
    daylight,
    lamps,
    portals: PORTALS && ceilings ? (eye.roomId ? daylightReach(l, eye.roomId) : true) : false,
  });
  log(`portals: ${built.portals.map((p) => p.name).join(' ')}`);
  // `glow=0`: with portals, the ground gives off none of the sky's light (to compare).
  if (q.get('glow') === '0' && built.portals.length) {
    const g = built.scene.getObjectByName(EXACT_EXTRAS.ground) as unknown as {
      material: { emissiveIntensity: number };
    };
    g.material.emissiveIntensity = 0;
  }
  // `gk=<k>`: the portals carry k of the ground's light, not GROUND_REACHES (to weigh it).
  const gk = q.get('gk');
  if (gk !== null) {
    const openings = skyOpenings(l);
    for (const p of built.portals) {
      const o = openings.find((x) => `${PORTAL}${x.id}` === p.name);
      if (!o) continue;
      const c = portalLight(l, o, daylight, Number(gk));
      const peak = Math.max(c.r, c.g, c.b, 1e-9);
      p.color.setRGB(c.r / peak, c.g / peak, c.b / peak);
      p.intensity = peak;
    }
  }
  // `darkground=1`: the ground reflects nothing (to weigh its share of a room's light).
  if (q.get('darkground') === '1') {
    const g = built.scene.getObjectByName(EXACT_EXTRAS.ground) as unknown as {
      material: { color: { setRGB(r: number, g: number, b: number): void } };
    };
    g.material.color.setRGB(0, 0, 0);
  }
  if (!GLASS) {
    built.scene.traverse((o) => {
      if (o.name.startsWith('glass:')) o.visible = false;
    });
  }
  // Just the ground under the sky (no sun): the floor should read albedo × sky radiance.
  if (q.get('scene') === 'plane') {
    built.meshes.group.visible = false;
    if (built.sun && q.get('sun') !== '1') built.sun.visible = false;
  }
  let tris = 0;
  let meshCount = 0;
  let slots = 0;
  built.scene.traverse((o) => {
    const mat = (o as { material?: unknown }).material;
    if (mat) {
      meshCount++;
      slots += Array.isArray(mat) ? mat.length : 1;
    }
    const g = (
      o as {
        geometry?: { index: { count: number } | null; attributes: { position: { count: number } } };
      }
    ).geometry;
    if (g && o.visible) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  log(`meshes ${meshCount}, material slots ${slots}`);
  lap(
    `scene built (${Math.round(tris)} triangles, lamps ${lamps ? built.lamps.length : 'off'}, sun ${!!built.sun})`,
  );
  const camera = exactCamera(eye.camera);
  log(`camera ${JSON.stringify(eye.camera)} room ${eye.roomId}`);
  const tImport = performance.now();
  const engine = await loadEngine({
    width: W,
    height: H,
    bounces: 5,
    transmissiveBounces: 6,
    textureSize: 1024,
    tiles: TILES,
    adaptive: q.get('adapt') !== '0',
  });
  log(`engine chunk loaded: ${(performance.now() - tImport).toFixed(0)} ms`);
  engine.canvas.style.width = `${Math.min(W, 960)}px`;
  document.getElementById('out')?.append(engine.canvas);
  const tStart = performance.now();
  if (q.get('mis') === '0') {
    (
      engine as unknown as { tracer: { multipleImportanceSampling: boolean } }
    ).tracer.multipleImportanceSampling = false;
  }
  if (CLAMP) engine.clamp = CLAMP === 'auto' ? sampleClamp(daylight) : Number(CLAMP);
  // `speck=<k>`: specks spread past k times their neighbours (0: none; default as the app).
  const speck = q.get('speck');
  if (speck !== null) (engine as unknown as { speck: number }).speck = Number(speck);
  await engine.start(built.scene, camera);
  const prepared = performance.now();
  log(`prepare (BVH, textures, compile): ${(prepared - tStart).toFixed(0)} ms`);
  lap('ready');
  let firstPicture = 0;
  let firstFull = 0;
  let exposed8 = false;
  let tAt32 = 0;
  const measured = new Set<number>();
  const allStats: unknown[] = [];
  (window as unknown as { stats: unknown[] }).stats = allStats;
  const loop = () =>
    new Promise<void>((resolve) => {
      const frame = async () => {
        const ts = performance.now();
        engine.sample();
        if (q.get('sync') === '1') {
          const gl = engine.canvas.getContext('webgl2');
          gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        }
        const te = performance.now() - ts;
        if (te > 500) log(`slow step: ${te.toFixed(0)} ms at sample ${engine.samples.toFixed(2)}`);
        if (!firstPicture) {
          firstPicture = performance.now();
          engine.exposure = autoExposure(await engine.luminance(), daylight.light);
          engine.show();
          log(
            `first picture: ${(firstPicture - t0).toFixed(0)} ms (exposure ${engine.exposure.toExponential(2)})`,
          );
        }
        if (!firstFull && engine.samples >= 1) {
          firstFull = performance.now();
          log(`first full sample: ${(firstFull - t0).toFixed(0)} ms`);
        }
        if (!exposed8 && engine.samples >= 8) {
          exposed8 = true;
          const lum = await engine.luminance();
          engine.exposure = autoExposure(lum, daylight.light);
          engine.show();
          log(
            `exposure at 8: log-average ${lum.toFixed(2)} cd/m², exposure ${engine.exposure.toExponential(2)}`,
          );
        }
        if (!tAt32 && engine.samples >= 32) tAt32 = performance.now();
        const whole = Math.floor(engine.samples);
        if ((whole === 32 || whole === 64 || whole === TARGET) && !measured.has(whole)) {
          measured.add(whole);
          const inner = engine as unknown as {
            renderer: { readRenderTargetPixels: (...a: unknown[]) => void };
            inner: { _pathTracer: { target: { width: number; height: number } } };
            spread: { width: number; height: number };
          };
          // The traced light as shown (specks spread), or with `raw=1` as traced.
          const t = q.get('raw') === '1' ? inner.inner._pathTracer.target : inner.spread;
          const px = new Float32Array(t.width * t.height * 4);
          inner.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, px);
          const st = stats(px, t.width, t.height);
          allStats.push({ samples: whole, ...st });
          // Each pixel's luminance (cd/m², rows from the bottom), at 64 samples and the last,
          // to compare pictures pixel for pixel.
          const lum: number[] = [];
          for (let i = 0; i < t.width * t.height; i++) {
            lum.push(
              0.2126 * (px[i * 4] ?? 0) +
                0.7152 * (px[i * 4 + 1] ?? 0) +
                0.0722 * (px[i * 4 + 2] ?? 0),
            );
          }
          const w = window as unknown as { lum?: Record<number, number[]> };
          w.lum = { ...w.lum, [whole]: lum };
          log(
            `stats at ${whole}: black ${st.black.toFixed(1)}%, dark ${st.dark.toFixed(1)}%, fireflies ${st.fireflies.toFixed(2)}%, mean ${st.mean.toFixed(1)}, room ${st.room.toFixed(1)}, median ${st.median.toFixed(1)} cd/m²`,
          );
        }
        if (engine.samples >= TARGET) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  await loop();
  const done = performance.now();
  const spp = (TARGET - 1) / ((done - firstFull) / 1000);
  log(
    `${TARGET} samples: ${(done - t0).toFixed(0)} ms total; ${spp.toFixed(2)} samples/s after the first`,
  );
  if (tAt32) log(`32 samples at: ${(tAt32 - t0).toFixed(0)} ms`);
  (window as unknown as { spike: unknown }).spike = {
    w: W,
    h: H,
    target: TARGET,
    prepareMs: prepared - tStart,
    firstPictureMs: firstPicture - t0,
    firstFullMs: firstFull - t0,
    at32Ms: tAt32 ? tAt32 - t0 : null,
    totalMs: done - t0,
    samplesPerSecond: spp,
    triangles: tris,
    exposure: engine.exposure,
    luminance: await engine.luminance(),
  };
  // The sun patch against the shade beside it, from the traced numbers.
  if (probe) {
    const inner = engine as unknown as {
      renderer: { readRenderTargetPixels: (...a: unknown[]) => void };
      inner: { _pathTracer: { target: { width: number; height: number } } };
    };
    const t = inner.inner._pathTracer.target;
    const px = new Float32Array(t.width * t.height * 4);
    inner.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, px);
    const { Vector3 } = await import('three');
    const patch = (p: { x: number; z: number }) => {
      const s = new Vector3(p.x, 0.01, p.z).project(camera);
      const cx = Math.round(((s.x + 1) / 2) * t.width);
      const cy = Math.round(((s.y + 1) / 2) * t.height);
      let sum = 0;
      let n = 0;
      for (let y = cy - 2; y <= cy + 2; y++) {
        for (let x = cx - 2; x <= cx + 2; x++) {
          if (x < 0 || y < 0 || x >= t.width || y >= t.height) continue;
          const i = (y * t.width + x) * 4;
          sum += 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
          n++;
        }
      }
      return { px: [cx, cy], nits: n ? sum / n : Number.NaN };
    };
    const lit = patch(probe.lit);
    const shade = patch(probe.shade);
    log(
      `sun patch ${lit.nits.toFixed(0)} cd/m² at ${lit.px}; shade beside it ${shade.nits.toFixed(0)} at ${shade.px}`,
    );
    (window as unknown as { probe: unknown }).probe = { lit, shade };
  }
  // The traced picture's raw numbers: how many pixels are black, and the mean.
  {
    const inner = engine as unknown as {
      renderer: { readRenderTargetPixels: (...a: unknown[]) => void };
      inner: { _pathTracer: { target: { width: number; height: number } } };
    };
    const t = inner.inner._pathTracer.target;
    const px = new Float32Array(t.width * t.height * 4);
    inner.renderer.readRenderTargetPixels(t, 0, 0, t.width, t.height, px);
    let zero = 0;
    let sum = 0;
    let alphaOff = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * (px[i] ?? 0) + 0.7152 * (px[i + 1] ?? 0) + 0.0722 * (px[i + 2] ?? 0);
      if (l <= 0) zero++;
      sum += l;
      if (Math.abs((px[i + 3] ?? 0) - 1) > 1e-3) alphaOff++;
    }
    const n = px.length / 4;
    log(
      `raw: ${((100 * zero) / n).toFixed(1)}% black, mean ${(sum / n).toFixed(1)} cd/m², alpha≠1 ${alphaOff}`,
    );
  }
  const png = await engine.readPixels();
  const img = new Image();
  img.src = URL.createObjectURL(png);
  img.alt = 'result';
  img.style.display = 'none';
  document.body.append(img);
}

main().catch((e) => {
  log(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e)}`);
  (window as unknown as { spike: unknown }).spike = { error: String(e) };
});
