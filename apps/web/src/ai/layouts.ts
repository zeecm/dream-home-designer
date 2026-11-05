import { LayoutSuggestions, type Level, planForModel } from '@dhd/core';
import type { AiSettings } from './credentials';
import { AiError, askForJson, lowerEnums } from './providers';

/** What the household wants, from the brief. */
export interface Brief {
  household: string;
  wishes: string[];
  notes: string;
}

export const WISHES = [
  'An open kitchen',
  'A bigger master bedroom',
  'A study or home office',
  'A walk-in wardrobe',
  'More storage',
  'A brighter, more open living room',
  'An extra bedroom',
  'Room for elderly parents (wider doors, fewer steps)',
] as const;

const point = {
  type: 'object',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
};
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });

/** `LayoutSuggestions` as a JSON schema: closed objects, every property required. */
export const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          reasons: { type: 'array', items: { type: 'string' } },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: {
                  type: 'string',
                  enum: [
                    'remove_wall',
                    'add_wall',
                    'half_wall',
                    'glass_wall',
                    'add_door',
                    'remove_opening',
                    'rename_room',
                  ],
                },
                wallId: nullable({ type: 'string' }),
                openingId: nullable({ type: 'string' }),
                a: nullable(point),
                b: nullable(point),
                height: nullable({ type: 'number' }),
                t: nullable({ type: 'number' }),
                width: nullable({ type: 'number' }),
                style: nullable({
                  type: 'string',
                  enum: ['swing', 'double', 'sliding', 'pocket', 'bifold', 'folding'],
                }),
                at: nullable(point),
                name: nullable({ type: 'string' }),
              },
              required: [
                'op',
                'wallId',
                'openingId',
                'a',
                'b',
                'height',
                't',
                'width',
                'style',
                'at',
                'name',
              ],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'summary', 'reasons', 'operations'],
        additionalProperties: false,
      },
    },
  },
  required: ['options'],
  additionalProperties: false,
};

export const layoutPrompt = (level: Level, brief: Brief) =>
  `You are an experienced Singapore residential architect and interior designer. Here is an HDB flat as it is, as JSON (metres; walls by id with the rooms either side; "locked" walls are outside walls, the household shelter's or bathrooms' and must not be changed):

${JSON.stringify(planForModel(level))}

The household: ${brief.household || 'not said'}.
They would like: ${brief.wishes.length ? brief.wishes.join('; ') : 'no particular wishes'}.
${brief.notes ? `They also said: ${brief.notes}` : ''}

Suggest up to three different renovation layouts that suit them, each a realistic, buildable change an HDB-registered contractor could do. For each: a short name, a one-sentence summary, two or three reasons it suits them, and the operations:
- remove_wall (wallId): hack a wall that isn't locked.
- half_wall (wallId, height in m, e.g. 1.0): cut a wall down to counter height.
- glass_wall (wallId): replace a wall with a framed glass partition.
- add_wall (a, b: ends in metres, on the plan's axes, ending on existing walls): build a new partition.
- add_door (wallId, t: 0–1 along the wall, width in m, style: swing, sliding, pocket, bifold or folding): a new door in a wall that isn't an outside wall.
- remove_opening (openingId): close up a door or opening (never a window).
- rename_room (at: a point inside the room after the change, name): name a room for its new use.
Set every field an operation doesn't use to null. Keep every bedroom with a window, keep doors at least 0.75 m wide (0.65 m for a bathroom) and corridors at least 0.9 m, never touch locked walls, and keep the kitchen's wet area where it is.`;

/** Up to three layouts from the person's model, checked against the schema. */
export async function suggestLayouts(
  ai: AiSettings,
  level: Level,
  brief: Brief,
  signal?: AbortSignal,
): Promise<LayoutSuggestions> {
  const raw = await askForJson(ai, layoutPrompt(level, brief), null, LAYOUT_SCHEMA, signal);
  const parsed = LayoutSuggestions.safeParse(lowerEnums(raw, ['op', 'style']));
  if (!parsed.success || parsed.data.options.length === 0) {
    throw new AiError('unreadable', 'The model’s answer wasn’t a set of layouts. Try again.');
  }
  return { options: parsed.data.options.slice(0, 3) };
}
