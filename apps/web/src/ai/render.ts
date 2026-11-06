import { type SceneFacts, sceneSheet } from '@dhd/core';
import type { AiSettings } from './credentials';
import { AiError, anySignal, errorBody, failure, timeoutSignal } from './providers';

/** Looks of a render to choose from. */
export const RENDER_STYLES = {
  as: 'Keep every material and colour as it is.',
  warm: 'Finishes: light oak on wooden surfaces and floors, warm white walls; soft, warm afternoon light.',
  scandi:
    'Finishes: pale wood, white walls, light linen on any upholstery already there; bright daylight.',
  luxe: 'Finishes: marble, walnut and brushed brass on the surfaces and furniture already there; warm evening light.',
  industrial:
    'Finishes: concrete, black metal and dark wood on the surfaces and furniture already there; warm light.',
} as const;
export type RenderStyle = keyof typeof RENDER_STYLES;

/** Said again at the end, where a model weighs it most: the same picture, only real. */
const LAST_WORD =
  'The result must match the image line for line: only the materials and the light change. Nothing added, removed or moved.';

/**
 * What to ask the image model: the picture made photographic, and (given the facts of the
 * view) a short sheet of what is really there, so a view from high up isn't read as a big
 * room and filled with furniture that wouldn't fit.
 */
export function renderPrompt(style: RenderStyle, facts?: SceneFacts): string {
  // Daylight "through the windows" with none in sight has a model add one to explain it.
  const glazed = facts?.openings.some((o) => o.kind === 'window' || o.kind === 'glass') ?? true;
  const light = glazed
    ? 'natural daylight through the windows'
    : 'soft, even indoor light, as there is no window in view';
  const base = `Edit this image. It is an exact 3D model of a real home, drawn to scale: not a sketch to interpret or improve. Make it look like a real photograph of this exact room by changing only how the surfaces look (realistic materials and textures) and the light (${light}, soft shadows, light bouncing off the walls). ${RENDER_STYLES[style]} Every edge must stay where it is: the same camera, framing and perspective; the same walls, corners, ceiling and floor; the same doors, windows and openings, the same sizes and in the same places; the same furniture, in the same places, sizes and orientations. Add nothing: no furniture, rugs, lamps, curtains, pictures, plants, décor, people or text. Remove nothing. Never add a door, doorway, arch, opening, niche or window: a solid wall stays solid, and empty floor stays empty.`;
  if (!facts) return `${base}\n\n${LAST_WORD}`;
  // The sheet fits its own length (pieces and openings dropped and counted), its
  // instruction first.
  const sheet = sceneSheet(facts, { finishes: style === 'as' });
  return `${base}\n\nThe true scene, measured: ${sheet}\n\n${LAST_WORD}`;
}

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

/**
 * A photo-real picture of `view` (a PNG of the 3D view) by the person's image model, told
 * the facts of the view when given them.
 */
export async function renderPhoto(
  ai: AiSettings,
  picture: Blob,
  style: RenderStyle,
  signal?: AbortSignal,
  facts?: SceneFacts,
): Promise<Blob> {
  const prompt = renderPrompt(style, facts);
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
      form.append('prompt', prompt);
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
                  { text: prompt },
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
