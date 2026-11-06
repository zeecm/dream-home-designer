import { describe, expect, it } from 'vitest';
import { HIGH_FIDELITY } from './render';

describe('OpenAI render options', () => {
  it('asks for high input fidelity only of models known to take it', () => {
    expect(HIGH_FIDELITY.test('gpt-image-1')).toBe(true);
    expect(HIGH_FIDELITY.test('gpt-image-1-2025-04-23')).toBe(true);
    expect(HIGH_FIDELITY.test('gpt-image-1-mini')).toBe(false);
    expect(HIGH_FIDELITY.test('dall-e-2')).toBe(false);
  });
});
