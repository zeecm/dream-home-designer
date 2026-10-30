/** Plan direction words for a bearing from plan-up, clockwise, in degrees. */
export function planDirection(deg: number): string {
  const names = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8] ?? 'up';
}

/** "North is up the plan", or which way it points, for a north bearing in radians. */
export function describeNorth(north: number): string {
  const deg = Math.round((north * 180) / Math.PI) % 360;
  if (deg === 0) return 'North is up the plan';
  return `North points ${planDirection(deg)} (${deg}° from up)`;
}

/** The eight compass points, clockwise from north. */
export const COMPASS_POINTS = [
  { abbr: 'N', name: 'north' },
  { abbr: 'NE', name: 'north-east' },
  { abbr: 'E', name: 'east' },
  { abbr: 'SE', name: 'south-east' },
  { abbr: 'S', name: 'south' },
  { abbr: 'SW', name: 'south-west' },
  { abbr: 'W', name: 'west' },
  { abbr: 'NW', name: 'north-west' },
] as const;

/** The compass bearing (whole degrees) the top of the plan faces, for a north in radians. */
export function planFacing(north: number): number {
  const deg = Math.round((north * 180) / Math.PI);
  return (((360 - deg) % 360) + 360) % 360;
}

/** The north (radians) that makes the top of the plan face compass bearing `deg`. */
export function northForFacing(deg: number): number {
  return ((((360 - deg) % 360) + 360) % 360) * (Math.PI / 180);
}

/** "The top of the plan faces south-east", or "about east (100°)" between the points. */
export function describeFacing(north: number): string {
  const b = planFacing(north);
  const point = COMPASS_POINTS[Math.round(b / 45) % 8] ?? COMPASS_POINTS[0];
  return b % 45 === 0
    ? `The top of the plan faces ${point.name}`
    : `The top of the plan faces about ${point.name} (${b}°)`;
}

/** A north arrow, turned to where north is on the plan. */
export function Compass({ north, size = 32 }: { north: number; size?: number }) {
  const deg = (north * 180) / Math.PI;
  return (
    <svg className="compass" width={size} height={size} viewBox="-16 -16 32 32" aria-hidden="true">
      <circle r={15} className="compass-ring" />
      <g transform={`rotate(${deg})`}>
        <path d="M0 -3 L4.5 11 L0 8 L-4.5 11 Z" className="compass-needle" />
        {/* The letter rides at the needle's head but stays upright. */}
        <text
          y={-6.5}
          textAnchor="middle"
          dominantBaseline="central"
          className="compass-n"
          transform={`rotate(${-deg} 0 -6.5)`}
        >
          N
        </text>
      </g>
    </svg>
  );
}
