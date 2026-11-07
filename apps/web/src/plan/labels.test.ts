import {
  type Command,
  type Level,
  type Project,
  dispatch,
  emptyHistory,
  furnishedSample,
  moveRoom,
  moveVertex,
  planGeometry,
  planRoomMove,
  renameRoom,
  sampleFlatProject,
  tiledLevel,
  updateItem,
  updateOpening,
} from '@dhd/core';
import { freeze } from 'immer';
import { describe, expect, it } from 'vitest';
import { type RoomLabel, roomLabelBoxes, roomLabels } from './layers';

/** A terrace of furnished flats as the store holds it: frozen, edited through commands. */
function terrace(cols: number, rows: number) {
  const project: Project = {
    ...sampleFlatProject('prj_labels'),
    levels: [tiledLevel(furnishedSample(), cols, rows)],
  };
  let s = { doc: freeze(structuredClone(project), true), history: emptyHistory() };
  const level = () => s.doc.levels[0] as Level;
  const run = (c: Command, coalesceKey?: string) => {
    s = dispatch(s, c, coalesceKey ? { coalesceKey } : {});
    return level();
  };
  return { level, run };
}

/** Zoom steps from a whole terrace on screen to one room filling it. */
const ZOOMS = [2 ** (34 / 8), 2 ** (40 / 8), 2 ** (43 / 8), 2 ** (48 / 8), 2 ** (54 / 8)];

describe('room labels, fitted once per room', () => {
  it('match fitting every room afresh, to the bit, across drags and edits', () => {
    const { level, run } = terrace(2, 2);
    const memo = new Map<string, RoomLabel>();
    const check = (l: Level) => {
      const geom = planGeometry(l);
      for (const z of ZOOMS) {
        expect(JSON.stringify(roomLabels(l, geom, z, memo))).toBe(
          JSON.stringify(roomLabels(l, geom, z, null)),
        );
      }
    };
    check(level());
    const lvl = level();
    const corner = lvl.vertices.t0_v_6p495_3p098;
    const piece = lvl.items.t1_it_f004;
    const door = Object.values(lvl.openings).find((o) => o.kind === 'door');
    if (!corner || !piece || !door) throw new Error('fixture');
    // A corner dragged a few steps, as the select tool does.
    for (let k = 1; k <= 4; k++) {
      check(run(moveVertex(lvl.id, corner.id, { x: corner.x + 0.07 * k, y: corner.y }), 'v'));
    }
    // A piece dragged across its room.
    for (let k = 1; k <= 4; k++) {
      const position = { x: piece.position.x + 0.3 * k, z: piece.position.z - 0.1 * k };
      check(run(updateItem(lvl.id, piece.id, { position }), 'p'));
    }
    // A room moved, renamed, and a door turned the other way.
    const roomId = Object.keys(lvl.rooms)[3] as string;
    const move = planRoomMove(level(), roomId, null);
    check(run(moveRoom(level(), move, { x: 0.12, y: 0 })));
    check(run(renameRoom(lvl.id, roomId, 'A room with a much longer name than before')));
    check(run(updateOpening(lvl.id, door.id, { swing: 'rightOut' })));
  });

  it('re-fits only the rooms an edit changes', () => {
    const { level, run } = terrace(4, 2);
    const memo = new Map<string, RoomLabel>();
    const z = ZOOMS[1] as number;
    const fit = (l: Level) => roomLabels(l, planGeometry(l), z, memo);
    const rooms = fit(level()).length;
    expect(rooms).toBeGreaterThan(40);
    const lvl = level();
    const piece = lvl.items.t5_it_f004;
    if (!piece) throw new Error('fixture');
    const before = memo.size;
    fit(run(updateItem(lvl.id, piece.id, { position: { x: piece.position.x + 0.2 } })));
    // The piece's room, and any whose box it reaches; not the other flats' rooms.
    expect(memo.size - before).toBeGreaterThan(0);
    expect(memo.size - before).toBeLessThan(5);
  });

  it('fit a 72-room terrace in a few milliseconds a drag step', () => {
    const { level, run } = terrace(4, 2);
    const lvl = level();
    const corner = lvl.vertices.t2_v_6p495_3p098;
    if (!corner) throw new Error('fixture');
    roomLabelBoxes(lvl, planGeometry(lvl), 40);
    const times: number[] = [];
    for (let k = 1; k <= 9; k++) {
      const l = run(moveVertex(lvl.id, corner.id, { x: corner.x + 0.01 * k, y: corner.y }), 'v');
      const geom = planGeometry(l);
      const t0 = performance.now();
      roomLabelBoxes(l, geom, 40);
      times.push(performance.now() - t0);
    }
    const median = [...times].sort((a, b) => a - b)[4] as number;
    console.log(`room labels, 72 rooms: ${median.toFixed(2)} ms a drag step`);
    // About 2 s a step before rooms were fitted one by one; a loose bound, as the suite runs
    // in parallel.
    expect(median).toBeLessThan(150);
  });
});
