import { AiError, type AiSettings } from '@dhd/ai';
import { PlanReading } from '@dhd/core';
import { type ModelImage, askForJson, lowerEnums } from './providers';

/** The longest side sent to a model: plenty for a plan, inside every provider's limits. */
const MAX_SIDE = 1568;

/** The plan image, scaled to fit a model, and how its pixels map back to the original's. */
export async function planImage(
  url: string,
  width: number,
  height: number,
): Promise<{ image: ModelImage; k: number }> {
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * k);
  canvas.height = Math.round(height * k);
  const c = canvas.getContext('2d');
  if (!c) throw new AiError('unreadable', 'Couldn’t prepare the plan image.');
  // On white: a transparent scan reads as black otherwise.
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL('image/png').split(',')[1] ?? '';
  return { image: { data, mediaType: 'image/png' }, k };
}

const point = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
};

/** `PlanReading` as a JSON schema: closed objects, every property required. */
export const READING_SCHEMA = {
  type: 'object',
  properties: {
    walls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { a: point, b: point, thickness: { type: 'number' } },
        required: ['a', 'b', 'thickness'],
        additionalProperties: false,
      },
    },
    openings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['door', 'window', 'passage'] },
          a: point,
          b: point,
        },
        required: ['kind', 'a', 'b'],
        additionalProperties: false,
      },
    },
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, at: point },
        required: ['name', 'at'],
        additionalProperties: false,
      },
    },
    printedArea: { type: ['number', 'null'] },
  },
  required: ['walls', 'openings', 'rooms', 'printedArea'],
  additionalProperties: false,
};

export const tracePrompt = (w: number, h: number) =>
  `This image is an architectural floor plan of a home, ${w} × ${h} pixels. Read it as an architect tracing it would, and give every position in this image's pixels (x to the right, y down from the top left).

- walls: every wall, as the centre line of each straight run (a to b), with its thickness in pixels. Include outside walls, inside partitions, the household shelter's walls and balcony or ledge walls. A wall continues straight through its doors and windows: give the whole run, not the pieces between openings. Leave out furniture, fittings, dimension lines, hatching, text and the drawing's border.
- openings: each door, window and doorless opening, as the span it takes along its wall (a to b, on the wall's centre line), with its kind.
- rooms: each room's name as printed (e.g. "Bedroom 1", "Kitchen", "Household shelter", "Bath/WC"), at the middle of the room. Use a plain name if none is printed.
- printedArea: the total floor area printed on the plan in square metres, or null if there is none.

Be precise: ends of walls that meet should meet at the same point.`;

/** Reads the walls, openings and rooms from a plan image with the person's model. */
export async function readPlan(
  ai: AiSettings,
  url: string,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<PlanReading> {
  const { image, k } = await planImage(url, width, height);
  const raw = await askForJson(
    ai,
    tracePrompt(Math.round(width * k), Math.round(height * k)),
    image,
    READING_SCHEMA,
    signal,
  );
  const parsed = PlanReading.safeParse(lowerEnums(raw, ['kind']));
  if (!parsed.success) {
    throw new AiError('unreadable', 'The model’s answer wasn’t a plan reading. Try again.');
  }
  // Back to the original image's pixels, which the plan's calibration is in.
  const up = (p: { x: number; y: number }) => ({ x: p.x / k, y: p.y / k });
  const r = parsed.data;
  return {
    walls: r.walls.map((w) => ({ a: up(w.a), b: up(w.b), thickness: w.thickness / k })),
    openings: r.openings.map((o) => ({ ...o, a: up(o.a), b: up(o.b) })),
    rooms: r.rooms.map((x) => ({ ...x, at: up(x.at) })),
    printedArea: r.printedArea ?? null,
  };
}
