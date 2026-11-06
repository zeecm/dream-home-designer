import { describe, expect, it } from 'vitest';
import { roomIdAt } from './designer/spaces';
import { withPieces } from './fixtures/furnishedSample';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import {
  type SceneCamera,
  boxInFrustum,
  cameraFrame,
  eyeLevelCamera,
  sceneFacts,
  sceneSheet,
} from './sceneFacts';

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * The reference flat's Bedroom 2 (x 3.5 to 7, y 4.5 to 8.5; 14 m², ceiling 2.6 m) with a
 * single bed and a wardrobe, a plant behind the camera below, and a queen bed next door in
 * the master bedroom, behind the wall.
 */
function furnished() {
  return withPieces(hdb4RoomLevel(), [
    ['bed-single', { x: 5.5, y: 7.45 }],
    ['wardrobe', { x: 6.0, y: 4.85 }],
    ['plant', { x: 3.8, y: 6.5 }],
    ['bed-queen', { x: 9, y: 6.5 }],
  ]);
}

const names = (f: ReturnType<typeof sceneFacts>) => f.items.map((i) => i.name);

describe('scene facts', () => {
  const level = furnished();

  it('from inside Bedroom 2 at eye height: its size, the camera, and only what is in sight', () => {
    const cam: SceneCamera = {
      position: { x: 4.2, y: 1.6, z: 6.5 },
      target: { x: 7, y: 1.6, z: 6.5 },
      fov: deg(45),
      aspect: 1.5,
    };
    const f = sceneFacts(level, cam);
    expect(f.view).toBe('eye');
    expect(f.cameraRoomId).toBe('rm_bed2');
    expect(f.height).toBeCloseTo(1.6);
    expect(f.fovUp).toBeCloseTo(45);
    expect(f.fovAcross).toBeGreaterThan(60);
    const room = f.rooms[0];
    expect(room?.name).toBe('Bedroom 2');
    // Looking along x: the room's 4 m along y runs across the picture, 3.5 m into it.
    expect(room?.width).toBeCloseTo(4);
    expect(room?.depth).toBeCloseTo(3.5);
    expect(room?.area).toBeCloseTo(14);
    expect(room?.ceilingHeight).toBeCloseTo(2.6);
    // The plant is behind the camera; the queen bed is behind the wall.
    expect(names(f).sort()).toEqual(['Single bed', 'Wardrobe']);
    const bed = f.items.find((i) => i.name === 'Single bed');
    expect(bed?.size.w).toBeCloseTo(0.92);
    expect(bed?.where).toBe('against the right wall, by the window');
    expect(f.items.find((i) => i.name === 'Wardrobe')?.where).toBe('against the left wall');

    const sheet = sceneSheet(f, { finishes: true });
    expect(sheet).toContain('This is Bedroom 2, 4.0 m × 3.5 m (14.0 m²), ceiling 2.6 m.');
    expect(sheet).toContain('1.6 m above the floor');
    expect(sheet).toContain('Single bed 0.9 × 2.0');
    expect(sheet).toContain('Wardrobe 1.2 × 0.6 × 2.1 m (against the left wall)');
    expect(sheet).not.toContain('Queen');
    expect(sheet).not.toContain('plant');
    expect(sheet).toContain('it is small');
    expect(sheet).toContain('Finishes in Bedroom 2: walls White; floor Oak.');
  });

  it('leaves out a piece behind the camera (frustum culling)', () => {
    const f = cameraFrame({
      position: { x: 0, y: 1.6, z: 0 },
      target: { x: 1, y: 1.6, z: 0 },
      fov: deg(60),
      aspect: 1,
    });
    const box = (x: number) =>
      [-0.2, 0.2].flatMap((dx) =>
        [-0.2, 0.2].flatMap((dz) => [0, 1].map((y) => ({ x: x + dx, y, z: dz }))),
      );
    expect(boxInFrustum(f, box(2))).toBe(true);
    expect(boxInFrustum(f, box(-2))).toBe(false);
    // Off to the side, past the edge of the view.
    expect(
      boxInFrustum(
        f,
        box(2).map((p) => ({ ...p, z: p.z + 5 })),
      ),
    ).toBe(false);
    // Big enough to span the whole view with no corner inside it: still in sight.
    const wide = [-3, 3].flatMap((z) =>
      [-1, 3].flatMap((y) => [
        { x: 2, y, z },
        { x: 2.5, y, z },
      ]),
    );
    expect(boxInFrustum(f, wide)).toBe(true);
  });

  it('from overhead: says so, the room the view centres on first, and sees over the walls', () => {
    const cam: SceneCamera = {
      position: { x: 5.25, y: 9, z: 6.5 },
      target: { x: 5.25, y: 0, z: 6.45 },
      fov: deg(40),
      aspect: 1.5,
    };
    const f = sceneFacts(level, cam);
    expect(f.view).toBe('overhead');
    expect(f.height).toBeCloseTo(9);
    expect(f.rooms[0]?.name).toBe('Bedroom 2');
    expect(f.rooms.map((r) => r.name)).toContain('Master bedroom');
    expect(names(f)).toContain('Queen bed');
    expect(names(f)).toContain('Single bed');
    const sheet = sceneSheet(f);
    expect(sheet).toContain('cut-away view from above');
    expect(sheet).toContain('look bigger than they are');
    expect(sheet).toContain('Keep every room exactly this size');

    // Eye height in that room: 1.6 m up, inside Bedroom 2, facing across the floor.
    const eye = eyeLevelCamera(level, cam);
    expect(eye?.roomId).toBe('rm_bed2');
    const p = eye?.camera.position;
    expect(p?.y).toBeCloseTo(1.6);
    expect(roomIdAt(level, { x: p?.x ?? 0, y: p?.z ?? 0 })).toBe('rm_bed2');
    const ef = eye && sceneFacts(level, eye.camera);
    expect(ef?.view).toBe('eye');
    expect(ef?.fovAcross).toBeCloseTo(70, 0);
    // Where a person could stand: not in the bed (x 5.04 to 5.96, y 6.45 to 8.45).
    const inBed = (p?.x ?? 0) > 5.04 - 0.3 && (p?.x ?? 0) < 5.96 + 0.3 && (p?.z ?? 0) > 6.45 - 0.3;
    expect(inBed).toBe(false);
    // Facing about the picture's up (-y in plan): a cramped view may turn, by 60° at most.
    const t = eye?.camera.target;
    const d = { x: (t?.x ?? 0) - (p?.x ?? 0), z: (t?.z ?? 0) - (p?.z ?? 0) };
    expect(-d.z / Math.hypot(d.x, d.z)).toBeGreaterThanOrEqual(Math.cos(deg(60)) - 1e-9);
    expect(names(ef as NonNullable<typeof ef>)).not.toContain('Queen bed');
  });

  it('from outside the flat: an outside view, and nothing behind the front wall', () => {
    const cam: SceneCamera = {
      position: { x: 5.5, y: 1.6, z: -3 },
      target: { x: 2.5, y: 1.6, z: 2 },
      fov: deg(40),
      aspect: 1.5,
    };
    const l = withPieces(hdb4RoomLevel(), [['sofa-3', { x: 2.5, y: 2 }]]);
    const f = sceneFacts(l, cam);
    expect(f.view).toBe('outside');
    expect(f.cameraRoomId).toBeNull();
    expect(f.rooms[0]?.name).toBe('Living');
    expect(f.items).toEqual([]);
    expect(sceneSheet(f)).toContain('from outside the rooms');
    expect(sceneSheet(f)).toContain('There is no furniture in view.');
    // From eye height in the living room, the sofa is in sight.
    const eye = eyeLevelCamera(l, cam);
    expect(eye?.roomId).toBe('rm_living');
    expect(names(sceneFacts(l, eye?.camera as SceneCamera))).toEqual(['3-seat sofa']);
  });

  it('lists at most 25 pieces, largest first, and counts the rest', () => {
    const many = withPieces(
      hdb4RoomLevel(),
      Array.from({ length: 30 }, (_, i) => [
        'plant',
        { x: 5.2 + (i % 6) * 0.25, y: 5.2 + Math.floor(i / 6) * 0.5 },
      ]),
    );
    const f = sceneFacts(many, {
      position: { x: 5.25, y: 9, z: 6.5 },
      target: { x: 5.25, y: 0, z: 6.45 },
      fov: deg(40),
      aspect: 1.5,
    });
    expect(f.items).toHaveLength(25);
    expect(f.moreItems).toBe(5);
    expect(sceneSheet(f)).toContain('and 5 smaller pieces');
  });
});
