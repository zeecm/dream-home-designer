// Builds the furniture models from Poly Haven (CC0): for each entry in catalogue.json, it
// downloads the 1k glTF, centres the model on its footprint with its base on the floor,
// shrinks textures to 512 px WebP, welds, simplifies very heavy meshes, compresses with
// meshopt, and writes apps/web/public/models/<id>.glb. It then writes the catalogue entries
// (with each model's real size) to packages/core/src/modelKinds.generated.ts.
//
//   pnpm --filter @dhd/models build            all models
//   pnpm --filter @dhd/models build sofa-3-fabric   just these ids
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  flatten,
  getBounds,
  join as joinMeshes,
  meshopt,
  prune,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const outDir = join(root, 'apps/web/public/models');
const kindsFile = join(root, 'packages/core/src/modelKinds.generated.ts');
const cacheDir = join(root, 'tools/models/.cache');
/**
 * Above this many triangles a model is simplified: a furnished flat holds dozens of pieces,
 * and a phone has to draw them all every frame.
 */
const MAX_TRIANGLES = 12_000;

const catalogue = JSON.parse(await readFile(join(here, 'catalogue.json'), 'utf8'));
const only = process.argv.slice(2);

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res;
}

/** Downloads a Poly Haven model's 1k glTF and its files; returns the .gltf path. */
async function download(asset) {
  const dir = join(cacheDir, asset);
  const files = await (await fetchOk(`https://api.polyhaven.com/files/${asset}`)).json();
  const gltf = files.gltf?.['1k']?.gltf ?? files.gltf?.['2k']?.gltf;
  if (!gltf) throw new Error(`${asset}: no glTF download`);
  const main = join(dir, `${asset}.gltf`);
  await mkdir(dir, { recursive: true });
  await writeFile(main, Buffer.from(await (await fetchOk(gltf.url)).arrayBuffer()));
  for (const [path, file] of Object.entries(gltf.include ?? {})) {
    const to = join(dir, path);
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, Buffer.from(await (await fetchOk(file.url)).arrayBuffer()));
  }
  return main;
}

const triangles = (doc) =>
  doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);

async function build(entry) {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(await download(entry.polyhaven));
  await doc.transform(dedup(), flatten(), joinMeshes(), weld(), prune());
  // Glass that refracts (transmission) makes three.js draw the whole scene twice a frame:
  // plain see-through glass looks the same at this size.
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    const name = ext.extensionName;
    if (name !== 'KHR_materials_transmission' && name !== 'KHR_materials_volume') continue;
    for (const m of doc.getRoot().listMaterials()) {
      if (!m.getExtension(name)) continue;
      m.setExtension(name, null);
      const [r, g, b] = m.getBaseColorFactor();
      m.setAlphaMode('BLEND').setBaseColorFactor([r, g, b, 0.3]);
    }
    ext.dispose();
  }
  // A lamp's shade or bulb glows, as the box-built lamps' shades do.
  if (entry.glow) {
    for (const m of doc.getRoot().listMaterials()) {
      if (m.getName().includes(entry.glow)) m.setEmissiveFactor([1, 0.9, 0.75]);
    }
  }
  const before = triangles(doc);
  const max = entry.maxTriangles ?? MAX_TRIANGLES;
  if (before > max) {
    await doc.transform(
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: max / before,
        error: entry.simplifyError ?? 0.01,
      }),
    );
  }
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
  );

  // Centre the footprint on the origin, base on the floor, under one root node, and turn
  // it if its front isn't +Z (the item's front).
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  const pivot = doc.createNode('pivot');
  const turn = ((entry.turn ?? 0) * Math.PI) / 180;
  pivot.setRotation([0, Math.sin(turn / 2), 0, Math.cos(turn / 2)]);
  // Some models come larger than a flat's furniture: `scale` shrinks them (a number, or
  // [across, up, deep] for one that is only too wide).
  if (entry.scale !== undefined) {
    const k = entry.scale;
    pivot.setScale(Array.isArray(k) ? k : [k, k, k]);
  }
  const offset = doc
    .createNode('offset')
    .setTranslation([-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2]);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    offset.addChild(child);
  }
  pivot.addChild(offset);
  scene.addChild(pivot);
  const nb = getBounds(scene);
  const size = {
    w: +(nb.max[0] - nb.min[0]).toFixed(3),
    d: +(nb.max[2] - nb.min[2]).toFixed(3),
    h: +(nb.max[1] - nb.min[1]).toFixed(3),
  };

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune());
  const glb = await io.writeBinary(doc);
  const hash = createHash('sha256').update(glb).digest('hex').slice(0, 10);
  const file = `${entry.id}.${hash}.glb`;
  await writeFile(join(outDir, file), glb);
  console.log(
    `${entry.id.padEnd(22)} ${String(Math.round(glb.length / 1024)).padStart(5)} KB  ` +
      `${Math.round(triangles(doc))} tris  ${size.w}×${size.d}×${size.h} m`,
  );
  return { file, size };
}

await mkdir(outDir, { recursive: true });
// What earlier builds made (file and size per id), so building a few ids keeps the rest.
const builtFile = join(here, 'built.json');
const built = JSON.parse(await readFile(builtFile, 'utf8').catch(() => '{}'));
for (const entry of catalogue) {
  if (only.length && !only.includes(entry.id)) continue;
  built[entry.id] = await build(entry);
}
for (const id of Object.keys(built)) {
  if (!catalogue.some((e) => e.id === id)) delete built[id];
}
await writeFile(builtFile, `${JSON.stringify(built, null, 2)}\n`);

// Drop GLBs no entry uses any more (older builds of a model).
const { readdir } = await import('node:fs/promises');
const used = new Set(Object.values(built).map((b) => b.file));
for (const f of await readdir(outDir)) {
  if (f.endsWith('.glb') && !used.has(f)) await rm(join(outDir, f));
}

const kinds = catalogue
  .filter((e) => built[e.id])
  .map(({ polyhaven, turn, scale, maxTriangles, simplifyError, glow, ...e }) => ({
    ...e,
    model: built[e.id].file,
    size: built[e.id].size,
    source: `https://polyhaven.com/a/${polyhaven}`,
  }));
await writeFile(
  kindsFile,
  `// Generated by tools/models/build.mjs from tools/models/catalogue.json. Do not edit.
// Models from Poly Haven, CC0 (public domain).
import type { ModelKind } from './furniture';

export const MODEL_KINDS: ModelKind[] = ${JSON.stringify(kinds, null, 2)};
`,
);
// In the repo's own style (Biome), so lint passes on the generated file.
const { execFileSync } = await import('node:child_process');
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', kindsFile], { cwd: root });
console.log(`${kinds.length} models → ${kindsFile}`);
