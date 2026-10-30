import { describe, expect, it } from 'vitest';
import { blankProject } from './factory';
import { Project } from './schema';

describe('blankProject', () => {
  it('is a valid project with one empty level and an API-safe id', () => {
    const p = blankProject('My flat');
    expect(Project.parse(p)).toEqual(p);
    expect(p.name).toBe('My flat');
    expect(p.levels).toHaveLength(1);
    expect(Object.keys(p.levels[0]?.walls ?? {})).toHaveLength(0);
    expect(p.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
});
