import {
  FLOOR_FINISHES,
  type Item,
  type Level,
  PAINTS,
  type Vec2,
  dispatch,
  emptyHistory,
  finish,
  furnitureKind,
  newItem,
  placeFurniture,
  planGeometry,
  roomArea,
  roomShapes,
  sampleFlatProject,
  shiftBlocked,
  shiftIds,
  shiftWall,
  wallNormal,
} from '@dhd/core';
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { MiniPlan, area, planBox } from './MiniPlan';

const project = sampleFlatProject('prj_welcome');
const sample = project.levels[0] as Level;
const geom = planGeometry(sample);
const BOX = planBox(sample, 0.5);
const DIVIDER = 'w_bedroom_main-bedroom';
const MAIN = 'rm_main-bedroom';
const BED = 'rm_bedroom';

const roomOf = (l: Level, id: string) => l.rooms[id];
const areaOf = (l: Level, id: string) => {
  const r = roomOf(l, id);
  return r ? roomArea(l, r) : 0;
};

/** A piece placed in a room as the app's Furniture tool would: at a spot, backed to a wall. */
function piece(id: string, kindId: string, room: string, fx: number, fy: number, turn = 0): Item {
  const kind = furnitureKind(kindId);
  const s = roomShapes(sample).get(room)?.outer ?? [];
  const xs = s.map((p) => p.x);
  const ys = s.map((p) => p.y);
  const at = {
    x: Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * fx,
    y: Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * fy,
  };
  if (!kind) throw new Error(`no furniture ${kindId}`);
  const spot = placeFurniture(geom, kind, at, turn);
  return newItem(id, kind, spot.at, spot.rotation, sample.ceilingHeight);
}

const FURNISHED: Item[] = [
  piece('it_bed', 'bed-queen', MAIN, 0.5, 0.08),
  piece('it_bedside', 'bedside', MAIN, 0.14, 0.05),
  piece('it_wardrobe', 'wardrobe', MAIN, 0.06, 0.6, Math.PI / 2),
  piece('it_single', 'bed-single', BED, 0.5, 0.1),
  piece('it_sofa', 'sofa-3', 'rm_living-and-dining', 0.75, 0.18),
  piece('it_tv', 'tv-console', 'rm_living-and-dining', 0.75, 0.94, Math.PI),
  piece('it_table', 'dining-4', 'rm_living-and-dining', 0.32, 0.75),
];

/** Sections' parts rise into place as they come into view (CSS does nothing without motion). */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      for (const el of els) el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);
}

export function Welcome() {
  useReveal();
  return (
    <>
      <Hero />
      <main>
        <Steps />
        <ThreeD />
        <Rooms />
        <Renovate />
        <Questions />
        <Start />
      </main>
      <Footer />
    </>
  );
}

/* ------------------------------------------------------------------------------- hero */

const STEP = 0.05;

function Hero() {
  const ids = useMemo(() => shiftIds(sample, DIVIDER), []);
  const n = useMemo(() => wallNormal(sample, DIVIDER) ?? { x: 1, y: 0 }, []);
  const [offset, setOffset] = useState(0);
  // How far the wall can go each way (a positive offset moves it left, into the main bedroom).
  const limits = useMemo(() => {
    const reach = (dir: number) => {
      let o = 0;
      while (Math.abs(o) < 2 && !shiftBlocked(sample, DIVIDER, o + dir * 0.01)) o += dir * 0.01;
      return Math.round(o * 100) / 100;
    };
    return { left: reach(1), right: reach(-1) };
  }, []);
  const level = useMemo(() => {
    if (offset === 0) return sample;
    const s = dispatch(
      { doc: project, history: emptyHistory() },
      shiftWall(sample, DIVIDER, offset, ids),
    );
    return s.doc.levels[0] as Level;
  }, [offset, ids]);
  const g = useMemo(() => planGeometry(level), [level]);
  const svg = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ from: Vec2; start: number } | null>(null);

  /** Moves the wall towards `want`, stopping where the app would (a door, a wall). */
  const moveTo = (want: number) => {
    const target = Math.round(want * 100) / 100;
    let off = offset;
    const dir = Math.sign(target - off);
    while (dir !== 0 && (target - off) * dir > 1e-9) {
      const next = off + dir * 0.01;
      if (shiftBlocked(sample, DIVIDER, next)) break;
      off = next;
    }
    setOffset(Math.round(off / 0.01) * 0.01);
  };
  const planPoint = (e: PointerEvent): Vec2 | null => {
    const m = svg.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const main = areaOf(level, MAIN);
  const bed = areaOf(level, BED);
  const moved = Math.abs(offset);
  return (
    <header className="hero">
      <div className="hero-copy">
        <p className="mark">Dream Home</p>
        <div className="hero-text">
          <h1 className="hero-title">
            <span className="line">
              <span>Draw your flat.</span>
            </span>{' '}
            <span className="line">
              <span>Walk through it.</span>
            </span>
          </h1>
          <p className="hero-sub">
            A free home planner in your browser: trace the floor plan you already have, furnish it,
            plan the renovation and walk through the result in 3D.
          </p>
          <a className="button" href="/?sample">
            Open the sample flat
          </a>
        </div>
      </div>
      <div className="hero-stage">
        <a className="hero-link" href="/?new=">
          Start a blank plan
        </a>
        <figure className="fragment hero-fragment" data-ui>
          <MiniPlan
            className="hero-plan"
            level={level}
            geom={g}
            box={BOX}
            show={{ walls: true, rooms: true, labels: true }}
            selected={DIVIDER}
            labelSize={0.3}
            title="The sample 3-room flat's plan, with the wall between the bedrooms selected"
          >
            {/* The selected wall, wide enough to take a finger, and a slider to keyboards. */}
            <WallGrip
              level={level}
              offset={offset}
              svg={svg}
              limits={limits}
              onKey={(to) => moveTo(to)}
              onDown={(e) => {
                const p = planPoint(e);
                if (!p) return;
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                drag.current = { from: p, start: offset };
              }}
              onMove={(e) => {
                const d = drag.current;
                const p = planPoint(e);
                if (!d || !p) return;
                // A drag moves in 5 cm steps; the keys go exactly where they say.
                const raw = d.start + (p.x - d.from.x) * n.x + (p.y - d.from.y) * n.y;
                moveTo(Math.round(raw / STEP) * STEP);
              }}
              onUp={() => {
                drag.current = null;
              }}
              main={main}
              bed={bed}
            />
          </MiniPlan>
          <figcaption className="readout">
            <span>
              Main bedroom <b>{area(main)}</b>
            </span>
            <span>
              Bedroom <b>{area(bed)}</b>
            </span>
            <span className="readout-note">
              {moved > 0 ? `Wall moved ${moved.toFixed(2)} m` : 'Drag the selected wall'}
            </span>
          </figcaption>
        </figure>
      </div>
    </header>
  );
}

function WallGrip({
  level,
  offset,
  svg,
  limits,
  onKey,
  onDown,
  onMove,
  onUp,
  main,
  bed,
}: {
  level: Level;
  offset: number;
  svg: React.MutableRefObject<SVGSVGElement | null>;
  limits: { left: number; right: number };
  onKey: (to: number) => void;
  onDown: (e: PointerEvent) => void;
  onMove: (e: PointerEvent) => void;
  onUp: () => void;
  main: number;
  bed: number;
}) {
  const w = level.walls[DIVIDER];
  const a = w && level.vertices[w.a];
  const b = w && level.vertices[w.b];
  if (!a || !b) return null;
  return (
    <g
      ref={(el) => {
        svg.current = el?.ownerSVGElement ?? null;
      }}
      className="grip"
      tabIndex={0}
      role="slider"
      aria-label="The wall between the bedrooms"
      // Its value is how far it has moved to the right, in metres.
      aria-valuemin={-limits.left}
      aria-valuemax={-limits.right}
      aria-valuenow={Number((-offset).toFixed(2)) || 0}
      aria-valuetext={`Main bedroom ${area(main)}, bedroom ${area(bed)}`}
      onKeyDown={(e) => {
        const to: Record<string, number> = {
          ArrowLeft: offset + STEP,
          ArrowDown: offset + STEP,
          ArrowRight: offset - STEP,
          ArrowUp: offset - STEP,
          PageDown: offset + 4 * STEP,
          PageUp: offset - 4 * STEP,
          Home: limits.left,
          End: limits.right,
        };
        const target = to[e.key];
        if (target === undefined) return;
        e.preventDefault();
        onKey(target);
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="grip-hit" />
      <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r={0.22} className="grip-knob" />
    </g>
  );
}

/* ------------------------------------------------------------------------------ steps */

const STEPS = [
  { clause: 'First, the plan you already have.', show: { image: true } },
  { clause: 'Then trace its walls over it.', show: { image: true, walls: true } },
  { clause: 'The rooms find themselves.', show: { walls: true, rooms: true, labels: true } },
  { clause: 'Then furnish every room.', show: { walls: true, rooms: true, items: true } },
];

function Steps() {
  return (
    <section className="steps" aria-labelledby="steps-h">
      {STEPS.map((s, i) => (
        <div key={s.clause} className={`step step-${i + 1} reveal`}>
          {i === 0 && (
            <h2 id="steps-h" className="steps-title">
              Four steps
            </h2>
          )}
          <figure className="fragment step-card" data-ui>
            <MiniPlan
              level={sample}
              geom={geom}
              box={BOX}
              show={s.show}
              extra={s.show.items ? FURNISHED : []}
              labelSize={0.42}
              title={s.clause}
            />
          </figure>
          <p className="step-clause">{s.clause}</p>
        </div>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------------------- 3D, walk */

function ThreeD() {
  return (
    <section className="three" aria-labelledby="three-h">
      <div className="three-copy reveal">
        <h2 id="three-h">Then see it in 3D.</h2>
        <p>
          Every wall, door and window you draw stands up as you draw it, with the furniture in place
          and the sun coming in at the hour you choose. Then walk through it in first person: the
          doors open as you reach them.
        </p>
      </div>
      <figure className="three-film">
        <video
          className="three-video"
          src="/welcome/orbit.mp4"
          poster="/welcome/orbit-poster.jpg"
          muted
          loop
          playsInline
          autoPlay
          width={720}
          height={594}
          aria-label="The sample flat in 3D, turning"
        />
      </figure>
      <figure className="three-still three-walk">
        <img
          src="/welcome/walk-1.webp"
          alt="Walking through the sample flat's living room, the mini-map in the corner"
          width={1062}
          height={901}
          loading="lazy"
        />
        <figcaption>Walking through, with a mini-map of where you stand.</figcaption>
      </figure>
      <figure className="three-still three-model reveal">
        <img
          src="/welcome/view-3d.webp"
          alt="The furnished sample flat in the 3D view, from above"
          width={1062}
          height={901}
          loading="lazy"
        />
        <figcaption>From above, with the furniture in.</figcaption>
      </figure>
      <figure className="three-still three-plan">
        <img
          src="/welcome/plan-furnished.webp"
          alt="The furnished plan of the sample flat"
          width={904}
          height={760}
          loading="lazy"
        />
        <figcaption>The same flat, furnished, in plan.</figcaption>
      </figure>
    </section>
  );
}

/* ------------------------------------------------------------------------------ rooms */

interface RoomRow {
  id: string;
  name: string;
  area: number;
  floor: string;
  floorColor: string;
  doors: number;
  windows: number;
  walls: number;
}

const ROWS: RoomRow[] = Object.values(sample.rooms)
  .map((r) => {
    const loop = new Set(r.loop);
    const walls = Object.values(sample.walls).filter((w) => loop.has(w.a) && loop.has(w.b));
    const wallIds = new Set(walls.map((w) => w.id));
    const ops = Object.values(sample.openings).filter((o) => wallIds.has(o.wallId));
    const f = finish(r.floorMaterial);
    return {
      id: r.id,
      name: r.name,
      area: roomArea(sample, r),
      floor: f?.name ?? 'Plain',
      floorColor: f?.color ?? '#f2efe9',
      doors: ops.filter((o) => o.kind !== 'window').length,
      windows: ops.filter((o) => o.kind === 'window').length,
      walls: walls.filter((w) => w.kind !== 'boundary').length,
    };
  })
  .sort((a, b) => b.area - a.area);

/** Whether a colour is dark enough to need light text on it. */
const dark = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function Rooms() {
  const [open, setOpen] = useState(ROWS[3]?.id ?? '');
  const total = ROWS.reduce((s, r) => s + r.area, 0);
  return (
    <section className="rooms" aria-labelledby="rooms-h">
      <div className="rooms-head reveal">
        <h2 id="rooms-h">Every room, measured.</h2>
        <p>
          The sample flat's {ROWS.length} rooms, {area(total)} in all, as the app works them out
          from the walls. Pick one.
        </p>
      </div>
      <ul className="board" data-ui>
        {ROWS.map((r) => {
          const isOpen = r.id === open;
          return (
            <li key={r.id} className={isOpen ? 'row row-open' : 'row'}>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(r.id)}>
                <span className="row-name">{r.name}</span>
                <span className="row-fact num">{area(r.area)}</span>
                <span className="row-fact">{plural(r.doors, 'door')}</span>
                <span className="row-fact">{plural(r.windows, 'window')}</span>
                <span
                  className="row-floor"
                  style={{
                    background: r.floorColor,
                    color: dark(r.floorColor) ? '#ffffff' : '#131416',
                  }}
                >
                  {r.floor}
                </span>
              </button>
              {isOpen && (
                <p className="row-detail">
                  {area(r.area)} of floor in {r.floor.toLowerCase()}, under a{' '}
                  {sample.ceilingHeight.toFixed(2)} m ceiling.
                  <br />
                  {plural(r.walls, 'wall')}, {plural(r.doors, 'door')} and{' '}
                  {plural(r.windows, 'window')}.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------------------- renovate */

const FLOORS = FLOOR_FINISHES.filter((f) =>
  ['wood-oak', 'wood-walnut', 'tile-grey', 'marble'].includes(f.id),
);
const COLOURS = PAINTS.filter((p) =>
  ['paint-white', 'paint-sage', 'paint-sky', 'paint-charcoal'].includes(p.id),
);
const BEDROOM_FURNITURE = FURNISHED.filter((it) =>
  ['it_bed', 'it_bedside', 'it_wardrobe'].includes(it.id),
);

function Renovate() {
  const [floor, setFloor] = useState('wood-oak');
  const [paint, setPaint] = useState('paint-white');
  const [furnished, setFurnished] = useState(false);
  const [knocked, setKnocked] = useState(false);
  const shapes = useMemo(() => roomShapes(sample), []);
  const floorColor = finish(floor)?.color ?? '#c49a6c';
  const paintColor = finish(paint)?.color ?? '#f2efe9';
  const fills = {
    [MAIN]: `color-mix(in srgb, ${floorColor} 45%, #ffffff)`,
    ...(knocked ? { [BED]: `color-mix(in srgb, ${floorColor} 45%, #ffffff)` } : {}),
  };
  const main = shapes.get(MAIN)?.outer ?? [];
  const bed = shapes.get(BED)?.outer ?? [];
  const rings = knocked ? [main, bed] : [main];
  const xs = [...main, ...bed].map((p) => p.x);
  const ys = [...main, ...bed].map((p) => p.y);
  const box: [number, number, number, number] = [
    Math.min(...xs) - 0.4,
    Math.min(...ys) - 0.4,
    Math.max(...xs) - Math.min(...xs) + 0.8,
    Math.max(...ys) - Math.min(...ys) + 0.8,
  ];
  const size = areaOf(sample, MAIN) + (knocked ? areaOf(sample, BED) : 0);
  return (
    <section className="renovate" aria-labelledby="renovate-h">
      <div className="renovate-output">
        <figure className="fragment renovate-card" data-ui>
          <MiniPlan
            level={sample}
            geom={geom}
            box={box}
            show={{ walls: true, rooms: true, items: furnished }}
            fills={fills}
            hacked={knocked ? [DIVIDER] : []}
            extra={furnished ? BEDROOM_FURNITURE : []}
            title="The main bedroom, as you set it"
            style={{ aspectRatio: `${box[2]} / ${box[3]}` }}
            under={
              <>
                {/* The paint: a band along the inside of the walls. */}
                <defs>
                  {rings.map((ring, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: one or two rooms, in order
                    <clipPath key={i} id={`paint-${i}`}>
                      <polygon points={ring.map((p) => `${p.x},${p.y}`).join(' ')} />
                    </clipPath>
                  ))}
                </defs>
                {rings.map((ring, i) => (
                  <polygon
                    // biome-ignore lint/suspicious/noArrayIndexKey: one or two rooms, in order
                    key={i}
                    points={ring.map((p) => `${p.x},${p.y}`).join(' ')}
                    clipPath={`url(#paint-${i})`}
                    fill="none"
                    stroke={paintColor}
                    strokeWidth={0.3}
                  />
                ))}
              </>
            }
          />

          <figcaption className="readout">
            <span>
              {knocked ? 'Main bedroom, opened up' : 'Main bedroom'} <b>{area(size)}</b>
            </span>
            <span className="readout-note">
              {finish(floor)?.name} floor, {finish(paint)?.name.toLowerCase()} walls
            </span>
          </figcaption>
        </figure>
      </div>
      <div className="renovate-copy">
        <h2 id="renovate-h">Try the renovation.</h2>
        <div className="block reveal">
          <p className="block-say">Pick the floor.</p>
          <p>Nine finishes, from oak to polished concrete, each in plan and in 3D.</p>
          <fieldset className="segmented" aria-label="Floor">
            {FLOORS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={floor === f.id}
                onClick={() => setFloor(f.id)}
              >
                {f.name}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="block reveal">
          <p className="block-say">Paint the walls.</p>
          <p>
            Each side of a wall takes its own colour, so a bedroom can be sage on one side only.
          </p>
          <fieldset className="swatches" aria-label="Wall paint">
            {COLOURS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="swatch"
                aria-pressed={paint === p.id}
                aria-label={p.name}
                style={{ background: p.color }}
                onClick={() => setPaint(p.id)}
              />
            ))}
          </fieldset>
        </div>
        <div className="block reveal">
          <p className="block-say">Furnish it.</p>
          <p>
            A queen bed, a wardrobe and a bedside table, each backed onto the wall it was dropped
            beside, at its real size.
          </p>
          <button
            type="button"
            className="toggle"
            aria-pressed={furnished}
            onClick={() => setFurnished(!furnished)}
          >
            Furnish the bedroom
          </button>
        </div>
        <div className="block reveal">
          <p className="block-say">Knock through.</p>
          <p>
            Plan the flat as it will be beside it as it is: a hacked wall shows dashed, and the room
            it opens up is measured again.
          </p>
          <fieldset className="segmented" aria-label="Renovation">
            <button type="button" aria-pressed={!knocked} onClick={() => setKnocked(false)}>
              Before
            </button>
            <button type="button" aria-pressed={knocked} onClick={() => setKnocked(true)}>
              After
            </button>
          </fieldset>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- questions */

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is it free?',
    a: 'Yes. There is nothing to pay for and no account to make. The code is open, under the MIT licence.',
  },
  {
    q: 'Can I use my HDB floor plan?',
    a: 'Yes. Upload the plan as an image or a PDF, mark one length you know to set the scale, and trace the walls over it.',
  },
  {
    q: 'Where are my plans kept?',
    a: 'Each plan is saved as you work, and this browser remembers your plans. A share link opens the same plan anywhere, to view or to edit as you choose.',
  },
  {
    q: 'Does it work on a phone?',
    a: 'Yes. Draw walls with a finger (a magnifier shows the point under it), pinch to zoom, and walk through with a thumb stick.',
  },
  {
    q: 'Can I bring my own furniture?',
    a: 'Yes. Upload a model as a .glb file and it joins the catalogue for that plan, measured and ready to place.',
  },
  {
    q: 'Can I take my plan with me?',
    a: 'Download the plan as a picture or print it, save the 3D view, export the model as a GLB, or keep the project file.',
  },
];

function Questions() {
  return (
    <section className="faq" aria-labelledby="faq-h">
      <h2 id="faq-h" className="faq-title">
        Questions
      </h2>
      <div className="faq-list reveal">
        {FAQ.map((f, i) => (
          <details key={f.q} name="faq" open={i === 0}>
            <summary>
              {f.q}
              <span className="plus" aria-hidden="true" />
            </summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------ start */

function Start() {
  const [name, setName] = useState('');
  return (
    <section className="start" aria-labelledby="start-h">
      <form
        className="start-form reveal"
        action="/"
        onSubmit={(e) => {
          e.preventDefault();
          window.location.href = `/?new=${encodeURIComponent(name.trim() || 'My flat')}`;
        }}
      >
        <h2 id="start-h" className="start-line">
          Call it{' '}
          <input
            className="start-name"
            name="new"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My flat"
            aria-label="Plan name"
            maxLength={80}
          />{' '}
          and{' '}
          <button type="submit" className="start-go">
            start.
          </button>
        </h2>
        <p className="start-note">
          A blank plan opens in the app, named as you wrote. Nothing to sign up for.
        </p>
      </form>
      <figure className="start-photo">
        <img
          src="/welcome/kovan-hdb-flats.webp"
          alt="HDB blocks in Kovan, Singapore, in the evening light"
          width={1600}
          height={1200}
          loading="lazy"
        />
      </figure>
    </section>
  );
}

/* ----------------------------------------------------------------------------- footer */

function Footer() {
  return (
    <footer className="foot">
      <p className="foot-what">A free home planner in your browser</p>
      <p className="foot-links">
        <a href="/">Open the app</a>
        <a href="/?new=">Start a blank plan</a>
      </p>
      <p className="foot-year">2026 · MIT licence</p>
      <p className="credits">
        Photograph:{' '}
        <a href="https://commons.wikimedia.org/w/index.php?curid=3495359">“Kovan HDB flats”</a> by
        Angcr, <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>, via Wikimedia
        Commons. The plan, 3D view and walk-through pictures are of this app.
      </p>
    </footer>
  );
}
