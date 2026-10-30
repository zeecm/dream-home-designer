import type * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { type ViewMode, useEditor } from './editor';
import { useStore } from './store';
import { track } from './telemetry';

/**
 * Downloads: the plan as a picture or a printout, the 3D view as a picture, the 3D model,
 * and the project file. The plan and 3D come from what is on screen, so the views they need
 * are shown for a moment if they aren't.
 */

/** A file name from the project's name: "3-room HDB (sample)" → "3-room-hdb-sample". */
export function fileStem(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plan'
  );
}

export function download(blob: Blob, filename: string) {
  track('download', filename.split('.').pop() ?? '');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const settle = async (frames = 3) => {
  for (let i = 0; i < frames; i++) await frame();
};

/** Runs `fn` with `need` on screen (plan or 3D), then puts the view back as it was. */
async function withView<T>(need: 'plan' | '3d', fn: () => Promise<T>): Promise<T> {
  const ed = useEditor.getState();
  const before: ViewMode = ed.viewMode;
  const shown = before === 'split' || before === need;
  if (!shown) {
    ed.setViewMode(need);
    await settle(6);
  }
  try {
    return await fn();
  } finally {
    if (!shown) useEditor.getState().setViewMode(before);
  }
}

// ------------------------------------------------------------------------ the plan

/** Styles the plan's stylesheet gives its shapes, copied onto them for a standalone SVG. */
const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linejoin',
  'stroke-linecap',
  'opacity',
  'paint-order',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'display',
  'visibility',
];

function inlineStyles(from: Element, to: Element) {
  const cs = getComputedStyle(from);
  const style = STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
  to.setAttribute('style', style);
  for (let i = 0; i < from.children.length; i++) {
    const a = from.children[i];
    const b = to.children[i];
    if (a && b) inlineStyles(a, b);
  }
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** The plan as drawn now (fitted, nothing selected), as a PNG `scale` times the screen size. */
async function planPng(scale = 3): Promise<Blob> {
  const ed = useEditor.getState();
  ed.select(null);
  ed.setTool('select');
  ed.requestFit();
  await settle(4);
  const svg = document.querySelector<SVGSVGElement>('svg.plan-svg');
  if (!svg) throw new Error('The plan isn’t on screen.');
  const w = svg.width.baseVal.value;
  const h = svg.height.baseVal.value;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, copy);
  // Corner handles, the grid and the north arrow's button aren't part of the drawing.
  for (const el of copy.querySelectorAll('.vertices, [data-export="skip"]')) el.remove();
  const grid = copy.querySelector('rect[fill="url(#grid-minor)"]');
  grid?.setAttribute('fill', '#ffffff');
  grid?.setAttribute('style', 'fill:#ffffff');
  // An SVG drawn as an image can't fetch anything: the plan image goes in as data.
  for (const img of copy.querySelectorAll('image')) {
    const href = img.getAttribute('href');
    if (href?.startsWith('blob:')) {
      img.setAttribute('href', await blobToDataUrl(await (await fetch(href)).blob()));
    }
  }
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('viewBox', `0 0 ${w} ${h}`);
  copy.setAttribute('width', String(w * scale));
  copy.setAttribute('height', String(h * scale));
  const text = new XMLSerializer().serializeToString(copy);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t draw the picture.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadPlanImage() {
  const name = useStore.getState().editor.doc.name;
  const png = await withView('plan', () => planPng());
  download(png, `${fileStem(name)}-plan.png`);
}

/** Prints the plan on a page of its own; the print dialog can save it as a PDF. */
export async function printPlan() {
  const name = useStore.getState().editor.doc.name;
  const png = await withView('plan', () => planPng());
  const src = await blobToDataUrl(png);
  const frameEl = document.createElement('iframe');
  frameEl.setAttribute('aria-hidden', 'true');
  frameEl.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.append(frameEl);
  const doc = frameEl.contentDocument;
  const win = frameEl.contentWindow;
  if (!doc || !win) throw new Error('This browser can’t print from here.');
  doc.title = name;
  const style = doc.createElement('style');
  style.textContent =
    '@page{margin:12mm}body{margin:0;font:14px system-ui,sans-serif}h1{font-size:16px;margin:0 0 8px}img{max-width:100%;max-height:92vh;display:block;margin:auto}';
  const title = doc.createElement('h1');
  title.textContent = name;
  const img = doc.createElement('img');
  img.alt = `Floor plan of ${name}`;
  img.src = src;
  doc.head.append(style);
  doc.body.append(title, img);
  await img.decode();
  win.focus();
  win.print();
  setTimeout(() => frameEl.remove(), 60_000);
}

// ------------------------------------------------------------------------ 3D

interface Scene3d {
  render: () => void;
  canvas: HTMLCanvasElement;
  level: () => THREE.Object3D | undefined;
}

let scene3d: Scene3d | null = null;

/** The 3D view registers how to draw itself on demand while it is mounted. */
export function registerScene3d(s: Scene3d | null) {
  scene3d = s;
}

export async function download3dImage() {
  const name = useStore.getState().editor.doc.name;
  const png = await withView('3d', async () => {
    await settle(10); // models and shadows settle
    const s = scene3d;
    if (!s) throw new Error('The 3D view isn’t on screen.');
    // Drawn now and read at once, so the canvas needn't keep its buffer between frames.
    s.render();
    return await new Promise<Blob>((resolve, reject) =>
      s.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
    );
  });
  download(png, `${fileStem(name)}-3d.png`);
}

/** The flat in 3D as a GLB file, for other 3D apps. */
export async function download3dModel() {
  const name = useStore.getState().editor.doc.name;
  const glb = await withView('3d', async () => {
    await settle(10);
    const level = scene3d?.level();
    if (!level) throw new Error('The 3D view isn’t on screen.');
    const out = await new GLTFExporter().parseAsync(level, { binary: true });
    return new Blob([out as ArrayBuffer], { type: 'model/gltf-binary' });
  });
  download(glb, `${fileStem(name)}.glb`);
}

// ------------------------------------------------------------------------ the file

export function downloadProjectFile() {
  const doc = useStore.getState().editor.doc;
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  download(blob, `${fileStem(doc.name)}.dreamhome.json`);
}
