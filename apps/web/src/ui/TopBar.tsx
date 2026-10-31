import { renameProject } from '@dhd/core';
import { useEffect, useRef, useState } from 'react';
import { signInUrl, useAccount } from '../account';
import { type ViewMode, useEditor } from '../editor';
import {
  download3dImage,
  download3dModel,
  downloadPlanImage,
  downloadProjectFile,
  printPlan,
} from '../exports';
import { type SyncStatus, useProject, useStore } from '../store';
import { HistoryDialog } from './HistoryDialog';
import { PlansDialog } from './PlansDialog';
import { ShareMenu } from './ShareMenu';
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
    case 'unreachable':
      return { text: 'Offline', tone: 'negative' };
    case 'failed':
      return { text: 'Not opened', tone: 'negative' };
  }
}

function ProjectName() {
  const name = useProject().name;
  const viewer = useStore((s) => s.role === 'viewer');
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
      readOnly={viewer}
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
  const [managing, setManaging] = useState(false);
  const [history, setHistory] = useState(false);
  // Past versions live on the server, and a view-only link doesn't see them.
  const canHistory = useStore((s) => !!s.backend?.versions && s.role !== 'viewer');
  const fileInput = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const recent = useStore((s) => s.recent);
  const currentId = useProject().id;
  const { load, createProject, openSample, importProject } = useStore.getState();
  // A download that fails says why, instead of doing nothing.
  const save = (fn: () => Promise<void>) =>
    fn().catch((e: Error) =>
      useStore.setState({ notice: `Couldn’t make that download: ${e.message}` }),
    );

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
          <button type="button" onClick={run(() => fileInput.current?.click())}>
            Open a project file…
          </button>
          <p className="menu-label">Download</p>
          <button type="button" onClick={run(() => save(downloadPlanImage))}>
            Plan as a picture (PNG)
          </button>
          <button type="button" onClick={run(() => save(printPlan))}>
            Print the plan, or save it as PDF
          </button>
          <button type="button" onClick={run(() => save(download3dImage))}>
            3D view as a picture (PNG)
          </button>
          <button type="button" onClick={run(() => save(download3dModel))}>
            3D model (GLB)
          </button>
          <button type="button" onClick={run(() => save(async () => downloadProjectFile()))}>
            Project file
          </button>
          <hr className="menu-rule" />
          {canHistory && (
            <button type="button" onClick={run(() => setHistory(true))}>
              Version history…
            </button>
          )}
          <button type="button" onClick={run(() => setManaging(true))}>
            Manage your plans…
          </button>
          <a className="menu-link" href="/welcome/">
            About Dream Home
          </a>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void f.text().then(importProject);
        }}
      />
      {managing && <PlansDialog onClose={() => setManaging(false)} />}
      {history && <HistoryDialog onClose={() => setHistory(false)} />}
    </div>
  );
}

/**
 * Sign in with Google, or who is signed in with a way out. Shown only once the server says
 * sign-in is set up.
 */
function AccountButton() {
  const enabled = useAccount((s) => s.enabled);
  const user = useAccount((s) => s.user);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  if (!enabled) return null;
  if (!user) {
    return (
      <a className="btn btn-small account-btn" href={signInUrl()} title="Sign in with Google">
        <span className="account-btn-icon">{icons.user}</span>
        <span className="account-btn-text">Sign in</span>
      </a>
    );
  }
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="icon-btn account-avatar"
        aria-label={`Signed in as ${user.email}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {(user.name || user.email).slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="menu menu-right">
          <p className="menu-label">
            Signed in as
            <br />
            <strong>{user.email}</strong>
          </p>
          <p className="menu-note">Your plans are kept with your account, on any device.</p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void useAccount.getState().signOut();
            }}
          >
            Sign out
          </button>
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
            sync.kind === 'error' || sync.kind === 'failed'
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
        <AccountButton />
        <ShareMenu />
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
