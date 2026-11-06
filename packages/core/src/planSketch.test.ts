import { describe, expect, it } from 'vitest';
import { withPieces } from './fixtures/furnishedSample';
import { hdb4RoomLevel } from './fixtures/hdb4room';
import { SKETCH_COLOURS, planSketch } from './planSketch';

const deg = (d: number) => (d * Math.PI) / 180;
const eye = {
  position: { x: 5.25, y: 1.6, z: 8 },
  target: { x: 5.25, y: 1.6, z: 4 },
  fov: deg(45),
  aspect: 1.5,
};

describe('plan sketch', () => {
  it('draws the walls, windows, doors and furniture, sized to fit', () => {
    const level = withPieces(hdb4RoomLevel(), [['sofa-3', { x: 2.5, y: 2 }]]);
    const { svg, width, height } = planSketch(level, eye, 800);
    expect(Math.max(width, height)).toBe(800);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    const count = (colour: string) => svg.split(`fill="${colour}"`).length - 1;
    // Five windows, four doors (each a leaf), the furniture outlined.
    expect(count(SKETCH_COLOURS.window)).toBe(5);
    expect(count(SKETCH_COLOURS.door)).toBe(4);
    expect(svg).toContain(`stroke="${SKETCH_COLOURS.furniture}"`);
    expect(count(SKETCH_COLOURS.wall)).toBeGreaterThan(10);
    // No text: a model mustn't copy words into the render.
    expect(svg).not.toContain('<text');
  });

  it('marks the camera and a wedge the way it looks', () => {
    const { svg } = planSketch(hdb4RoomLevel(), eye);
    expect(svg).toContain('<circle cx="5.25" cy="8"');
    // The wedge reaches towards smaller y (the camera looks along -y).
    const wedge = svg.match(/<polygon points="([^"]+)" fill="#e0201b"/)?.[1] ?? '';
    const ys = wedge.split(' ').map((p) => Number(p.split(',')[1]));
    expect(Math.min(...ys)).toBeLessThan(3);
    expect(Math.max(...ys)).toBeCloseTo(8, 3);
  });

  it('looking straight down, marks the floor in the picture', () => {
    const { svg } = planSketch(hdb4RoomLevel(), {
      position: { x: 5, y: 10, z: 4 },
      target: { x: 5, y: 0, z: 3.99 },
      fov: deg(40),
      aspect: 1,
    });
    const quad = svg.match(/<polygon points="([^"]+)" fill="#e0201b"/)?.[1] ?? '';
    expect(quad.split(' ')).toHaveLength(4);
    const xs = quad.split(' ').map((p) => Number(p.split(',')[0]));
    // 10 m up with a 40° view: about 3.6 m either side.
    expect(Math.max(...xs) - 5).toBeCloseTo(10 * Math.tan(deg(20)), 1);
  });

  it('from the default 3D view, far off and above the walls, marks the floor of the home', () => {
    // The orbit camera's direction (CameraRig), 25 m from the middle of the flat.
    const dir = { x: 0.45, y: 0.78, z: 0.62 };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    const mid = { x: 5.5, y: 0, z: 4.25 };
    const cam = {
      position: {
        x: mid.x + (dir.x / l) * 25,
        y: (dir.y / l) * 25,
        z: mid.z + (dir.z / l) * 25,
      },
      target: mid,
      fov: deg(40),
      aspect: 1.5,
    };
    const { svg } = planSketch(hdb4RoomLevel(), cam);
    // The drawing is the home (11 × 8.5 m) with a little room, not stretched to the camera.
    const [, , w, h] = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? '').split(' ').map(Number);
    expect(w).toBeLessThan(11 + 2 * (1.5 + 0.6) + 0.01);
    expect(h).toBeLessThan(8.5 + 2 * (1.5 + 0.6) + 0.01);
    // The shaded area covers the middle of the flat.
    const area = svg.match(/<polygon points="([^"]+)" fill="#e0201b"/)?.[1] ?? '';
    const ring = area.split(' ').map((p) => {
      const [x, y] = p.split(',').map(Number);
      return { x: x as number, y: y as number };
    });
    const inside = (p: { x: number; y: number }) => {
      let hit = false;
      ring.forEach((a, i) => {
        const b = ring[(i + 1) % ring.length] as { x: number; y: number };
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
          hit = !hit;
        }
      });
      return hit;
    };
    expect(ring.length).toBeGreaterThanOrEqual(3);
    expect(inside({ x: mid.x, y: mid.z })).toBe(true);
  });

  it('is padded to the shape of the view, so it never sets the shape of a render', () => {
    const { width, height } = planSketch(hdb4RoomLevel(), eye, 1200, 1.5);
    expect(width / height).toBeCloseTo(1.5, 2);
    const tall = planSketch(hdb4RoomLevel(), eye, 1200, 0.5);
    expect(tall.width / tall.height).toBeCloseTo(0.5, 2);
  });
});
