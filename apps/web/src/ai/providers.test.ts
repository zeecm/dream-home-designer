import { failure } from '@dhd/ai';
import { describe, expect, it } from 'vitest';
import { inSettings } from './providers';

describe('provider error messages, in AI settings', () => {
  it('leaves out the pointer to AI settings inside AI settings', () => {
    const e = failure('openai', 401, {});
    expect(e.message).toBe('The key was refused. Check it in AI settings.');
    expect(inSettings(e)).toBe('The key was refused.');
    const other = failure('gemini', 404, { error: { message: 'Not found' } });
    expect(inSettings(other)).toBe(other.message);
  });
});
