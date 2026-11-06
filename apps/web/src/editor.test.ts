import { describe, expect, it } from 'vitest';
import { shownView, useEditor } from './editor';

describe('the view shown', () => {
  it('is the mode chosen where there is room for two views', () => {
    expect(shownView('split', 'plan', false)).toBe('split');
    expect(shownView('3d', 'plan', false)).toBe('3d');
  });

  it('is the last single view on a phone with Split on, and Split comes back wider', () => {
    expect(shownView('split', '3d', true)).toBe('3d');
    expect(shownView('split', 'plan', true)).toBe('plan');
    expect(shownView('plan', '3d', true)).toBe('plan');
  });

  it('remembers the last single view chosen, not Split', () => {
    const { setViewMode } = useEditor.getState();
    setViewMode('3d');
    setViewMode('split');
    expect(useEditor.getState()).toMatchObject({ viewMode: 'split', lastSingle: '3d' });
    setViewMode('plan');
    expect(useEditor.getState().lastSingle).toBe('plan');
  });
});
