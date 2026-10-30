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
      let blob = await getAsset(key).catch(() => undefined);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry once a server is known
  useEffect(() => {
    if (!key) {
      setState({ status: 'none' });
      return;
    }
    let live = true;
    // Keep showing this key's image while a server becoming known re-runs the effect.
    setState((s) => (s.status === 'ready' && shown.current === key ? s : { status: 'loading' }));
    void loadAsset(key, fetchRemote.current).then((img) => {
      if (!live) return;
      shown.current = img ? key : undefined;
      setState(img ? { status: 'ready', ...img } : { status: 'missing' });
    });
    return () => {
      live = false;
    };
  }, [key, hasRemote]);
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

async function reencode(url: string, width: number, height: number) {
  const f = Math.min(1, REENCODE_PX / Math.max(width, height));
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
