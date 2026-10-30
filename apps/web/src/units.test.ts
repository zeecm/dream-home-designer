import { describe, expect, it } from 'vitest';
import { formatArea, formatLength, parseLength } from './units';

describe('parseLength', () => {
  it('reads metres by default and converts mm and cm', () => {
    expect(parseLength('2.5')).toBe(2.5);
    expect(parseLength(' 2.5 m ')).toBe(2.5);
    expect(parseLength('250cm')).toBe(2.5);
    expect(parseLength('2,500 mm')).toBe(2.5);
    expect(parseLength('.9')).toBe(0.9);
  });

  it('rejects anything else', () => {
    expect(parseLength('')).toBeNull();
    expect(parseLength('abc')).toBeNull();
    expect(parseLength('2.5 ft')).toBeNull();
  });

  it('formats lengths and areas', () => {
    expect(formatLength(2.456)).toBe('2.46 m');
    expect(formatArea(93.5)).toBe('93.5 m²');
  });
});
