import { AiError, PROVIDERS } from '@dhd/ai';
import { type Level, importTrace, newId, readingToPlan, roomArea, tracedLevel } from '@dhd/core';
import { useState } from 'react';
import { useEditor } from '../editor';
import { currentLevel, useProject, useStore } from '../store';
import { usePlanImage } from '../ui/PlanImage';
import { formatArea } from '../units';
import { AiSettingsDialog } from './AiSettingsDialog';
import { aiSettings, useAi } from './credentials';
import { traceWhere, useTrace } from './draft';
import { readPlan } from './trace';

/** Reads the plan image with the person's model, into a draft to look over. */
async function trace(url: string, width: number, height: number) {
  const ai = aiSettings();
  const underlay = useStore.getState().editor.doc.underlay;
  const level = currentLevel();
  if (!ai || !underlay || !level) return;
  const { set, running } = useTrace.getState();
  running?.abort();
  const ctrl = new AbortController();
  set({ running: ctrl, error: null, keyRefused: false, draft: null, at: traceWhere() });
  try {
    const reading = await readPlan(ai, url, width, height, ctrl.signal);
    const plan = readingToPlan(reading, underlay);
    if (plan.walls.length < 3) {
      throw new AiError('unreadable', 'The model found too few walls in this image to trace.');
    }
    // Read against the plan as it is now (it may have changed while the model worked).
    const now = currentLevel() ?? level;
    const replace = Object.keys(now.walls).length > 0;
    const { level: traced, skipped } = tracedLevel(now, plan, newId, replace);
    // Select, so a tool's hint and handles don't sit over the draft.
    useEditor.getState().setTool('select');
    set({
      running: null,
      draft: { level: traced, plan, skipped, printedArea: reading.printedArea ?? null, replace },
    });
  } catch (e) {
    if (e instanceof AiError && e.kind === 'cancelled') {
      set({ running: null });
      return;
    }
    set({
      running: null,
      error: e instanceof AiError ? e.message : 'Something went wrong reading the plan.',
      keyRefused: e instanceof AiError && e.kind === 'key',
    });
  }
}

/** In the plan image panel: trace the walls with the person's AI model. */
export function TraceWithAi() {
  const ai = useAi();
  const asset = usePlanImage();
  const viewer = useStore((s) => s.role === 'viewer');
  const running = useTrace((s) => !!s.running);
  // Open from the Trace button with no key: trace once a key is saved.
  const [settings, setSettings] = useState<false | true | 'then-trace'>(false);
  if (viewer) return null;
  const ready = asset.status === 'ready';
  return (
    <div className="ai-trace">
      <button
        type="button"
        className="btn btn-block"
        disabled={running || (!!ai && !ready)}
        onClick={() => {
          if (!ai) setSettings('then-trace');
          else if (asset.status === 'ready') void trace(asset.url, asset.width, asset.height);
        }}
      >
        {running ? 'Reading the plan…' : 'Trace walls with AI'}
      </button>
      <p className="field-hint">
        {ai
          ? `With ${PROVIDERS[ai.provider].name}. Set the scale first; you look it over before anything is added.`
          : 'Uses your own AI key (Claude, OpenAI or Gemini).'}{' '}
        <button type="button" className="link-btn" onClick={() => setSettings(true)}>
          {ai ? 'AI settings' : 'Add a key'}
        </button>
      </p>
      {settings && (
        <AiSettingsDialog
          onClose={() => {
            const go = settings === 'then-trace' && aiSettings();
            setSettings(false);
            if (go && asset.status === 'ready') void trace(asset.url, asset.width, asset.height);
          }}
        />
      )}
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summary(level: Level): { text: string; area: number } {
  const ops = Object.values(level.openings);
  const rooms = Object.values(level.rooms);
  const area = rooms.reduce((s, r) => s + roomArea(level, r), 0);
  const text = [
    count(Object.keys(level.walls).length, 'wall'),
    count(ops.filter((o) => o.kind === 'door').length, 'door'),
    count(ops.filter((o) => o.kind === 'window').length, 'window'),
    count(rooms.length, 'room'),
  ].join(', ');
  return { text, area };
}

/** Over the plan while a trace runs or waits: what was found, and Accept, Try again, Discard. */
export function TraceBar() {
  const { draft, running, error, keyRefused, set } = useTrace();
  const [settings, setSettings] = useState(false);
  const dispatch = useStore((s) => s.dispatch);
  const asset = usePlanImage();
  const project = useProject();
  if (!draft && !running && !error) return null;
  const again = () => {
    if (asset.status === 'ready') void trace(asset.url, asset.width, asset.height);
  };
  if (running) {
    return (
      <output className="trace-bar">
        <span>Reading the plan… this can take a minute.</span>
        <button type="button" className="btn btn-small" onClick={() => running.abort()}>
          Cancel
        </button>
      </output>
    );
  }
  if (error || !draft) {
    return (
      <div className="trace-bar trace-bar-error" role="alert">
        <span>{error}</span>
        <span className="trace-actions">
          {keyRefused ? (
            <button type="button" className="btn btn-small" onClick={() => setSettings(true)}>
              AI settings
            </button>
          ) : (
            <button type="button" className="btn btn-small" onClick={again}>
              Try again
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={() => set({ error: null })}>
            Close
          </button>
        </span>
        {settings && (
          <AiSettingsDialog
            onClose={() => {
              setSettings(false);
              if (aiSettings()) set({ error: null });
            }}
          />
        )}
      </div>
    );
  }
  const s = summary(draft.level);
  const printed =
    draft.printedArea && project.underlay
      ? ` (the plan says ${formatArea(draft.printedArea)})`
      : '';
  return (
    <output className="trace-bar">
      <span>
        <span className="trace-key" aria-hidden="true" />
        Found {s.text}: {formatArea(s.area)}
        {printed}.{draft.skipped > 0 && ` ${draft.skipped} couldn’t be placed.`}{' '}
        {draft.replace && 'Accepting replaces the walls drawn now (faded).'}
      </span>
      <span className="trace-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          onClick={() => {
            // Built again on the plan as it is now, so nothing done since is lost.
            const level = currentLevel();
            if (level && useTrace.getState().at === traceWhere()) {
              const built = tracedLevel(level, draft.plan, newId, draft.replace).level;
              dispatch(importTrace(level.id, built));
            }
            set({ draft: null });
          }}
        >
          Accept
        </button>
        <button type="button" className="btn btn-small" onClick={again}>
          Try again
        </button>
        <button type="button" className="btn btn-small" onClick={() => set({ draft: null })}>
          Discard
        </button>
      </span>
    </output>
  );
}
