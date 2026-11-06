import type { ElecKind } from '@dhd/core';
import type { ReactNode } from 'react';

/**
 * A point's plan symbol, as electrical layouts draw them: a socket a half-circle on the wall
 * with a tick per outlet, a switch a dot with a stem (a tick per gang), a light a circle with
 * a cross, a fan an "F", data and TV a triangle, an aircon unit and a compressor a box ("AC",
 * "CU"), a water heater "WH", a cooker "C" and a doorbell a bell.
 *
 * Drawn at the origin in its own units: `r` is the symbol's radius. A wall point stands on the
 * face, the symbol out from it along `normal` (plan direction into the room); a point on the
 * plan is centred. Text stays upright whichever way the wall runs.
 */
export function ElecGlyph({
  kind,
  gang = 1,
  r,
  normal,
  stroke,
  fill,
  sw,
  textScale = 1,
}: {
  kind: ElecKind;
  gang?: number;
  r: number;
  /** Out of the face; none for a point on the plan. */
  normal?: { x: number; y: number };
  stroke: string;
  fill: string;
  sw: number;
  /** Letters larger than drawn to scale (a small icon). */
  textScale?: number;
}) {
  // Local frame: x along the wall, +y out of the face.
  const deg = normal ? (Math.atan2(normal.y, normal.x) * 180) / Math.PI - 90 : 0;
  const s = (v: number) => Number((v * r).toFixed(4));
  const P = (x: number, y: number) => `${s(x)} ${s(y)}`;
  const label = (t: string, x: number, y: number, size: number) => (
    <text
      transform={`translate(${P(x, y)}) rotate(${-deg})`}
      fontSize={s(size * textScale)}
      textAnchor="middle"
      dy="0.36em"
      fill={stroke}
      stroke="none"
      fontWeight={600}
      fontFamily="Helvetica, Arial, sans-serif"
    >
      {t}
    </text>
  );
  const line = (x1: number, y1: number, x2: number, y2: number) => (
    <path d={`M ${P(x1, y1)} L ${P(x2, y2)}`} />
  );
  let body: ReactNode;
  switch (kind) {
    case 'socket-double':
    case 'socket-single': {
      const ticks = kind === 'socket-double' ? [-0.4, 0.4] : [0];
      body = (
        <>
          <path d={`M ${P(-1, 0)} A ${s(1)} ${s(1)} 0 0 0 ${P(1, 0)} Z`} fill={fill} />
          {ticks.map((a) => (
            <path
              key={a}
              d={`M ${P(Math.sin(a), Math.cos(a))} L ${P(Math.sin(a) * 1.7, Math.cos(a) * 1.7)}`}
            />
          ))}
        </>
      );
      break;
    }
    case 'switch': {
      const end = { x: 0.95, y: 1.95 };
      const len = Math.hypot(end.x, end.y - 0.75);
      const u = { x: end.x / len, y: (end.y - 0.75) / len };
      body = (
        <>
          {line(0, 0.75, end.x, end.y)}
          {Array.from({ length: gang }, (_, i) => {
            const c = { x: end.x - u.x * i * 0.32, y: end.y - u.y * i * 0.32 };
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: one tick per gang
              <g key={i}>
                {line(c.x - u.y * 0.3, c.y + u.x * 0.3, c.x + u.y * 0.3, c.y - u.x * 0.3)}
              </g>
            );
          })}
          <circle cx={0} cy={s(0.75)} r={s(0.42)} fill={stroke} />
        </>
      );
      break;
    }
    case 'light': {
      const k = Math.SQRT1_2;
      body = (
        <>
          <circle r={s(1)} fill={fill} />
          {line(-k, -k, k, k)}
          {line(-k, k, k, -k)}
        </>
      );
      break;
    }
    case 'fan':
      body = (
        <>
          <circle r={s(1)} fill={fill} />
          {label('F', 0, 0, 1.15)}
        </>
      );
      break;
    case 'data':
    case 'tv':
      body = (
        <>
          <path d={`M ${P(-1, 0)} L ${P(1, 0)} L ${P(0, 1.75)} Z`} fill={fill} />
          {label(kind === 'tv' ? 'TV' : 'D', 0, 0.62, kind === 'tv' ? 0.62 : 0.8)}
        </>
      );
      break;
    case 'aircon':
      body = (
        <>
          <rect x={s(-2)} y={0} width={s(4)} height={s(1.15)} fill={fill} />
          {label('AC', 0, 0.58, 0.85)}
        </>
      );
      break;
    case 'compressor':
      body = (
        <>
          <rect x={s(-1.7)} y={s(-1.05)} width={s(3.4)} height={s(2.1)} fill={fill} />
          {label('CU', 0, 0, 0.95)}
        </>
      );
      break;
    case 'water-heater':
      body = (
        <>
          <circle cy={s(1.05)} r={s(1.05)} fill={fill} />
          {label('WH', 0, 1.05, 0.72)}
        </>
      );
      break;
    case 'cooker':
      body = (
        <>
          <rect x={s(-1)} y={0} width={s(2)} height={s(1.8)} fill={fill} />
          {label('C', 0, 0.9, 1.05)}
        </>
      );
      break;
    case 'doorbell':
      body = (
        <>
          <path
            d={`M ${P(-0.85, 1.5)} L ${P(-0.68, 0.85)} Q ${P(-0.62, 0.22)} ${P(0, 0.22)} Q ${P(0.62, 0.22)} ${P(0.68, 0.85)} L ${P(0.85, 1.5)} Z`}
            fill={fill}
          />
          <circle cy={s(1.78)} r={s(0.2)} fill={stroke} />
        </>
      );
      break;
  }
  return (
    <g
      transform={deg ? `rotate(${deg.toFixed(3)})` : undefined}
      stroke={stroke}
      strokeWidth={sw}
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
    >
      {body}
    </g>
  );
}

/** How far out of the face a symbol reaches, in radii: where an "h1150" label goes beyond. */
export const GLYPH_DEPTH: Record<ElecKind, number> = {
  'socket-double': 1.8,
  'socket-single': 1.8,
  switch: 2.2,
  light: 1,
  fan: 1,
  data: 1.8,
  tv: 1.8,
  aircon: 1.2,
  compressor: 1.1,
  'water-heater': 2.1,
  cooker: 1.8,
  doorbell: 2,
};
