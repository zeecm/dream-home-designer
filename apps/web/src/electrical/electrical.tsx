import {
  AFTER_SUFFIX,
  ELEC_KINDS,
  ELEC_KIND_ORDER,
  type ElecKind,
  type ElecPoint,
  type Level,
  type PointWarning,
  WARNING_TEXT,
  defaultHeight,
  deletePoint,
  pointName,
  pointPosition,
  pointRoom,
  pointWarnings,
  trunkingMetres,
  trunkingPath,
  updatePoint,
} from '@dhd/core';
import { memo, useId, useMemo } from 'react';
import { create } from 'zustand';
import { type Selection, useEditor } from '../editor';
import { useProject, useStore } from '../store';
import { LengthField, Segmented, SelectField } from '../ui/fields';
import { icons } from '../ui/icons';
import { formatLength } from '../units';
import { ElecGlyph, GLYPH_DEPTH } from './glyph';

const KEY = 'dhd-electrical';

/** Whether the plan shows electrical points (on unless switched off; remembered here). */
export const useElectricalOn = create<{ on: boolean; set: (on: boolean) => void }>((set) => {
  let on = true;
  try {
    on = window.localStorage.getItem(KEY) !== 'off';
  } catch {
    // Storage blocked: on, for this visit.
  }
  return {
    on,
    set: (v) => {
      try {
        window.localStorage.setItem(KEY, v ? 'on' : 'off');
      } catch {
        // Not remembered; still switched for this visit.
      }
      set({ on: v });
    },
  };
});

// Picking the Electrical tool shows the points.
useEditor.subscribe((s, prev) => {
  if (s.tool === 'electrical' && prev.tool !== 'electrical' && !useElectricalOn.getState().on)
    useElectricalOn.getState().set(true);
});

/** The flat as it is for a level shown: itself, or the plan's level a renovation copies. */
export function beforeOf(project: { levels: Level[] }, level: Level): Level {
  return (
    project.levels.find((l) => l.id === level.id || `${l.id}${AFTER_SUFFIX}` === level.id) ?? level
  );
}

/** Whether a point's height is its kind's usual one (then the plan shows no "h…"). */
export function atDefaultHeight(level: Level, p: ElecPoint): boolean {
  if (!p.wall) return true;
  const pos = pointPosition(level, p);
  if (!pos) return true;
  const want = defaultHeight(level, p.kind, {
    wallId: p.wall.wallId,
    along: pos.along,
    side: p.wall.side,
  });
  return Math.abs(want - p.wall.height) < 0.005;
}

/** A symbol's radius on the plan at this zoom (metres): readable zoomed out, not huge in. */
export const glyphRadius = (zoom: number) => Math.max(0.07, 9 / zoom);

const warnCache = new WeakMap<Level, Map<string, PointWarning[]>>();
/** Every point's warnings on a level (kept per level object). */
export function warningsOf(level: Level, before: Level): Map<string, PointWarning[]> {
  let out = warnCache.get(level);
  if (!out) {
    out = new Map();
    for (const p of Object.values(level.points ?? {})) {
      const w = pointWarnings(level, p, before);
      if (w.length) out.set(p.id, w);
    }
    warnCache.set(level, out);
  }
  return out;
}

/**
 * The electrical points on the plan, in metres: each symbol on its wall face (or where it
 * is on the plan), "h1150" where it isn't at its usual height, a "!" where something's
 * wrong, and an aircon unit's trunking dashed.
 */
export const ElectricalLayer = memo(function ElectricalLayer({
  level,
  before,
  zoom,
  selection,
  interactive,
}: {
  level: Level;
  before: Level;
  zoom: number;
  selection: Selection | null;
  interactive: boolean;
}) {
  const on = useElectricalOn((s) => s.on);
  const warnings = useMemo(() => warningsOf(level, before), [level, before]);
  const points = Object.values(level.points ?? {});
  if (!on || points.length === 0) return null;
  const r = glyphRadius(zoom);
  // Screen pixels: the plan's strokes don't scale with it.
  const sw = 1.3;
  return (
    <g className="electrical" data-testid="electrical-layer">
      {points.map((p) => {
        const path = trunkingPath(level, p);
        if (path.length < 2) return null;
        return (
          <polyline
            key={`t${p.id}`}
            className="elec-trunk"
            points={path.map((q) => `${q.x},${q.y}`).join(' ')}
            pointerEvents="none"
          />
        );
      })}
      {points.map((p) => {
        const pos = pointPosition(level, p);
        if (!pos) return null;
        const selected = selection?.kind === 'point' && selection.id === p.id;
        const out = pos.normal ?? { x: 0, y: 0 };
        const reach = pos.normal ? GLYPH_DEPTH[p.kind] : 0;
        // The symbol's middle, for the hit area and the selection ring.
        const mid = {
          x: pos.at.x + out.x * r * reach * 0.5,
          y: pos.at.y + out.y * r * reach * 0.5,
        };
        const tag = !atDefaultHeight(level, p) && p.wall;
        const warn = warnings.get(p.id);
        const tagAt = {
          x: pos.at.x + out.x * r * (reach + 1.1),
          y: pos.at.y + out.y * r * (reach + 1.1),
        };
        const ring = r * (p.kind === 'aircon' || p.kind === 'compressor' ? 2.4 : 1.7);
        return (
          <g
            key={p.id}
            className={`elec-point elec-${p.kind}${selected ? ' elec-selected' : ''}`}
            data-hit={`point:${p.id}`}
            data-kind={p.kind}
            pointerEvents={interactive ? undefined : 'none'}
          >
            <circle className="elec-hit" cx={mid.x} cy={mid.y} r={Math.max(ring, 14 / zoom)} />
            {selected && <circle className="elec-ring" cx={mid.x} cy={mid.y} r={ring} />}
            <g transform={`translate(${pos.at.x} ${pos.at.y})`}>
              <ElecGlyph
                kind={p.kind}
                gang={p.gang}
                r={r}
                normal={pos.normal}
                stroke="var(--wall)"
                fill="var(--surface)"
                sw={sw}
              />
            </g>
            {tag && (
              <text
                className="elec-height"
                x={tagAt.x}
                y={tagAt.y}
                fontSize={r * 1.1}
                textAnchor="middle"
                dy="0.36em"
              >
                {`h${Math.round((p.wall?.height ?? 0) * 1000)}`}
              </text>
            )}
            {warn && (
              <g
                className="elec-warn"
                data-testid="elec-warning"
                transform={`translate(${mid.x + r * 1.3} ${mid.y - r * 1.3})`}
              >
                <title>{warn.map((w) => WARNING_TEXT[w]).join(' ')}</title>
                <circle r={r * 0.62} />
                <text fontSize={r * 0.95} textAnchor="middle" dy="0.36em">
                  !
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
});

/** A kind's small icon, for the palette and lists. */
export function KindIcon({ kind, size = 28 }: { kind: ElecKind; size?: number }) {
  const plan = ELEC_KINDS[kind].place !== 'wall';
  const wide = kind === 'aircon' || kind === 'compressor';
  const r = wide ? 5 : 7;
  return (
    <svg
      className="elec-icon"
      width={size}
      height={size}
      viewBox="-12 -12 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {!plan && <line x1={-11} y1={-6} x2={11} y2={-6} className="elec-icon-wall" />}
      <g transform={plan ? undefined : 'translate(0 -6)'}>
        <ElecGlyph
          kind={kind}
          gang={kind === 'switch' ? 1 : undefined}
          r={r}
          normal={plan ? undefined : { x: 0, y: 1 }}
          stroke="currentColor"
          fill="var(--surface)"
          sw={1.3}
          textScale={1.45}
        />
      </g>
    </svg>
  );
}

/** The Electrical tool's options: which kind of point to place, in one row on a phone. */
export function KindPalette({ idPrefix }: { idPrefix: string }) {
  const picked = useEditor((s) => s.elecKind);
  const pick = useEditor.getState().setElecKind;
  const h = `${idPrefix}elec-kinds`;
  return (
    <section className="tool-options elec-kinds" aria-labelledby={h}>
      <h3 id={h} className="panel-heading">
        Point to place
      </h3>
      <ul className="choice-list elec-kind-list">
        {ELEC_KIND_ORDER.map((k) => (
          <li key={k}>
            <button type="button" aria-pressed={picked === k} onClick={() => pick(k)}>
              <KindIcon kind={k} />
              <span className="catalogue-name">{ELEC_KINDS[k].short}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** In the plan details: the Electrical view switch, and how many points there are. */
export function ElectricalSummary({ level }: { level: Level }) {
  const { on, set } = useElectricalOn();
  const project = useProject();
  const n = Object.keys(level.points ?? {}).length;
  const warnings = useMemo(() => warningsOf(level, beforeOf(project, level)), [level, project]);
  return (
    <div className="field">
      <div className="elec-summary-row">
        <label className="check-row">
          <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
          <span>Electrical</span>
        </label>
        {n > 0 && <span className="muted num">{n === 1 ? '1 point' : `${n} points`}</span>}
      </div>
      {on && warnings.size > 0 && (
        <p className="field-hint warning-text">
          {warnings.size === 1 ? '1 point needs' : `${warnings.size} points need`} a look: select
          one marked ! for why.
        </p>
      )}
    </div>
  );
}

const WALL_KINDS = ELEC_KIND_ORDER.filter((k) => ELEC_KINDS[k].place === 'wall');
const PLAN_KINDS = ELEC_KIND_ORDER.filter((k) => ELEC_KINDS[k].place !== 'wall');

/** A point's details: kind, height (mm), gang, room, warnings, trunking. */
export function PointInspector({ level, id }: { level: Level; id: string }) {
  const dispatch = useStore((s) => s.dispatch);
  const project = useProject();
  const trunking = useEditor((s) => s.trunking);
  const h = useId();
  const p = level.points?.[id];
  if (!p) return null;
  const warn = pointWarnings(level, p, beforeOf(project, level));
  const room = pointRoom(level, p);
  const pos = pointPosition(level, p);
  const usual =
    p.wall && pos
      ? defaultHeight(level, p.kind, { wallId: p.wall.wallId, along: pos.along, side: p.wall.side })
      : null;
  const set = (patch: Parameters<typeof updatePoint>[2]) => {
    try {
      dispatch(updatePoint(level.id, id, patch));
    } catch (e) {
      useStore.setState({ notice: (e as Error).message });
    }
  };
  const close = () => useEditor.getState().select(null);
  const running = trunking?.id === id;
  const startRun = () => {
    const ed = useEditor.getState();
    if (ed.tool !== 'electrical') ed.setTool('electrical');
    const key = `trunk:${id}:${Date.now()}`;
    dispatch(updatePoint(level.id, id, { route: [], compressorId: undefined }), {
      coalesceKey: key,
    });
    useEditor.getState().setTrunking({ id, key });
    useEditor.getState().select({ kind: 'point', id });
  };
  return (
    <>
      <div className="inspector-head">
        <h2 className="panel-title">{pointName(p)}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          onClick={close}
        >
          {icons.close}
        </button>
      </div>
      {warn.length > 0 && (
        <ul className="clearance-list warning-text elec-warnings" aria-label="Warnings">
          {warn.map((w) => (
            <li key={w}>{WARNING_TEXT[w]}</li>
          ))}
        </ul>
      )}
      <SelectField<ElecKind>
        label="Kind"
        value={p.kind}
        options={(p.wall ? WALL_KINDS : PLAN_KINDS)
          .filter((k) => !!p.wall || ELEC_KINDS[k].place === ELEC_KINDS[p.kind].place)
          .map((k) => ({ value: k, label: ELEC_KINDS[k].name }))}
        onChange={(kind) => {
          // A new kind takes its usual height unless this one was moved off its own.
          const keep = p.wall && !atDefaultHeight(level, p);
          const height =
            p.wall && pos && !keep
              ? defaultHeight(level, kind, {
                  wallId: p.wall.wallId,
                  along: pos.along,
                  side: p.wall.side,
                })
              : p.wall?.height;
          set({
            kind,
            ...(p.wall && height !== undefined ? { wall: { ...p.wall, height } } : {}),
            ...(kind === 'switch' ? { gang: p.gang ?? 1 } : {}),
          });
        }}
      />
      {p.wall && (
        <LengthField
          label={p.kind === 'aircon' ? 'Top above the floor' : 'Height'}
          unit="mm"
          value={p.wall.height}
          min={0}
          max={level.ceilingHeight}
          hint={usual !== null ? `Usual: ${Math.round(usual * 1000)} mm` : undefined}
          onCommit={(v) => v !== undefined && p.wall && set({ wall: { ...p.wall, height: v } })}
        />
      )}
      {p.kind === 'switch' && (
        <div className="field">
          <span className="field-label" id={`${h}-gang`}>
            Gang
          </span>
          <Segmented<string>
            label="Gang"
            value={String(p.gang ?? 1)}
            options={['1', '2', '3'].map((g) => ({ value: g, label: `${g}-gang` }))}
            onChange={(g) => set({ gang: Number(g) })}
          />
        </div>
      )}
      <dl className="point-facts">
        <dt>Room</dt>
        <dd>{room ?? 'Outside'}</dd>
        {p.kind === 'aircon' && (
          <>
            <dt>Trunking</dt>
            <dd className="num" data-testid="trunking-length">
              {formatLength(trunkingMetres(level, p), 1)}
            </dd>
          </>
        )}
      </dl>
      {p.kind === 'aircon' && !running && (
        <button type="button" className="btn" onClick={startRun}>
          {p.route?.length || p.compressorId ? 'Run the trunking again' : 'Run trunking'}
        </button>
      )}
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          dispatch(deletePoint(level.id, id, level));
          useEditor.getState().setTrunking(null);
          close();
        }}
      >
        {icons.trash}
        Delete
      </button>
    </>
  );
}
