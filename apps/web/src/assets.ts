import { SAMPLE_PLAN_KEY } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';

/**
 * Plan images live in this browser's IndexedDB, keyed by the project's `underlay.assetKey`,
 * and on the server when there is one. New keys are `sha256:<hex>` of the image, which is how
 * the server names it too; a browser without the image fetches it from the server once and
 * keeps it. Older `img_…` keys exist only in the browser that uploaded them.
 */
const DB = 'dhd-assets';
const STORE = 'blobs';

let connection: Promise<IDBDatabase> | undefined;

/** One shared connection; it closes itself if a newer tab needs to upgrade the database. */
function db(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => {
        d.close();
        connection = undefined;
      };
      resolve(d);
    };
    req.onerror = () => {
      connection = undefined;
      reject(req.error);
    };
  });
  return connection;
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const putAsset = (key: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, key));
export const getAsset = (key: string) => tx<Blob | undefined>('readonly', (s) => s.get(key));

export interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

function measure(url: string): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = url;
  });
}

const HASH_KEY = /^sha256:([0-9a-f]{64})$/;

/** The SHA-256 a `sha256:` key names, or null for an older browser-only key. */
export const hashOfKey = (key: string): string | null => HASH_KEY.exec(key)?.[1] ?? null;
export const keyOfHash = (hash: string) => `sha256:${hash}`;

export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Images that ship with the app, by key: the sample flat's floor plan. */
export const BUNDLED_ASSETS: Record<string, string> = {
  [SAMPLE_PLAN_KEY]: '/samples/hdb-3room-type4.png',
};

/** A bundled image, kept in this browser once fetched; undefined for any other key. */
export async function bundledAsset(key: string): Promise<Blob | undefined> {
  const url = BUNDLED_ASSETS[key];
  if (!url) return undefined;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  const blob = await res.blob();
  await putAsset(key, blob).catch(() => undefined);
  return blob;
}

/** Fetches an image by hash from the server, for images this browser doesn't have. */
export type RemoteImage = (hash: string) => Promise<Blob>;

const cache = new Map<string, Promise<LoadedImage | null>>();

/**
 * The image for `key`, as an object URL with its pixel size; null if neither this browser
 * nor the server has it. A miss isn't remembered, so a later call tries again.
 */
export function loadAsset(key: string, remote?: RemoteImage): Promise<LoadedImage | null> {
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      let blob =
        (await getAsset(key).catch(() => undefined)) ??
        (await bundledAsset(key).catch(() => undefined));
      const hash = hashOfKey(key);
      if (!blob && hash && remote) {
        blob = await remote(hash).catch(() => undefined);
        if (blob) await putAsset(key, blob).catch(() => undefined);
      }
      return blob ? measure(URL.createObjectURL(blob)) : null;
    })().catch(() => null);
    cache.set(key, p);
    void p.then((img) => {
      if (!img) cache.delete(key);
    });
  }
  return p;
}

/** A rectangle in image pixels. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the drawing is on a plan image: ink (pixels darker than paper) is gathered into
 * cells, touching cells into blocks, and the block covering the largest area wins. A floor
 * plan's lines and dimensions join into one block, while titles, notes and a legend stand
 * apart, so this frames the plan rather than the page. Null if the image can't be read.
 */
export function inkBounds(img: LoadedImage): Promise<PixelBox | null> {
  return new Promise((resolve) => {
    const el = new Image();
    el.onerror = () => resolve(null);
    el.onload = () => {
      const k = Math.min(1, 800 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * k));
      const h = Math.max(1, Math.round(img.height * k));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) return resolve(null);
      g.drawImage(el, 0, 0, w, h);
      resolve(drawingBox(g.getImageData(0, 0, w, h), 12, 1 / k));
    };
    el.src = img.url;
  });
}

/** The largest block of inked `cell`-pixel cells in `image`, scaled by `scale`. */
export function drawingBox(
  image: { width: number; height: number; data: ArrayLike<number> },
  cell: number,
  scale: number,
): PixelBox | null {
  const { width: w, height: h, data } = image;
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const inked = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum =
        0.3 * (data[i] ?? 255) + 0.59 * (data[i + 1] ?? 255) + 0.11 * (data[i + 2] ?? 255);
      if ((data[i + 3] ?? 0) > 128 && lum < 230) {
        inked[Math.floor(y / cell) * cw + Math.floor(x / cell)] = 1;
      }
    }
  }
  const seen = new Uint8Array(cw * ch);
  let best: { area: number; box: [number, number, number, number] } | null = null;
  for (let start = 0; start < inked.length; start++) {
    if (!inked[start] || seen[start]) continue;
    seen[start] = 1;
    const stack = [start];
    let [x0, y0, x1, y1] = [cw, ch, 0, 0];
    while (stack.length) {
      const c = stack.pop() as number;
      const cx = c % cw;
      const cy = (c - cx) / cw;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      const next = [
        cx > 0 ? c - 1 : -1,
        cx < cw - 1 ? c + 1 : -1,
        cy > 0 ? c - cw : -1,
        cy < ch - 1 ? c + cw : -1,
      ];
      for (const n of next) {
        if (n >= 0 && inked[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (!best || area > best.area) best = { area, box: [x0, y0, x1 + 1, y1 + 1] };
  }
  if (!best) return null;
  const [x0, y0, x1, y1] = best.box.map((v) => v * cell * scale) as [
    number,
    number,
    number,
    number,
  ];
  return { x0, y0, x1, y1 };
}

export type AssetState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'missing' }
  | ({ status: 'ready' } & LoadedImage);

export function useAsset(key: string | undefined, remote?: RemoteImage): AssetState {
  const [state, setState] = useState<AssetState>({ status: key ? 'loading' : 'none' });
  const fetchRemote = useRef(remote);
  fetchRemote.current = remote;
  const hasRemote = !!remote;
  const shown = useRef<string | undefined>(undefined);
  // A miss on the server may be an upload still on its way: try again a few times.
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key, a server becoming known, retries
  useEffect(() => setAttempt(0), [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry once a server is known
  useEffect(() => {
    if (!key) {
      setState({ status: 'none' });
      return;
    }
    let live = true;
    // Keep showing this key's image while a server becoming known re-runs the effect.
    setState((s) => (s.status === 'ready' && shown.current === key ? s : { status: 'loading' }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadAsset(key, fetchRemote.current).then((img) => {
      if (!live) return;
      shown.current = img ? key : undefined;
      setState(img ? { status: 'ready', ...img } : { status: 'missing' });
      if (!img && fetchRemote.current && attempt < 3) {
        timer = setTimeout(() => setAttempt((a) => a + 1), 5000);
      }
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, hasRemote, attempt]);
  return state;
}

/** Longest side, in pixels, of the image a PDF page is rendered to. */
const PDF_RENDER_PX = 3000;

/** What the server stores: these formats, up to this size. */
const SERVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const SERVER_MAX_BYTES = 10 * 1024 * 1024;
/** Longest side of a re-encoded image; plenty to trace from. */
const REENCODE_PX = 4000;

/** Turns an uploaded plan (image or first PDF page) into an image blob and its size. */
export async function prepareUpload(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (file.size > 25 * 1024 * 1024)
    throw new Error('That file is over 25 MB. Try a smaller export.');
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return renderPdf(file);
  if (!file.type.startsWith('image/'))
    throw new Error('Upload a JPG, PNG or PDF of the floor plan.');
  const url = URL.createObjectURL(file);
  try {
    const { width, height } = await measure(url);
    if (SERVER_TYPES.includes(file.type) && file.size <= SERVER_MAX_BYTES) {
      return { blob: file, width, height };
    }
    // Other formats (GIF, SVG…) and very large photos are redrawn as JPEG so the server
    // can keep them; the picture is unchanged apart from size.
    return await reencode(url, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The image as the server will take it: PNG, JPEG or WebP up to 10 MB. Anything else is
 * redrawn as JPEG, smaller each try, until it fits. `factor` is new pixels per old pixel.
 */
export async function normalizeForServer(blob: Blob): Promise<{ blob: Blob; factor: number }> {
  if (SERVER_TYPES.includes(blob.type) && blob.size <= SERVER_MAX_BYTES) return { blob, factor: 1 };
  const url = URL.createObjectURL(blob);
  try {
    const { width, height } = await measure(url);
    let maxPx = REENCODE_PX;
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = await reencode(url, width, height, maxPx);
      if (out.blob.size <= SERVER_MAX_BYTES) return { blob: out.blob, factor: out.width / width };
      maxPx = Math.round(maxPx * 0.7);
    }
    throw new Error('413 the image is still over 10 MB');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function reencode(url: string, width: number, height: number, maxPx = REENCODE_PX) {
  const f = Math.min(1, maxPx / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * f));
  canvas.height = Math.max(1, Math.round(height * f));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot read that image.');
  const img = new Image();
  img.src = url;
  await img.decode();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not read that image.'))),
      'image/jpeg',
      0.9,
    ),
  );
  return { blob, width: canvas.width, height: canvas.height };
}

async function renderPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_RENDER_PX / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the PDF.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not render the PDF.'))),
        'image/png',
      ),
    );
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    void task.destroy();
  }
}
