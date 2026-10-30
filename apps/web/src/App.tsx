import { useEffect, useState } from 'react';
import { Viewport } from './Viewport';
import { type Tool, type ViewMode, useEditor } from './editor';
import { absorbLinkKey } from './keys';
import { PlanCanvas } from './plan/PlanCanvas';
import { initialProjectId, useProject, useStore } from './store';
import { Inspector } from './ui/Inspector';
import { Palette, TOOLS } from './ui/Palette';
import { RenovationBar } from './ui/Renovation';
import { TopBar } from './ui/TopBar';
import { icons } from './ui/icons';

const isTyping = (t: EventTarget | null) =>
  // While a dialog is open, keys are the dialog's, not the plan's shortcuts.
  !!document.querySelector('dialog[open]') ||
  (t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)));

const VIEW_KEYS: Record<string, ViewMode> = { '1': 'plan', '2': 'split', '3': '3d' };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // the active tool already handled it
      const { undo, redo, save } = useStore.getState();
      const ed = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod) {
        if (isTyping(e.target) && k !== 's') return; // let fields keep their own undo
        if (k === 'z' && !e.shiftKey) undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
        else if (k === 's') void save();
        else return;
        e.preventDefault();
        return;
      }
      if (isTyping(e.target) || e.altKey) return;
      if (ed.walking) return; // walking has its own keys
      const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (tool) {
        if (useStore.getState().role === 'viewer') return; // view-only: Select it stays
        ed.setTool(tool.id as Tool);
      } else if (VIEW_KEYS[k]) {
        ed.setViewMode(VIEW_KEYS[k] as ViewMode);
      } else if (k === 'f') {
        ed.requestFit();
      } else if (e.key === 'Escape') {
        // A tool with work in progress handles Escape itself; otherwise clear the
        // selection, then return to Select.
        if (ed.selection) ed.select(null);
        else if (ed.tool !== 'select') ed.setTool('select');
        else return;
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    // Becoming view-only (a link's edit access was reset) drops any drawing tool.
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.role === 'viewer' && prev.role !== 'viewer') useEditor.getState().setTool('select');
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      unsubscribe();
    };
  }, []);
}

let started = false;

function Notice() {
  const notice = useStore((s) => s.notice);
  const dismiss = useStore((s) => s.dismissNotice);
  const sync = useStore((s) => s.sync);
  const resolve = useStore((s) => s.resolveConflict);
  const retry = useStore((s) => s.retry);
  if (sync.kind === 'conflict') {
    return (
      <output className="notice notice-error">
        <span>This plan was changed in another tab or device. Your latest edits aren’t saved.</span>
        <span className="button-row">
          <button type="button" className="btn btn-small" onClick={() => void resolve('theirs')}>
            Load the latest
          </button>
          <button type="button" className="btn btn-small" onClick={() => void resolve('mine')}>
            Keep mine
          </button>
        </span>
      </output>
    );
  }
  if (sync.kind === 'unreachable' || sync.kind === 'failed' || (sync.kind === 'error' && !notice)) {
    return (
      <output className="notice notice-error">
        <span>
          {sync.kind === 'unreachable'
            ? 'The server can’t be reached, so this plan can’t be opened right now. Nothing has been lost.'
            : sync.message}
        </span>
        <button type="button" className="btn btn-small" onClick={() => void retry()}>
          Try again
        </button>
      </output>
    );
  }
  const text = notice;
  if (!text) return null;
  return (
    <output className={`notice${sync.kind === 'error' && !notice ? ' notice-error' : ''}`}>
      <span>{text}</span>
      {notice && (
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
          {icons.close}
        </button>
      )}
    </output>
  );
}

/** Shown on a view-only link: what this is, and how to get a copy to change. */
function ViewOnlyBanner() {
  const role = useStore((s) => s.role);
  const { copyProject } = useStore.getState();
  if (role !== 'viewer') return null;
  return (
    <div className="sample-banner">
      <span>View only. You can look around and walk through this plan, but not change it.</span>
      <button
        type="button"
        className="btn btn-small btn-primary"
        onClick={() => void copyProject()}
      >
        Make my own copy
      </button>
    </div>
  );
}

/** Shown while the visitor is in a copy of the sample, so it's clear how to start their own. */
function SampleBanner() {
  const name = useProject().name;
  const role = useStore((s) => s.role);
  const { createProject } = useStore.getState();
  if (!name.endsWith('(sample)') || role === 'viewer') return null;
  return (
    <div className="sample-banner">
      <span>You’re exploring a sample flat. Edits are saved to your own copy.</span>
      <button
        type="button"
        className="btn btn-small btn-primary"
        onClick={() => void createProject()}
      >
        Start your own plan
      </button>
    </div>
  );
}

/**
 * While another plan opens, the one on screen is covered: edits to it would be lost, and a
 * few seconds with no sign of progress read as a dead button.
 */
function LoadingVeil() {
  const loading = useStore((s) => s.sync.kind === 'loading');
  if (!loading) return null;
  return (
    <output className="loading-veil">
      <span className="loading-dot" aria-hidden="true" />
      Opening plan…
    </output>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  const undo = useStore((s) => s.undo);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    setShown(toast.at);
    const t = setTimeout(() => setShown(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || shown !== toast.at) return null;
  return (
    <output className="toast">
      <span>{toast.text}</span>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          undo();
          setShown(null);
        }}
      >
        Undo
      </button>
    </output>
  );
}

export function App() {
  const { id: projectId, name } = useProject();
  const viewMode = useEditor((s) => s.viewMode);
  const walking = useEditor((s) => !!s.walking);
  useShortcuts();

  useEffect(() => {
    // StrictMode runs effects twice in dev; only start once.
    if (started) return;
    started = true;
    absorbLinkKey(); // an edit link's key, kept for its plan and taken out of the address
    const id = initialProjectId();
    const { load, openSample } = useStore.getState();
    void (id ? load(id) : openSample());
  }, []);

  // A different project starts with a clean editor and a fitted view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the open project changes
  useEffect(() => useEditor.getState().reset(), [projectId]);

  return (
    <div className={walking ? 'app app-walking' : 'app'}>
      <TopBar />
      <div className="workspace">
        <Palette />
        <main className={`panel stage stage-${viewMode}`}>
          <SampleBanner />
          <RenovationBar />
          <ViewOnlyBanner />
          <Notice />
          <Toast />
          <div className="stage-views">
            {viewMode !== '3d' && <PlanCanvas />}
            {viewMode !== 'plan' && <Viewport key={projectId} />}
            <LoadingVeil />
          </div>
        </main>
        <Inspector />
      </div>
      <h1 className="visually-hidden">{name} · Dream Home Designer</h1>
    </div>
  );
}
