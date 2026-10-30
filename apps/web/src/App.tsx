import { moveVertex, renameProject, roomArea } from '@dhd/core';
import { useEffect, useState } from 'react';
import { Viewport } from './Viewport';
import { type SyncStatus, initialProjectId, useProject, useStore } from './store';
const LEVEL = 'lvl_ground';

function syncLabel(s: SyncStatus, local: boolean): string {
  switch (s.kind) {
    case 'loading':
      return 'Loading…';
    case 'saved':
      return local ? `Saved in this browser · v${s.version}` : `Saved · v${s.version}`;
    case 'dirty':
      return 'Unsaved changes';
    case 'saving':
      return 'Saving…';
    case 'conflict':
      return `Changed elsewhere (v${s.serverVersion})`;
    case 'error':
      return 'Save failed';
  }
}

function useShortcuts() {
  const { undo, redo, save } = useStore.getState();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else if (k === 's') void save();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, save]);
}

function ProjectName() {
  const name = useProject().name;
  const dispatch = useStore((s) => s.dispatch);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== name) dispatch(renameProject(v));
    else setDraft(name);
  };
  return (
    <input
      className="name"
      aria-label="Project name"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  );
}

/**
 * Phase 0 stand-in for the plan editor: slides the Bedroom 2 / Master wall to prove
 * that edits flow store -> 3D, coalesce into one undo step, and autosave.
 */
function WallSlider() {
  const level = useProject().levels[0];
  const dispatch = useStore((s) => s.dispatch);
  const x = level?.vertices.v10?.x;
  if (x === undefined || !level?.vertices.v5) return null;
  return (
    <label className="field">
      <span>Master bedroom wall · x = {x.toFixed(2)} m</span>
      <input
        type="range"
        min={5.6}
        max={9.6}
        step={0.05}
        value={x}
        onChange={(e) => {
          const nx = Number(e.target.value);
          const opts = { coalesceKey: 'slide:master-wall' };
          dispatch(moveVertex(LEVEL, 'v10', { x: nx, y: 4.5 }), opts);
          dispatch(moveVertex(LEVEL, 'v5', { x: nx, y: 8.5 }), opts);
        }}
      />
    </label>
  );
}

function Rooms() {
  const level = useProject().levels[0];
  if (!level) return null;
  const rooms = Object.values(level.rooms);
  const total = rooms.reduce((s, r) => s + roomArea(level, r), 0);
  return (
    <section>
      <h2>Rooms</h2>
      <ul className="rooms">
        {rooms.map((r) => (
          <li key={r.id}>
            <span>{r.name}</span>
            <span className="num">{roomArea(level, r).toFixed(1)} m²</span>
          </li>
        ))}
        <li className="total">
          <span>Total</span>
          <span className="num">{total.toFixed(1)} m²</span>
        </li>
      </ul>
    </section>
  );
}

let started = false;

export function App() {
  const { load, save, undo, redo, createProject } = useStore.getState();
  const sync = useStore((s) => s.sync);
  const local = useStore((s) => s.backend?.kind === 'local');
  const projectId = useProject().id;
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  useShortcuts();
  useEffect(() => {
    // StrictMode runs effects twice in dev; only start once.
    if (started) return;
    started = true;
    const id = initialProjectId();
    void (id ? load(id) : useStore.getState().openSample());
  }, [load]);

  return (
    <div className="app">
      <header>
        <ProjectName />
        <div className="actions">
          <button type="button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl/⌘ Z)">
            Undo
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Redo (Ctrl/⌘ ⇧ Z)">
            Redo
          </button>
          <button type="button" onClick={() => void createProject()}>
            New plan
          </button>
          <button type="button" onClick={() => void save()} disabled={sync.kind === 'loading'}>
            Save
          </button>
          <button
            type="button"
            onClick={() => void load(projectId)}
            title="Discard unsaved changes and reopen the saved version"
          >
            Reload
          </button>
          <span className={`sync sync-${sync.kind}`} data-testid="sync">
            {syncLabel(sync, local)}
          </span>
        </div>
      </header>
      <aside>
        <Rooms />
        <section>
          <h2>Try an edit</h2>
          <WallSlider />
          <p className="hint">Drag, then undo. Changes save 2 s after you stop.</p>
        </section>
        {sync.kind === 'error' && <p className="banner">{sync.message}</p>}
      </aside>
      <main>
        <Viewport />
      </main>
    </div>
  );
}
