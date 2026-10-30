/** A bare number at least this big is millimetres (floor plans are dimensioned in mm). */
export const BARE_MM_FROM = 50;

/**
 * Lengths are metres internally. People type them however their plan is labelled:
 * "2.5", "2.5m", "250 cm", "2500mm", "2,500 mm", or a bare "2500" copied off a plan
 * (a bare number of 50 or more is read as millimetres; nothing in a flat is 50 m).
 */
export function parseLength(input: string): number | null {
  const m = input
    .trim()
    .toLowerCase()
    .replace(/,/g, '')
    .match(/^(-?\d*\.?\d+)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? (Math.abs(n) >= BARE_MM_FROM ? 'mm' : 'm');
  return unit === 'mm' ? n / 1000 : unit === 'cm' ? n / 100 : n;
}

/** "2.50 m"; millimetre precision is beyond what a traced plan carries. */
export function formatLength(m: number, digits = 2): string {
  return `${m.toFixed(digits)} m`;
}

export function formatArea(m2: number): string {
  return `${m2.toFixed(1)} m²`;
}
