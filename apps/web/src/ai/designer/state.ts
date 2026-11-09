import type { RunState } from '@dhd/ai';
import {
  type Design,
  type DesignBrief,
  type DesignOptions,
  type Kept,
  type Project,
  type Rule,
  keptBefore,
} from '@dhd/core';
import { create } from 'zustand';
import { useRates } from '../../cost/estimate';
import { useEditor } from '../../editor';
import { meterSetting } from '../../storage/store';
import { setLeaveGuard, useStore } from '../../store';
import { defaultPicks } from './compare';
import { sharedQuestion } from './once';
import { type DesignStore, designStore } from './storage';

/**
 * The designer as the app sees it: whether its panel is open, this plan's versions (kept in
 * this browser; since slice 2 only an accepted proposal makes one), the design run going on
 * (the conversation starts it), Compare, and the question before another plan opens mid-run.
 * Runs belong to the plan they were started on: opening another plan stops one (its finished
 * rooms are kept).
 */

export interface Running {
  /** The proposal option's design being made. */
  designId: string | null;
  projectId: string;
  state: RunState;
  ctrl: AbortController;
  /** The estimate's typical figure. */
  estimate: number | null;
  paused: ((go: boolean) => void) | null;
  remaining: number | null;
  /** Settles once the run has ended and its last room is saved. */
  ended: Promise<void>;
  again: () => void;
}

interface DesignerState {
  projectId: string | null;
  designs: Design[];
  /** Versions live only as long as this tab (no IndexedDB here). */
  memory: boolean;
  panel: boolean;
  /** Whether the card on show is drawn on the plan. */
  previewing: boolean;
  run: Running | null;
  /** A run is being started (a priced button was pressed): every priced button waits. */
  starting: boolean;
  /** Asking whether to stop the run and open another plan: answer it. */
  leaving: ((go: boolean) => void) | null;
  /** Compare is open over the stage: the versions picked beside Before, in the order ticked. */
  comparing: string[] | null;
  /** A side the preview is to show, once (Compare's columns): the preview obeys it, then clears it. */
  wantSide: 'before' | 'version' | null;
  /** The version Compare chose to show on the plan. */
  selected: string | null;
}

export const useDesigner = create<DesignerState>(() => ({
  projectId: null,
  designs: [],
  memory: false,
  panel: false,
  previewing: true,
  run: null,
  starting: false,
  leaving: null,
  comparing: null,
  wantSide: null,
  selected: null,
}));

/** The household's house rules for a level (the conversation sets where they come from). */
let houseRules: (levelId: string) => readonly Rule[] = () => [];
export const setHouseRules = (f: (levelId: string) => readonly Rule[]) => {
  houseRules = f;
};
export const houseRulesFor = (levelId: string): readonly Rule[] => houseRules(levelId);
/** The pieces kept where they are on a level (Keep this), from the conversation. */
let houseKept: (levelId: string) => readonly Kept[] = () => [];
export const setHouseKept = (f: (levelId: string) => readonly Kept[]) => {
  houseKept = f;
};
/**
 * What a version was made with, for its kept pieces: the set on its record (read as it was,
 * whatever is kept, let go or started over since), else its time (an older record: worked out
 * with keptBefore), or 'new' for a design not made yet (those kept now).
 */
export type MadeWith = string | 'new' | { kept: readonly Kept[] };
/** The kept pieces a version is placed and checked with. */
export const houseKeptFor = (levelId: string, made: MadeWith): readonly Kept[] =>
  typeof made === 'object' ? made.kept : keptBefore(houseKept(levelId), made);

/**
 * What a version is placed and checked with: the rates, the site, the plan's own models and,
 * on `levelId`, the household's house rules (slice 3a: in the result's key, so a rule kept,
 * changed or deleted re-checks every card with no request), and the pieces kept before
 * `made`: what the version was made with (`madeWith`), or 'new' for a design not made yet.
 */
export const designOpts = (
  doc: Project,
  levelId: string | undefined,
  made: MadeWith,
): DesignOptions => {
  const rules = levelId ? houseRules(levelId) : [];
  const kept = levelId ? houseKeptFor(levelId, made) : [];
  return {
    rates: useRates.getState().rates,
    ...(doc.site ? { site: doc.site } : {}),
    ...(doc.models ? { models: doc.models } : {}),
    ...(rules.length ? { rules: [...rules] } : {}),
    ...(kept.length ? { kept: [...kept] } : {}),
    // The storage meter's own setting: its household wins when the person set it there (the
    // storage lens, tech 3b §4.1). Part of the result key, so editing it re-scores the cards.
    storage: meterSetting(doc.id),
  };
};

const doc = () => useStore.getState().editor.doc;
let storeP: Promise<DesignStore> | null = null;
const store = () => {
  storeP ??= designStore();
  return storeP;
};

/** Loads (or reloads) the open plan's versions. */
export async function loadDesigns(projectId = doc().id) {
  const s = await store();
  const designs = await s.list(projectId);
  if (doc().id !== projectId) return;
  useDesigner.setState({ projectId, designs, memory: s.memory });
}

export const getBrief = async (projectId: string) => (await store()).getBrief(projectId);
export const putBrief = async (projectId: string, b: DesignBrief) =>
  (await store()).putBrief(projectId, b);

/** Opens the designer; `preview: false` leaves the plan as it is (Ask the designer on your plan). */
export function openPanel({ preview = true }: { preview?: boolean } = {}) {
  useDesigner.setState({ panel: true, previewing: preview });
}
export function closePanel() {
  useDesigner.setState({ panel: false, comparing: null });
  useEditor.getState().setPreview(null);
}
/** Compare: Before and two versions (`id` and the one before it) over the stage. */
export function openCompare(id: string) {
  const st = useDesigner.getState();
  useDesigner.setState({ comparing: defaultPicks(st.designs, id) });
}
export const closeCompare = () => useDesigner.setState({ comparing: null });

/** From Compare: the plan shows this version (or, with null, the flat as it is). */
export function previewFrom(id: string | null) {
  const target = id ?? useDesigner.getState().selected;
  useDesigner.setState({
    comparing: null,
    previewing: true,
    selected: target,
    wantSide: id ? 'version' : 'before',
  });
}

/** Back to my plan: the preview ends; the card stays where it is. */
export function endPreview() {
  useDesigner.setState({ previewing: false });
  useEditor.getState().setPreview(null);
}

/**
 * Before another plan opens: with a design running, asks whether to stop it (its finished
 * rooms are kept) and open the other plan, or keep designing.
 */
const leaveQuestion = sharedQuestion(
  () =>
    new Promise<boolean>((resolve) => {
      useDesigner.setState({
        leaving: (go) => {
          useDesigner.setState({ leaving: null });
          const run = useDesigner.getState().run;
          if (!go) return resolve(false);
          if (!run) return resolve(true);
          run.ctrl.abort();
          // Once the run has ended and saved what it finished.
          void run.ended.then(() => resolve(true));
        },
      });
    }),
);
export function askToLeave(): Promise<boolean> {
  if (!useDesigner.getState().run) return Promise.resolve(true);
  // Asked already (a second way of opening a plan): the same question, the same answer.
  return leaveQuestion();
}
setLeaveGuard(askToLeave);

// Another plan: its own versions; a run on this one stops (its finished rooms are kept).
useStore.subscribe((s, prev) => {
  if (s.editor.doc.id === prev.editor.doc.id) return;
  const st = useDesigner.getState();
  if (st.run && st.run.projectId !== s.editor.doc.id) st.run.ctrl.abort();
  useDesigner.setState({
    designs: [],
    panel: false,
    comparing: null,
    selected: null,
    projectId: null,
  });
  if (s.role !== 'viewer') void loadDesigns(s.editor.doc.id);
});

// Two tabs on one plan: the list is read again when this one comes back into focus.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    if (useDesigner.getState().projectId && !useDesigner.getState().run) void loadDesigns();
  });
}
