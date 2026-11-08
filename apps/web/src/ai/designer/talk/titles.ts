import { type Design, optionTitle } from '@dhd/core';
import { useDesigner } from '../state';
import { useTalk } from './useTalk';

/**
 * What a version is called wherever its number shows (Versions, Compare, a case file, the
 * cards): "V4", or "V4A" / "V4B" when it is one of a proposal's alternatives (they share the
 * proposal's number).
 */
export function versionTitle(d: Design): string {
  if (!d.from) return `V${d.n}`;
  const from = d.from;
  const p = useTalk.getState().proposals.find((x) => x.id === from.proposalId);
  const shared = useDesigner.getState().designs.some((x) => x.id !== d.id && x.n === d.n);
  return (p?.options.length ?? 1) > 1 || shared ? `V${d.n}${from.letter}` : `V${d.n}`;
}

/** An accept line's version ("V4", "V4B"), from its event. */
export function lineTitle(e: { n: number; letter: string; proposalId: string }): string {
  const p = useTalk.getState().proposals.find((x) => x.id === e.proposalId);
  return optionTitle(e.n, e.letter, p?.options.length ?? 1);
}
