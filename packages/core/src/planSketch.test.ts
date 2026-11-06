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
});
