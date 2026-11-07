import type { Change, Level } from '@dhd/core';
import { create } from 'zustand';

/**
 * The card on the plan, as the plan draws it: the plan as it is (`now`), the proposal's result
 * (`target`), what Accept selected would give (`merged`, shown in the plan's place), its
 * changes and which are ticked, the pieces that fail a check, and whether it is still being
 * placed (ghosts) or checked (the diff).
 */
export interface ProposalView {
  card: string | null;
  label: string;
  now: Level | null;
  target: Level | null;
  merged: Level | null;
  changes: Change[];
  ticked: string[];
  /** Item ids a failing check is about. */
  failing: string[];
  ghost: boolean;
  /** The plan fits to these rooms once, when the card first shows. */
  rooms: string[];
}

export const EMPTY_VIEW: ProposalView = {
  card: null,
  label: '',
  now: null,
  target: null,
  merged: null,
  changes: [],
  ticked: [],
  failing: [],
  ghost: false,
  rooms: [],
};

export const useProposalView = create<ProposalView>(() => EMPTY_VIEW);
