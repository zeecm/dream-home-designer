import { describe, expect, it } from 'vitest';
import { addOpening, updateWall, updateLevel } from './commands';
import { hdb4RoomProject } from './fixtures/hdb4room';
import { dispatch, emptyHistory } from './history';
import { renovationChanges, renovationDiff, startRenovation } from './renovation';
import { collisionSegments } from './walk';
import { planGeometry } from './plan';
import * as C from './commands';
const L = 'lvl_ground';
const A = `${L}__after`;
const reno = () => dispatch({ doc: hdb4RoomProject(), history: emptyHistory() }, startRenovation());
describe('scratch', () => {
  it('stale glassAbove after back to full', () => {
    const aid = reno().doc.renovation!.levels[0]!.id;
    let s = reno();
    s = dispatch(s, updateWall(aid, 'w_living_kitchen', { height: 1, glassAbove: true }));
    s = dispatch(s, updateWall(aid, 'w_living_kitchen', { height: undefined }));
    const w = s.doc.renovation!.levels[0]!.walls.w_living_kitchen!;
    console.log('wall', JSON.stringify(w));
    const before = s.doc.levels[0]!, after = s.doc.renovation!.levels[0]!;
    console.log('changes', JSON.stringify(renovationChanges(before, after).map((c) => [c.kind, (c as any).length])));
  });
  it('collision includes glass and half wall', () => {
    let s = { doc: hdb4RoomProject(), history: emptyHistory() };
    const base = collisionSegments(s.doc.levels[0]!).length;
    s = dispatch(s, updateWall(L, 'w_living_kitchen', { build: 'glass' }));
    s = dispatch(s, updateWall(L, 'w_mid_3', { height: 1 }));
    console.log('segments', base, collisionSegments(s.doc.levels[0]!).length);
    const g = planGeometry(s.doc.levels[0]!);
    console.log('pieces for glass', g.pieces.filter((p) => p.wallId === 'w_living_kitchen').length, g.pieces.filter((p) => p.wallId === 'w_mid_3').length);
  });
  it('glass then boundary and back', () => {
    let s = { doc: hdb4RoomProject(), history: emptyHistory() };
    s = dispatch(s, updateWall(L, 'w_mid_3', { height: 1, glassAbove: true }));
    s = dispatch(s, updateWall(L, 'w_mid_3', { height: 2.6 }));
    console.log('full height via number', JSON.stringify(s.doc.levels[0]!.walls.w_mid_3));
  });
});
