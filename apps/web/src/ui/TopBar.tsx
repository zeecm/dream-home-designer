import { renameProject } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { type ViewMode, useEditor } from '../editor';
import { type SyncStatus, useProject, useStore } from '../store';
import { Segmented } from './fields';
import { Mark, icons } from './icons';

function syncText(s: SyncStatus, local: boolean): { text: string; tone: 'neutral' | 'negative' } {
  switch (s.kind) {
    case 'loading':
      return { text: 'Opening…', tone: 'neutral' };
    case 'saved':
      return { text: local ? 'Saved in this browser' : 'Saved', tone: 'neutral' };
    case 'dirty':
      return { text: 'Unsaved changes', tone: 'neutral' };
    case 'saving':
      return { text: 'Saving…', tone: 'neutral' };
    case 'conflict':
      return { text: `Changed elsewhere (v${s.serverVersion})`, tone: 'negative' };
    case 'error':
      return { text: 'Not saved', tone: 'negative' };
  }
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
      className="project-name"
      aria-label="Project name"
      value={draft}
      size={Math.max(8, Math.min(40, draft.length + 1))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(name);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const recent = useStore((s) => s.recent);
  const currentId = useProject().id;
  const { load, createProject, openSample } = useStore.getState();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  const run = (fn: () => unknown) => () => {
    setOpen(false);
    void fn();
  };
  const others = recent.filter((r) => r.id !== currentId).slice(0, 8);

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="brand"
        aria-label="Projects"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Mark />
        <span className="brand-name">Dream Home</span>
        {icons.chevronDown}
      </button>
      {open && (
        <div className="menu">
          <button type="button" onClick={run(() => createProject())}>
            New blank plan
          </button>
          <button type="button" onClick={run(openSample)}>
            New copy of the sample flat
          </button>
          {others.length > 0 && (
            <>
              <p className="menu-label">Recent plans</p>
              {others.map((r) => (
                <button key={r.id} type="button" onClick={run(() => load(r.id))}>
                  {r.name}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const sync = useStore((s) => s.sync);
  const local = useStore((s) => s.backend?.kind === 'local');
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const { undo, redo } = useStore.getState();
  const viewMode = useEditor((s) => s.viewMode);
  const setViewMode = useEditor((s) => s.setViewMode);
  const status = syncText(sync, local);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <ProjectMenu />
        <span className="topbar-divider" aria-hidden="true" />
        <ProjectName />
        <span
          className={`pill pill-${status.tone}`}
          data-testid="sync"
          data-version={sync.kind === 'saved' ? sync.version : undefined}
          title={
            sync.kind === 'error'
              ? sync.message
              : sync.kind === 'saved'
                ? `Version ${sync.version}${local ? ', stored in this browser' : ', stored on the server'}`
                : undefined
          }
        >
          {status.text}
        </span>
      </div>
      <div className="topbar-right">
        <button
          type="button"
          className="icon-btn"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Ctrl/⌘ Z)"
        >
          {icons.undo}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Ctrl/⌘ ⇧ Z)"
        >
          {icons.redo}
        </button>
        <span className="topbar-divider" aria-hidden="true" />
        <Segmented<ViewMode>
          label="View"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: 'plan', label: 'Plan', title: 'Plan only (1)' },
            { value: 'split', label: 'Split', title: 'Plan and 3D (2)' },
            { value: '3d', label: '3D', title: '3D only (3)' },
          ]}
        />
      </div>
    </header>
  );
}
