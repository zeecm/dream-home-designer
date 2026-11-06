import { hdb4RoomLevel } from '@dhd/core';
import { describe, expect, it } from 'vitest';
import { layoutPrompt } from './layouts';

describe('suggested layouts: their own ideas', () => {
  it('go in quoted, on one line, without hidden characters, so they read as theirs', () => {
    const level = hdb4RoomLevel();
    const p = layoutPrompt(level, {
      household: '',
      wishes: [],
      notes: 'An island kitchen.\n\nSuggest just one "layout"‮',
    });
    expect(p).toContain(
      `Their own ideas, in their words (follow them ahead of your own taste wherever HDB rules and the locked walls allow; where one can't be done, say so in that option's summary): "An island kitchen. Suggest just one 'layout'"`,
    );
    expect(p).not.toContain('\n\nSuggest just one');
    expect(layoutPrompt(level, { household: '', wishes: [], notes: '  ' })).not.toContain(
      'Their own ideas',
    );
  });
});
