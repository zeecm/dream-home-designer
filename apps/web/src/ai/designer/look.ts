import type { LookImage, PromptImage } from '@dhd/core';

/**
 * The second look's pictures, made on this device (tech 3b §2.2): the core's plan drawing (an
 * SVG) decoded as an image and drawn to a canvas, then a PNG in base64. On the main thread,
 * since browsers can't decode an SVG in a worker; once an option, about 30–80 ms on a phone.
 * Null when it can't be made (no canvas, a decode that fails): the look is skipped then.
 */

const MAX_IMAGES = 2;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function pngOf(im: LookImage): Promise<PromptImage> {
  const img = new Image(im.width, im.height);
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(im.svg)}`;
  await img.decode();
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(im.width, im.height);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no canvas');
    g.drawImage(img, 0, 0, im.width, im.height);
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = im.width;
    canvas.height = im.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no canvas');
    g.drawImage(img, 0, 0, im.width, im.height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  }
  if (!blob) throw new Error('no picture');
  return { mediaType: 'image/png', data: await base64(blob) };
}

/** The pictures as PNGs (at most two), or null when this device can't make them. */
export async function rasterise(images: LookImage[]): Promise<PromptImage[] | null> {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return null;
  try {
    const out: PromptImage[] = [];
    for (const im of images.slice(0, MAX_IMAGES)) out.push(await pngOf(im));
    return out;
  } catch {
    return null;
  }
}
