import { describe, expect, it } from 'vitest';
import fixture from '../../../apps/api/internal/comments/testdata/comments.json';
import { CommentsDoc } from './comments';

describe('the comments document', () => {
  it('parses the API fixture (apps/api/internal/comments/testdata)', () => {
    const doc = CommentsDoc.parse(fixture);
    expect(doc.version).toBe(7);
    expect(doc.threads.map((t) => t.anchor.target?.kind ?? 'spot')).toEqual([
      'wall',
      'item',
      'room',
      'spot',
    ]);
    expect(doc.threads[1]?.resolved?.name).toBe('Wei Ling');
    expect(doc.threads[0]?.messages[1]?.mine).toBe(true);
    // Never sent to clients.
    expect(JSON.stringify(fixture)).not.toContain('authHash');
  });

  it('refuses an unknown target kind or variant', () => {
    const bad = structuredClone(fixture) as { threads: { anchor: Record<string, unknown> }[] };
    const first = bad.threads[0];
    if (!first) throw new Error('fixture has no thread');
    first.anchor.variant = 'x';
    expect(CommentsDoc.safeParse(bad).success).toBe(false);
  });
});
