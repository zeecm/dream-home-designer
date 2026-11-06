import concept from '../../../../../../packages/core/src/designer/fixtures/concept.json' with {
  type: 'json',
};
import bedroom from '../../../../../../packages/core/src/designer/fixtures/room-bedroom.json' with {
  type: 'json',
};
import kitchen from '../../../../../../packages/core/src/designer/fixtures/room-kitchen.json' with {
  type: 'json',
};
import living from '../../../../../../packages/core/src/designer/fixtures/room-living.json' with {
  type: 'json',
};
import mainBedroom from '../../../../../../packages/core/src/designer/fixtures/room-main-bedroom.json' with {
  type: 'json',
};

/**
 * The sample flat's mocked answers (the core's fixtures), and which one a request asks for,
 * read from its prompt as a provider would see it. The concept here also asks to hack the
 * household shelter's wall (W32), which must be left out.
 */
export const SHELTER_OP = {
  op: 'remove_wall',
  wall: 'W32',
  opening: null,
  a: null,
  b: null,
  height: null,
  t: null,
  width: null,
  style: null,
};

export const CONCEPT = { ...concept, walls: [...concept.walls, SHELTER_OP] };

/** Room answers by a word of the space's name in the prompt ("furnish \"Kitchen\""). */
export const ROOMS: { match: RegExp; answer: unknown }[] = [
  { match: /furnish "Master bedroom"/, answer: mainBedroom },
  { match: /furnish "Mdm Lim/, answer: bedroom },
  { match: /furnish "Living/, answer: living },
  { match: /furnish "Kitchen"/, answer: kitchen },
];

/** The answer a prompt asks for: the concept, a room's, or null. */
export function answerFor(prompt: string): { step: string; answer: unknown } | null {
  if (prompt.includes('## Your task: the layout and style'))
    return { step: 'layout', answer: CONCEPT };
  for (const r of ROOMS) {
    const m = r.match.exec(prompt);
    if (m) return { step: m[0], answer: r.answer };
  }
  return null;
}

/** The text of a request body, whichever provider's shape it has. */
export function promptOf(body: unknown): string {
  const b = body as {
    messages?: { content?: unknown }[];
    contents?: { parts?: { text?: string }[] }[];
  };
  const parts: string[] = [];
  for (const m of b.messages ?? []) {
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content as { text?: string }[]) if (c.text) parts.push(c.text);
    }
  }
  for (const c of b.contents ?? []) for (const p of c.parts ?? []) if (p.text) parts.push(p.text);
  return parts.join('');
}
