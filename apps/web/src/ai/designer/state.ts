import {
  type Design,
  type DesignBrief,
  type DesignOptions,
  type Level,
  type Part,
  type Project,
  acceptDesign,
  levelFingerprint,
  spacesOf,
} from '@dhd/core';
import { create } from 'zustand';
import { useRates } from '../../cost/estimate';
import { useEditor } from '../../editor';
import { setLeaveGuard, useStore } from '../../store';
import { type AiSettings, aiSettings } from '../credentials';
import { sharedQuestion } from './once';
import { type ChangeRequest, changePlan, contextFor, resultFor } from './plan';
import { type DraftDesign, type RunPlan, type RunState, blankStep, runDesign } from './run';
import { addUsage, countRun, overLimit, priceTable } from './spend';
import { type DesignStore, designStore } from './storage';

/**
 * The designer as the app sees it: this plan's versions (kept in this browser), the one
 * shown, the run going on, and the panel. Runs and versions belong to the plan they were
 * started on: opening another plan stops a run (its finished steps are kept).
 */

export interface Running {
  /** The version being made; null until its layout step is done. */
  designId: string | null;
  projectId: string;
  state: RunState;
  ctrl: AbortController;
  /** The estimate's typical figure, for "US$0.61 of ~US$1.40". */
  estimate: number | null;
  /** Steps of the run that are requests. */
  /** Set while the run waits at the tab's limit: answer it to go on or stop. */
  paused: ((go: boolean) => void) | null;
  /** About how much more finishing would take. */
  remaining: number | null;
  /** Settles once the run has ended and its last step is saved. */
  ended: Promise<void>;
}

interface DesignerState {
  projectId: string | null;
  designs: Design[];
  /** Versions live only as long as this tab (no IndexedDB here). */
  memory: boolean;
  panel: boolean;
  selected: string | null;
  /** Whether the selected version is shown on the plan. */
  previewing: boolean;
  /** The card, or the Change something composer in its place. */
  mode: 'card' | 'change';
  run: Running | null;
  /** The last run, once it ended (its steps and outcome stay in the panel). */
  last: (Running & { n: number | null }) | null;
  /** A note to show under the versions (older ones removed, say). */
  note: string | null;
  briefOpen: boolean;
  /** A run is being started (a paid button was pressed): every paid button waits. */
  starting: boolean;
  /** The version whose Accept dialog is open. */
  accepting: string | null;
  /** Asking whether to stop the run and open another plan: answer it. */
  leaving: ((go: boolean) => void) | null;
}

export const useDesigner = create<DesignerState>(() => ({
  projectId: null,
  designs: [],
  memory: false,
  panel: false,
  selected: null,
  previewing: true,
  mode: 'card',
  run: null,
  last: null,
  note: null,
  briefOpen: false,
  starting: false,
  accepting: null,
  leaving: null,
}));

const newDesignId = () =>
  `dsn_${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 12)}`;

export const designOpts = (doc: Project): DesignOptions => ({
  rates: useRates.getState().rates,
  ...(doc.site ? { site: doc.site } : {}),
  ...(doc.models ? { models: doc.models } : {}),
});

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
  useDesigner.setState((st) => ({
    projectId,
    designs,
    memory: s.memory,
    selected:
      st.projectId === projectId && st.selected && designs.some((d) => d.id === st.selected)
        ? st.selected
        : (designs[designs.length - 1]?.id ?? null),
  }));
}

export const getBrief = async (projectId: string) => (await store()).getBrief(projectId);
export const putBrief = async (projectId: string, b: DesignBrief) =>
  (await store()).putBrief(projectId, b);
export const forgetProjectDesigns = async (projectId: string) =>
  (await store()).removeProject(projectId);

export function openPanel() {
  useDesigner.setState({ panel: true, mode: 'card', previewing: true });
}
export function closePanel() {
  useDesigner.setState({ panel: false, mode: 'card' });
  useEditor.getState().setPreview(null);
}
export function selectDesign(id: string) {
  useDesigner.setState({ selected: id, previewing: true, mode: 'card' });
}
/** Back to my plan: the preview ends; the version stays selected. */
export function endPreview() {
  useDesigner.setState({ previewing: false });
  useEditor.getState().setPreview(null);
}

export const stopRun = () => useDesigner.getState().run?.ctrl.abort();

/**
 * Before another plan opens: with a design running, asks whether to stop it (its finished
 * steps are kept) and open the other plan, or keep designing.
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

/** Answers the pause at the tab's limit. */
export function answerPause(go: boolean) {
  const r = useDesigner.getState().run;
  r?.paused?.(go);
}

function upsert(d: Design) {
  useDesigner.setState((st) => {
    const designs = st.designs.some((x) => x.id === d.id)
      ? st.designs.map((x) => (x.id === d.id ? d : x))
      : [...st.designs, d].sort((a, b) => a.n - b.n);
    return { designs };
  });
}

interface Begin {
  ai: AiSettings;
  brief: DesignBrief;
  plan: RunPlan;
  draft: DraftDesign;
  /** The version a change is made from. */
  parent: Design | null;
  /** Continue this stored version (Finish the design). */
  existing: Design | null;
  request: Design['request'];
  estimate: number | null;
  expected?: { key: string; label: string }[];
}

/** Starts a run; resolves when it ends. */
/**
 * Starts a run; resolves when it ends. A second press while one is starting (a double
 * click on a paid button) does nothing.
 */
let starting = false;
async function begin(b: Begin) {
  if (starting || useDesigner.getState().run) return;
  starting = true;
  useDesigner.setState({ starting: true });
  try {
    await beginRun(b, () => {
      starting = false;
      useDesigner.setState({ starting: false });
    });
  } finally {
    if (starting) {
      starting = false;
      useDesigner.setState({ starting: false });
    }
  }
}

async function beginRun(b: Begin, started: () => void) {
  const project = doc();
  const ctx = contextFor(project, b.brief, b.draft.aliases);
  if (!ctx || useDesigner.getState().run) return;
  const s = await store();
  const ctrl = new AbortController();
  const projectId = project.id;
  const startedOn = ctx.base;
  let record: Design | null = b.existing;
  const fields = (d: DraftDesign): Partial<Design> => ({
    concept: d.concept,
    spaces: d.spaces,
    usage: d.usage,
    aliases: d.aliases,
    name: d.concept?.name ?? record?.name ?? 'Design',
  });
  const newRecord = (d: DraftDesign): Omit<Design, 'n'> => ({
    id: d.id,
    projectId,
    levelId: ctx.before.id,
    name: d.concept?.name ?? 'Design',
    parent: b.parent?.id ?? null,
    createdAt: new Date().toISOString(),
    base: { variant: ctx.variant, fingerprint: levelFingerprint(startedOn) },
    baseLevel: startedOn,
    brief: b.brief,
    request: b.request,
    aliases: d.aliases,
    concept: d.concept,
    spaces: d.spaces,
    usage: d.usage,
    accepted: null,
  });
  const persist = async (d: DraftDesign) => {
    if (!record) {
      const made = await s.create(newRecord(d));
      record = made.design;
      if (made.pruned) {
        useDesigner.setState({
          note: `The oldest ${made.pruned === 1 ? 'version was' : `${made.pruned} versions were`} removed: a plan keeps ${20} at most.`,
        });
        await loadDesigns(projectId);
      }
    } else {
      record = { ...record, ...fields(d) } as Design;
      await s.put(record);
    }
    if (doc().id !== projectId) return;
    upsert(record);
    const st = useDesigner.getState();
    if (st.run && !st.run.designId) {
      useDesigner.setState({ run: { ...st.run, designId: record.id }, selected: record.id });
    }
  };
  // A change's version exists from the start (its copied rooms are a design already).
  if (!record && b.parent) await persist(b.draft);
  countRun();
  let endRun: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    endRun = resolve;
  });
  const running: Running = {
    designId: record?.id ?? null,
    projectId,
    state: {
      // The rows as planned, so the count is right from the start ("Step 1 of 5").
      steps: [
        ...(b.plan.layout ? [blankStep('layout', 'Layout and style', 'layout')] : []),
        ...(b.plan.rooms === 'all'
          ? (b.expected ?? [])
          : b.plan.rooms.map((key) => ({ key, label: b.draft.spaces[key]?.name ?? 'Room' }))
        ).map((r) => blankStep(r.key, r.label, 'room')),
      ],
      phase: 'running',
      halt: null,
      usage: [],
      startedAt: Date.now(),
      endedAt: null,
      said: 'Designing…',
    },
    ctrl,
    estimate: b.estimate,
    paused: null,
    remaining: null,
    ended,
  };
  useDesigner.setState({
    run: running,
    last: null,
    panel: true,
    mode: 'card',
    previewing: true,
    ...(record ? { selected: record.id } : {}),
  });
  started();
  const set = (patch: Partial<Running>) => {
    const r = useDesigner.getState().run;
    if (r && r.ctrl === ctrl) useDesigner.setState({ run: { ...r, ...patch } });
  };
  const { state } = await runDesign({
    ai: b.ai,
    ctx,
    design: b.draft,
    plan: b.plan,
    signal: ctrl.signal,
    prices: priceTable(),
    result: designOpts(project),
    ...(b.expected ? { expected: b.expected } : {}),
    onUpdate: (st) => set({ state: st }),
    onSave: persist,
    onUsage: addUsage,
    overLimit,
    confirmOver: () =>
      new Promise<boolean>((resolve) => {
        const spentRun =
          useDesigner.getState().run?.state.usage.reduce((t, u) => t + (u.usd ?? 0), 0) ?? 0;
        set({
          paused: (go) => {
            set({ paused: null });
            resolve(go);
          },
          remaining: b.estimate !== null ? Math.max(0, b.estimate - spentRun) : null,
        });
      }),
  });
  const r = useDesigner.getState().run;
  if (r?.ctrl === ctrl) {
    const rec = record as Design | null;
    useDesigner.setState({
      run: null,
      last: { ...r, state, n: rec?.n ?? null, designId: rec?.id ?? null, paused: null },
    });
  }
  endRun();
}

/** A whole new design from the brief. */
export function startDesign(ai: AiSettings, brief: DesignBrief, estimate: number | null) {
  const project = doc();
  const ctx = contextFor(project, brief);
  if (!ctx) return;
  void begin({
    ai,
    brief,
    plan: { layout: {}, rooms: 'all' },
    draft: { id: newDesignId(), brief, aliases: ctx.aliases, concept: null, spaces: {}, usage: [] },
    parent: null,
    existing: null,
    request: { scope: { kind: 'all' }, feedback: '', locks: [] },
    estimate,
    expected: spacesOf(ctx.base).map((s) => ({ key: s.key, label: s.name })),
  });
}

/** The steps a version still lacks: the whole design without a concept, else its rooms. */
export function finishPlan(d: Design): RunPlan | null {
  const project = doc();
  if (!d.concept) return { layout: {}, rooms: 'all' };
  const r = resultFor(project, d, designOpts(project));
  if (!r) return null;
  const missing = r.spaces
    .filter((s) => !['done', 'copied', 'locked'].includes(s.status))
    .map((s) => s.key);
  if (!missing.length) return null;
  return {
    layout: null,
    rooms: missing,
    ...(d.request.feedback ? { feedback: d.request.feedback } : {}),
    locks: d.request.locks,
  };
}

/** Runs only the steps not done (all of them, or `only`). */
export function finishDesign(d: Design, estimate: number | null, only?: string[]) {
  const ai = aiSettings();
  const plan = finishPlan(d);
  if (!ai || !plan) return;
  void begin({
    ai,
    brief: d.brief,
    plan: only ? { ...plan, rooms: only } : plan,
    draft: {
      id: d.id,
      brief: d.brief,
      aliases: d.aliases,
      concept: d.concept,
      spaces: d.spaces,
      usage: d.usage,
    },
    parent: null,
    existing: d,
    request: d.request,
    estimate,
  });
}

/** Change something: a new version from `v`. */
export function changeDesign(v: Design, req: ChangeRequest, estimate: number | null) {
  const ai = aiSettings();
  const project = doc();
  const r = resultFor(project, v, designOpts(project));
  if (!ai || !r) return;
  const made = changePlan(v, r, req, newDesignId());
  if (!made) return;
  void begin({
    ai,
    brief: v.brief,
    plan: made.plan,
    draft: made.design,
    parent: v,
    existing: null,
    request: {
      scope:
        req.scope === 'all'
          ? req.aspects.length === 4
            ? { kind: 'all' }
            : { kind: 'aspects', aspects: req.aspects }
          : { kind: 'space', space: req.scope, aspects: req.aspects },
      feedback: req.feedback.trim(),
      locks: made.locks,
    },
    estimate,
    expected: r.spaces
      .filter((s) => !(made.plan.skip ?? []).includes(s.key))
      .map((s) => ({ key: s.key, label: s.name })),
  });
}

/** Deletes a version; Undo in its toast brings it back. */
export async function deleteDesign(d: Design) {
  const s = await store();
  await s.remove(d.projectId, d.id);
  useDesigner.setState((st) => {
    const designs = st.designs.filter((x) => x.id !== d.id);
    return {
      designs,
      selected: st.selected === d.id ? (designs[designs.length - 1]?.id ?? null) : st.selected,
    };
  });
  useEditor.getState().setPreview(null);
  useStore.setState({
    toast: {
      text: `V${d.n} deleted.`,
      at: Date.now(),
      action: {
        label: 'Undo',
        run: () => {
          void s.restore(d).then((back) => {
            upsert(back);
            useDesigner.setState({ selected: back.id });
          });
        },
      },
    },
  });
}

/** Whether a version is in the renovation now: accepted, and its pieces or walls still there. */
export function acceptedNow(d: Design, after: Level | undefined): boolean {
  if (!d.accepted || !after) return false;
  const lvl = d.accepted.level;
  const items = Object.keys(lvl.items).filter((id) => !d.baseLevel.items[id]);
  if (items.length) return items.some((id) => !!after.items[id]);
  const walls = Object.keys(lvl.walls).filter((id) => !d.baseLevel.walls[id]);
  if (walls.length) return walls.some((id) => !!after.walls[id]);
  return levelFingerprint(after) === levelFingerprint(lvl);
}

/** Puts the ticked parts of `d` into the renovation: one undo step. */
export async function acceptVersion(d: Design, parts: Part[], removeHandPlaced: boolean) {
  const project = doc();
  // Worked out on After as it is now (or the flat, with no renovation).
  const r = resultFor(
    project,
    { ...d, base: { ...d.base, variant: 'after' } },
    designOpts(project),
  );
  const before = project.levels[0];
  if (!r || !before) return false;
  useEditor.getState().setPreview(null);
  useDesigner.setState({ previewing: false });
  const was = useStore.getState().editor;
  useStore.getState().dispatch(
    acceptDesign(before.id, r.level, parts, {
      base: d.baseLevel,
      removeHandPlaced,
      label: `Use design V${d.n}`,
    }),
  );
  const now = useStore.getState().editor;
  if (now === was) return false;
  useEditor.getState().setVariant('after');
  useStore.setState({ toast: { text: `Design V${d.n} is in your renovation.`, at: Date.now() } });
  const after = now.doc.renovation?.levels[0];
  if (after) {
    const next: Design = {
      ...d,
      accepted: { at: new Date().toISOString(), parts, level: structuredClone(after) },
    };
    upsert(next);
    await (await store()).put(next);
  }
  return true;
}

// Another plan: its own versions; a run on this one stops (its finished steps are kept).
useStore.subscribe((s, prev) => {
  if (s.editor.doc.id === prev.editor.doc.id) return;
  const st = useDesigner.getState();
  if (st.run && st.run.projectId !== s.editor.doc.id) st.run.ctrl.abort();
  useDesigner.setState({
    designs: [],
    selected: null,
    panel: false,
    mode: 'card',
    last: null,
    note: null,
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
