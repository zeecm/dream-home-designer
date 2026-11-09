import { AiError, type AiSettings, anySignal, errorBody, failure } from '@dhd/ai';
import {
  type Level,
  SKETCH_KEY,
  type SceneCamera,
  type SceneFacts,
  clean,
  planSketch,
  sceneSheet,
} from '@dhd/core';
import { timeoutSignal } from './providers';

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

/** What the second image is, when the plan goes with the view. */
const PLAN_NOTE = `The second image is the floor plan of the whole home seen from above, for reference only: never draw it or copy its look. On it ${SKETCH_KEY} Use it to know what is at the picture's edges and just beyond them: a doorway or opening the plan shows stays open, and a wall the plan shows as solid stays solid.`;

/** Said again at the end, where a model weighs it most: the same picture, only real. */
const LAST_WORD =
  'The result must match the image line for line: only the materials and the light change. Nothing added, removed or moved.';
const LAST_WORD_WITH_IDEAS =
  'The result must match the image line for line: only the materials, the light and the small things their ideas add (plants, textiles, art, décor) change. Walls, doors, windows and openings stay exactly as drawn, and the furniture stays where and as large as it is.';

/** Longest idea text sent, in characters. */
export const MAX_IDEAS = 600;

/**
 * The person's ideas as the prompt quotes them: one line, no control or invisible
 * characters, no double quotes of their own (they'd end the quote), at most MAX_IDEAS.
 */
export function ownIdeas(text: string): string {
  return clean(text.replace(/["“”]/g, "'").replace(/\s+/g, ' '), MAX_IDEAS);
}

/**
 * What to ask the image model: the picture made photographic, and (given the facts of the
 * view) a short sheet of what is really there, so a view from high up isn't read as a big
 * room and filled with furniture that wouldn't fit.
 */
export function renderPrompt(
  style: RenderStyle,
  facts?: SceneFacts,
  plan = false,
  /** The person's own ideas for the picture, in their words. */
  ideas = '',
): string {
  // Daylight "through the windows" with none in sight has a model add one to explain it.
  const glazed = facts?.openings.some((o) => o.kind === 'window' || o.kind === 'glass') ?? true;
  const light = glazed
    ? 'natural daylight through the windows'
    : 'soft, even indoor light, as there is no window in view';
  const own = ownIdeas(ideas);
  // With their own ideas, they win over the look and are the one thing that may be added;
  // without, nothing is.
  const look = own
    ? style === 'as'
      ? 'Keep every material and colour as it is, except where their ideas below say otherwise.'
      : `${RENDER_STYLES[style]} Where their ideas below say otherwise, their ideas win.`
    : RENDER_STYLES[style];
  const adding = own
    ? 'Add nothing beyond what their ideas below ask for: no other furniture, rugs, lamps, curtains, pictures, plants, décor, people or text.'
    : 'Add nothing: no furniture, rugs, lamps, curtains, pictures, plants, décor, people or text.';
  const base = `${plan ? 'Edit the first image. ' : 'Edit this image. '}It is an exact 3D model of a real home, drawn to scale: not a sketch to interpret or improve. Make it look like a real photograph of this exact room by changing only how the surfaces look (realistic materials and textures) and the light (${light}, soft shadows, light bouncing off the walls). ${look} Every edge must stay where it is: the same camera, framing and perspective; the same walls, corners, ceiling and floor; the same doors, windows and openings, the same sizes and in the same places; the same furniture, in the same places, sizes and orientations. ${adding} Remove nothing. Never add a door, doorway, arch, opening, niche or window: a solid wall stays solid${own ? '' : ', and empty floor stays empty'}.`;
  const key = plan ? `\n\n${PLAN_NOTE}` : '';
  // Their ideas come after the facts, nearest the end, where a model weighs them most.
  const theirs = own
    ? `\n\nThe person's own ideas for this picture, in their words: "${own}". Follow them for materials, colours, light and styling, ahead of the look and the finishes above. Where they ask for something small to be added (plants, a rug, curtains, art), add just that, in a size that fits. Walls, doors, windows, openings, the furniture's places and sizes, and the room's size never change, whatever they say.`
    : '';
  const last = own ? LAST_WORD_WITH_IDEAS : LAST_WORD;
  if (!facts) return `${base}${key}${theirs}\n\n${last}`;
  // The sheet fits its own length (pieces and openings dropped and counted), its
  // instruction first. Finishes "as designed" only when their ideas don't restyle them.
  const sheet = sceneSheet(facts, { finishes: style === 'as' && !own, ideas: !!own });
  return `${base}${key}\n\nThe true scene, measured: ${sheet}${theirs}\n\n${last}`;
}

const TIMEOUT = 240_000;

/** OpenAI image models that take several pictures (the view and the plan). */
export const MANY_IMAGES = /^gpt-image-/;

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
 * The floor plan with the camera marked (`planSketch`), as a PNG for the image model: so it
 * knows the home around the view, not only what the picture shows.
 */
export async function planImage(level: Level, camera: SceneCamera, px = 1024): Promise<Blob> {
  // The view's shape: a model may make its picture the shape of the last one it is given.
  const { svg, width, height } = planSketch(level, camera, px, camera.aspect);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No plan picture'))), 'image/png'),
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
  /** The facts of the view, the floor plan to send with it, and the person's own ideas. */
  more: { facts?: SceneFacts; plan?: Blob; ideas?: string } = {},
): Promise<Blob> {
  const { facts, plan, ideas } = more;
  // An older OpenAI image model (dall-e-2) takes one picture: the view alone.
  const withPlan =
    plan && (ai.provider !== 'openai' || MANY_IMAGES.test(ai.model)) ? plan : undefined;
  const prompt = renderPrompt(style, facts, !!withPlan, ideas);
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
      // With the plan, both go as `image[]`, the view first (kept most closely).
      if (withPlan) {
        form.append('image[]', view, 'view.png');
        form.append('image[]', withPlan, 'plan.png');
      } else {
        form.append('image', view, 'view.png');
      }
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
                  ...(withPlan
                    ? [
                        {
                          inline_data: {
                            mime_type: 'image/png',
                            data: await blobToBase64(withPlan),
                          },
                        },
                      ]
                    : []),
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
