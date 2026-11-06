import type { AiSettings } from './credentials';
import { AiError, anySignal, errorBody, failure, timeoutSignal } from './providers';

/** Looks of a render to choose from. */
export const RENDER_STYLES = {
  as: 'Keep the materials and colours exactly as they are.',
  warm: 'Warm, modern Singapore home: light oak, warm white walls, soft afternoon light.',
  scandi: 'Scandinavian: pale wood, white walls, linen, plants, bright daylight.',
  luxe: 'Modern luxe: marble, walnut, brass details, evening light with warm lamps on.',
  industrial: 'Industrial: concrete, black metal, dark wood, warm pendant lights.',
} as const;
export type RenderStyle = keyof typeof RENDER_STYLES;

const prompt = (style: RenderStyle) =>
  `This is a simple 3D model render of a room in a home. Turn it into a photorealistic interior photograph, as a professional architectural photographer would take it. Keep the same camera position and angle, the same room shape, walls, doors, windows and openings, and the same furniture in the same places, sizes and orientations. Add realistic materials, textures, soft shadows and natural light through the windows. ${RENDER_STYLES[style]} Do not add or remove walls, windows, doors or furniture. No people, no text.`;

const TIMEOUT = 240_000;

/** OpenAI image models known to take `input_fidelity` (gpt-image-1 and its snapshots). */
export const HIGH_FIDELITY = /^gpt-image-1(-\d{4}-\d{2}-\d{2})?$/;

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** `png` scaled down to fit `max` pixels on its longer side (a high-DPI view is huge). */
async function fitWithin(png: Blob, max: number): Promise<Blob> {
  const img = await createImageBitmap(png);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  if (k === 1) {
    img.close();
    return png;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'),
  );
}

/** A photo-real picture of `view` (a PNG of the 3D view) by the person's image model. */
export async function renderPhoto(
  ai: AiSettings,
  picture: Blob,
  style: RenderStyle,
  signal?: AbortSignal,
): Promise<Blob> {
  const timeout = timeoutSignal(TIMEOUT);
  const both = signal ? anySignal([signal, timeout]) : timeout;
  let res: Response;
  let body: {
    data?: { b64_json?: string }[];
    candidates?: {
      content?: { parts?: { inlineData?: { data?: string }; inline_data?: { data?: string } }[] };
    }[];
  };
  try {
    const view = await fitWithin(picture, 1536);
    if (ai.provider === 'openai') {
      const form = new FormData();
      form.append('model', ai.model);
      form.append('image', view, 'view.png');
      form.append('prompt', prompt(style));
      form.append('size', 'auto');
      // Keep the room as it is drawn (walls, furniture), not a loose impression of it: only
      // where the model is known to take it (gpt-image-1-mini, say, turns it down).
      if (HIGH_FIDELITY.test(ai.model)) form.append('input_fidelity', 'high');
      res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${ai.key}` },
        body: form,
        signal: both,
      });
    } else if (ai.provider === 'gemini') {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.key },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { inline_data: { mime_type: 'image/png', data: await blobToBase64(view) } },
                  { text: prompt(style) },
                ],
              },
            ],
            generationConfig: { responseModalities: ['IMAGE'] },
          }),
          signal: both,
        },
      );
    } else {
      throw new AiError(
        'key',
        'Renders need an OpenAI or Gemini key (Claude doesn’t make pictures).',
      );
    }
    // What the provider said, so the person (and we) can see why.
    if (!res.ok) throw failure(ai.provider, res.status, await errorBody(res), ai.key);
    body = (await res.json()) as typeof body;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (signal?.aborted) throw new AiError('cancelled', 'Cancelled.');
    if (timeout.aborted) throw new AiError('timeout', 'The render took too long. Try again.');
    throw new AiError('network', 'Couldn’t reach the model. Check your connection and try again.');
  }
  const b64 =
    body.data?.[0]?.b64_json ??
    body.candidates?.[0]?.content?.parts
      ?.map((p) => p.inlineData?.data ?? p.inline_data?.data)
      .find((d): d is string => !!d);
  if (!b64) throw new AiError('refused', 'The model sent back no picture. Try another look.');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}
