import type { CostEstimate, CostLine } from '@dhd/core';

/** The estimate in words: totals, rows by level, notes and the text Copy and Print use. */

export const DISCLAIMER =
  'A rough guide from typical Singapore prices (2025–2026), not a quote. Prices vary with materials, contractor and site. Get itemised quotes from HDB-registered contractors.';

/** "Ground and Upper", "Ground, Upper and Roof". */
const listOf = (names: readonly string[]) =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** What the estimate covers, with two or more levels: "Covers both levels: Ground and Upper." */
export function levelsHint(est: CostEstimate): string | null {
  const names = est.levels.map((l) => l.name);
  if (names.length < 2) return null;
  const all = names.length === 2 ? 'both levels' : `all ${names.length} levels`;
  return `Covers ${all}: ${listOf(names)}.`;
}

/** Levels left out: "Upper has no renovation plan, so it isn't priced." */
export function unpricedText(est: CostEstimate): string | null {
  const n = est.unpriced;
  if (!n.length) return null;
  return n.length === 1
    ? `${n[0]} has no renovation plan, so it isn’t priced. It can’t be planned here yet.`
    : `${listOf(n)} have no renovation plan, so they aren’t priced. They can’t be planned here yet.`;
}

/** Levels priced that the app can't show (any but the one shown): they come from the file. */
export function fromFileText(est: CostEstimate, shownId: string | undefined): string | null {
  const n = est.levels.filter((l) => l.id !== shownId).map((l) => l.name);
  if (!n.length) return null;
  return n.length === 1
    ? `${n[0]} is priced from the file. It can’t be shown or edited here yet.`
    : `${listOf(n)} are priced from the file. They can’t be shown or edited here yet.`;
}

/**
 * With two or more levels, the estimate by level: each level's lines, then what is the whole
 * home's (debris, contingency); they add up to the lines' total.
 */
export function byLevel(
  est: CostEstimate,
): { id: string; name: string; low: number; high: number }[] {
  if (est.levels.length < 2) return [];
  const home = est.lines.filter((l) => !l.levelId);
  const rows = est.levels.map((l) => ({ id: l.id, name: l.name, low: l.low, high: l.high }));
  if (home.length) {
    const what = [
      home.some((l) => l.label === 'Debris disposal') && 'debris',
      home.some((l) => l.group === 'Contingency') && 'contingency',
    ].filter(Boolean);
    rows.push({
      // No level has it: level ids are never blank.
      id: '',
      name: `Whole home (${what.join(', ')})`,
      low: home.reduce((t, l) => t + l.low, 0),
      high: home.reduce((t, l) => t + l.high, 0),
    });
  }
  return rows;
}

export const money = (v: number) => `$${Math.round(v).toLocaleString('en-SG')}`;
export const range = (low: number, high: number) =>
  low === high ? money(low) : `${money(low)}–${money(high).slice(1)}`;

export const qtyText = (l: CostLine) =>
  l.unit === 'lot'
    ? ''
    : l.unit === 'each'
      ? `${l.qty}`
      : // Trunking is measured to 10 cm, so it reads to one place.
        `${l.unit === 'ft run' ? l.qty : l.qty.toFixed(l.unit === 'm' && l.group !== 'Electrical' ? 2 : 1)} ${l.unit}`;

/**
 * The estimate as plain text: lines, the levels' subtotals (with two or more), total and
 * disclaimer (for Copy and Print).
 */
export function estimateText(est: CostEstimate, name: string): string {
  const rows = est.lines.map((l) =>
    [l.label, l.place, qtyText(l), range(l.low, l.high)].filter(Boolean).join(' · '),
  );
  const levels = byLevel(est);
  const unpriced = unpricedText(est);
  return [
    `Cost estimate: ${name} (${new Date().toLocaleDateString('en-SG')})`,
    '',
    ...rows,
    '',
    ...(levels.length
      ? ['By level', ...levels.map((r) => `${r.name}: ${range(r.low, r.high)}`), '']
      : []),
    `Total: about ${range(est.low, est.high)}`,
    ...(unpriced ? [unpriced] : []),
    '',
    DISCLAIMER,
  ].join('\n');
}
