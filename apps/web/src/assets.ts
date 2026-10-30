import { useEffect, useState } from 'react';

/**
 * Plan images live in this browser's IndexedDB, keyed by the project's
 * `underlay.assetKey`. (Server-side uploads to R2 come later; until then an image shows
 * only in the browser that uploaded it.)
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

const cache = new Map<string, Promise<LoadedImage | null>>();

/** The stored image for `key`, as an object URL with its pixel size; null if absent. */
export function loadAsset(key: string): Promise<LoadedImage | null> {
  let p = cache.get(key);
  if (!p) {
    p = getAsset(key)
      .then((blob) => (blob ? measure(URL.createObjectURL(blob)) : null))
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

export type AssetState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'missing' }
  | ({ status: 'ready' } & LoadedImage);

export function useAsset(key: string | undefined): AssetState {
  const [state, setState] = useState<AssetState>({ status: key ? 'loading' : 'none' });
  useEffect(() => {
    if (!key) {
      setState({ status: 'none' });
      return;
    }
    let live = true;
    setState({ status: 'loading' });
    void loadAsset(key).then((img) => {
      if (live) setState(img ? { status: 'ready', ...img } : { status: 'missing' });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state;
}

/** Longest side, in pixels, of the image a PDF page is rendered to. */
const PDF_RENDER_PX = 3000;

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
    return { blob: file, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
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
