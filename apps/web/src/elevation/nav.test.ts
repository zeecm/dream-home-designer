import { type Level, faceRef, resolveFace, roomFaces, sampleFlatProject } from '@dhd/core';
import { freeze } from 'immer';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditor } from '../editor';
import { faceForSelection, facePlace, flipRef, imageName, stepRef, wallSides } from './nav';

const level = freeze(sampleFlatProject('prj_t').levels[0], true) as Level;
const bedroom = Object.values(level.rooms).find((r) => r.name === 'Main bedroom');
/** A wall with a room on each side. */
const shared = Object.keys(level.walls).find((id) => wallSides(level, id).length === 2) as string;

describe('the wall view', () => {
  beforeEach(() => {
    useEditor.getState().reset();
    useEditor.setState({ viewMode: 'split' });
  });

  it('opens on a room at A and steps round it, coming back after a full turn', () => {
    expect(bedroom).toBeDefined();
    const id = bedroom?.id as string;
    const a = faceForSelection(level, { kind: 'room', id });
    expect(a?.letter).toBe('A');
    const ref = faceRef(a as NonNullable<typeof a>);
    useEditor.getState().openElevation(ref);
    expect(useEditor.getState().elevation).toEqual({ ref, returnTo: 'split' });
    const { of } = facePlace(level, a as NonNullable<typeof a>);
    let r = ref;
    const seen: string[] = [];
    for (let i = 0; i < of; i++) {
      r = stepRef(level, r, 1) as typeof r;
      seen.push(resolveFace(level, r)?.letter ?? '?');
      useEditor.getState().openElevation(r);
    }
    expect(seen.at(-1)).toBe('A');
    expect(new Set(seen).size).toBe(of);
    // Back one from A is the last face.
    expect(resolveFace(level, stepRef(level, ref, -1) as typeof ref)?.letter).toBe(seen.at(-2));
    // Stepping keeps the view it was opened from.
    expect(useEditor.getState().elevation?.returnTo).toBe('split');
  });

  it('flips to the other room and back, mirrored', () => {
    const [left, right] = wallSides(level, shared);
    expect(left && right && left.roomId !== right.roomId).toBe(true);
    const ref = faceRef(left as NonNullable<typeof left>);
    const other = flipRef(level, ref);
    expect(resolveFace(level, other as typeof ref)?.roomId).toBe(right?.roomId);
    const back = flipRef(level, other as typeof ref);
    expect(resolveFace(level, back as typeof ref)?.roomId).toBe(left?.roomId);
  });

  it('a wall prefers the side looking into the room last looked at', () => {
    const [left, right] = wallSides(level, shared);
    const sel = { kind: 'wall' as const, id: shared };
    expect(faceForSelection(level, sel)?.roomId).toBe(left?.roomId);
    expect(faceForSelection(level, sel, right?.roomId)?.roomId).toBe(right?.roomId);
  });

  it('closing returns to the view it was opened from; choosing a view closes it', () => {
    const f = roomFaces(level, bedroom?.id as string)[0];
    const ed = useEditor.getState();
    ed.select({ kind: 'room', id: bedroom?.id as string });
    ed.openElevation(faceRef(f as NonNullable<typeof f>));
    useEditor.getState().closeElevation();
    expect(useEditor.getState()).toMatchObject({ elevation: null, viewMode: 'split' });
    // The selection is the plan's: the wall view leaves it alone.
    expect(useEditor.getState().selection).toEqual({ kind: 'room', id: bedroom?.id });
    useEditor.getState().openElevation(faceRef(f as NonNullable<typeof f>));
    useEditor.getState().setViewMode('3d');
    expect(useEditor.getState()).toMatchObject({ elevation: null, viewMode: '3d' });
  });

  it('opening from a walk ends it, and closing goes back to the view the walk began in', () => {
    const f = roomFaces(level, bedroom?.id as string)[0];
    useEditor.setState({ viewMode: 'split' });
    useEditor.getState().startWalk();
    useEditor.getState().openElevation(faceRef(f as NonNullable<typeof f>));
    expect(useEditor.getState()).toMatchObject({ walking: null, viewMode: 'split' });
    useEditor.getState().closeElevation();
    expect(useEditor.getState().viewMode).toBe('split');
  });

  it('names the picture after the room and the face', () => {
    expect(imageName('Main bedroom', { letter: 'C', label: 'bed wall' })).toBe(
      'Main bedroom – C bed wall.png',
    );
    expect(imageName('Study/office', { letter: 'B', label: null })).toBe(
      'Study office – Wall B.png',
    );
  });
});
