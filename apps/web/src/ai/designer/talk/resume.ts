import { designerCannotUse } from '@dhd/ai';
import { type Proposal, RESUME_MS, levelFingerprint } from '@dhd/core';
import { MODEL_NAMES, aiSettings } from '../../credentials';
import { wouldPass } from '../spend';
import { useDesigner } from '../state';
import { cardKey } from './cards';
import { approvedLeft, resumeFigure } from './pricing';
import { carryOn, endStopped, keepAsItIs, resumePriced, roomsDone, runHooks } from './propose';
import { type RunHold, takeRunLock } from './runLock';
import { type ResumeView, loadTalk, say, talkLevels, useTalk } from './useTalk';

/**
 * Carrying on a design run the page lost (docs/specs/locked-phone-runs.md, part 1). A running
 * option with a checkpoint and no live run here is either running in another tab (its Web
 * Lock is held: "Designing in another tab", and this tab queues for the lock) or interrupted.
 * The tab that takes its lock carries it on by itself when it is back within 10 minutes of the
 * run's last progress, the plan is as it was, the model is the same and what is left still
 * fits under the figure it was approved for and the tab's limit; otherwise its card asks once:
 * Carry on (priced) or Keep as it is. Checked when the conversation opens or changes, when the
 * page comes back into view or online, and when a run here was away too long.
 */

/** Runs being looked at, or held here while their card asks. */
const deciding = new Set<string>();
const holds = new Map<string, RunHold>();
/** Queued for another tab's lock. */
const waiting = new Map<string, AbortController>();

const setView = (key: string, v: ResumeView | null) =>
  useTalk.setState((s) => {
    const resume = { ...s.resume };
    if (v) resume[key] = v;
    else delete resume[key];
    return { resume };
  });

const findOption = (proposalId: string, letter: string) => {
  const p = useTalk.getState().proposals.find((x) => x.id === proposalId);
  const o = p?.options.find((x) => x.letter === letter);
  return p && o ? { p, o } : null;
};

const modelName = (id: string) => MODEL_NAMES[id] ?? id;

/** Looks for runs to carry on, or to show as running elsewhere. */
export function checkResume() {
  const st = useTalk.getState();
  // No conversation read (yet, or one a newer build wrote): nothing here is this tab's to carry on.
  if (!st.projectId || st.newer || !st.conv || !useDesigner.getState().panel) return;
  for (const p of st.proposals) {
    for (const o of p.options) {
      if (o.status !== 'running' || !o.run) continue;
      const key = cardKey(p, o.letter);
      if (st.live && st.live.proposalId === p.id && st.live.letter === o.letter) continue;
      if (deciding.has(key) || holds.has(key) || waiting.has(key)) continue;
      deciding.add(key);
      void decide(st.projectId, p.id, o.letter, o.run.id, key).finally(() => deciding.delete(key));
    }
  }
}

async function decide(
  projectId: string,
  proposalId: string,
  letter: string,
  runId: string,
  key: string,
) {
  let hold = await takeRunLock(runId);
  if (!hold) {
    // Its tab is alive: it shows the run; this one waits its turn, sending nothing.
    setView(key, { kind: 'other-tab' });
    const ctrl = new AbortController();
    waiting.set(key, ctrl);
    hold = await takeRunLock(runId, true, ctrl.signal);
    waiting.delete(key);
    if (!hold) return;
  }
  // As the record says now that the lock is ours (the other tab's run may have ended, or a
  // Stop been written, since the record shown here was read).
  await loadTalk(projectId, true);
  const found = findOption(proposalId, letter);
  if (
    useTalk.getState().projectId !== projectId ||
    !found ||
    found.o.status !== 'running' ||
    found.o.run?.id !== runId
  ) {
    hold.release();
    setView(key, null);
    return;
  }
  // Stopped by the person (Stop, or another plan opened) before its end was written: ended
  // so, never carried on and never asked about.
  if (found.o.run.stopped) {
    await endStopped(found.p, letter);
    hold.release();
    setView(key, null);
    return;
  }
  holds.set(key, hold);
  await offer(key, found.p, letter);
}

/** Carries it on by itself if it may, or asks (the hold stays here while it asks). */
async function offer(key: string, p: Proposal, letter: string) {
  const o = p.options.find((x) => x.letter === letter);
  const run = o?.run;
  const hold = holds.get(key);
  if (!o || !run || !hold) return;
  const d = roomsDone(o, run);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setView(key, { kind: 'offline', ...d });
    return; // asked again when the page is online (checkResume → recheck)
  }
  const ai = aiSettings();
  const usable = !!ai && !designerCannotUse(ai);
  const made = usable ? await resumePriced(p, letter) : null;
  const figure = made ? resumeFigure(made.est, run.fixesLeft) : null;
  const levels = talkLevels();
  const base = o.base.variant === 'after' ? levels?.after : levels?.before;
  const changed = !base || levelFingerprint(base) !== o.base.fingerprint;
  const recent = Date.now() - Date.parse(run.at) <= RESUME_MS;
  const sameModel = !!ai && ai.provider === run.provider && ai.model === run.model;
  // What it may still spend: the steps that were in flight count at their most.
  const may = approvedLeft(run);
  const fits = figure !== null && (may === null || figure <= may + 0.005) && !wouldPass(figure);
  if (made && recent && !changed && sameModel && fits && !run.paused) {
    setView(key, { kind: 'carrying-on' });
    const r = await carryOn(p, letter, hold, null);
    if (r === 'started') {
      holds.delete(key);
      setView(key, null);
      return;
    }
  }
  setView(key, {
    kind: 'ask',
    changed,
    figure,
    pending: false,
    ...d,
    model: ai && !sameModel ? { now: modelName(ai.model), was: modelName(run.model) } : null,
    noKey: !usable,
    why: run.paused ?? 'closed',
  });
}

/** Carry on, from its card: priced as its button shows it, or asked again if dearer now. */
export async function pressCarryOn(key: string) {
  const v = useTalk.getState().resume[key];
  const hold = holds.get(key);
  if (v?.kind !== 'ask' || !hold) return;
  if (v.noKey) {
    useTalk.setState({ settings: 'key' });
    return;
  }
  const [proposalId, letter] = key.split(':') as [string, string];
  const found = findOption(proposalId, letter);
  if (!found) return;
  setView(key, { ...v, pending: true });
  const r = await carryOn(found.p, letter, hold, { shown: v.figure });
  if (r === 'started') {
    holds.delete(key);
    setView(key, null);
    return;
  }
  if (r === 'dearer') say('The price has gone up since; check it again before going ahead.');
  // Priced again, and asked again.
  await offer(key, found.p, letter);
}

/** Keep as it is, from its card: stopped, with what it finished. */
export async function pressKeep(key: string) {
  const v = useTalk.getState().resume[key];
  const hold = holds.get(key);
  if (v?.kind !== 'ask' || !hold) return;
  const [proposalId, letter] = key.split(':') as [string, string];
  const found = findOption(proposalId, letter);
  if (found) await keepAsItIs(found.p, letter);
  holds.delete(key);
  hold.release();
  setView(key, null);
}

/** Lets go of every run held or queued for (another plan opened). */
function letGo() {
  for (const h of holds.values()) h.release();
  holds.clear();
  for (const c of waiting.values()) c.abort();
  waiting.clear();
}

let queued = false;
const recheck = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    // An offline card asks again once online; the rest are left as they are.
    for (const [key, v] of Object.entries(useTalk.getState().resume)) {
      if (v.kind !== 'offline' || !holds.has(key)) continue;
      const [proposalId, letter] = key.split(':') as [string, string];
      const found = findOption(proposalId, letter);
      if (found) void offer(key, found.p, letter);
    }
    checkResume();
  });
};

runHooks.interrupted = recheck;
useTalk.subscribe((s, prev) => {
  if (s.projectId !== prev.projectId) letGo();
  if (s.proposals !== prev.proposals || s.live !== prev.live || s.projectId !== prev.projectId)
    recheck();
});
useDesigner.subscribe((s, prev) => {
  if (s.panel && !prev.panel) recheck();
});
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') recheck();
  });
  window.addEventListener('online', recheck);
}
