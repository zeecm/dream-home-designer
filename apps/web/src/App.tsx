import { useEffect } from 'react';
import { Viewport } from './Viewport';
import { type Tool, type ViewMode, useEditor } from './editor';
import { PlanCanvas } from './plan/PlanCanvas';
import { initialProjectId, useProject, useStore } from './store';
import { Inspector } from './ui/Inspector';
import { Palette, TOOLS } from './ui/Palette';
import { TopBar } from './ui/TopBar';
import { icons } from './ui/icons';

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

const VIEW_KEYS: Record<string, ViewMode> = { '1': 'plan', '2': 'split', '3': '3d' };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (tool) {
        ed.setTool(tool.id as Tool);
      } else if (VIEW_KEYS[k]) {
        ed.setViewMode(VIEW_KEYS[k] as ViewMode);
      } else if (k === 'f') {
        ed.requestFit();
      } else if (e.key === 'Escape') {
        // Tools handle their own Escape first (the canvas listener runs before this one
        // only when a tool claims it); otherwise clear the selection, then the tool.
        if (ed.selection) ed.select(null);
        else if (ed.tool !== 'select') ed.setTool('select');
        else return;
      } else {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

let started = false;

function Notice() {
  const notice = useStore((s) => s.notice);
  const dismiss = useStore((s) => s.dismissNotice);
  const sync = useStore((s) => s.sync);
  const text = notice ?? (sync.kind === 'error' ? sync.message : null);
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

export function App() {
  const { id: projectId, name } = useProject();
  const viewMode = useEditor((s) => s.viewMode);
  useShortcuts();

  useEffect(() => {
    // StrictMode runs effects twice in dev; only start once.
    if (started) return;
    started = true;
    const id = initialProjectId();
    const { load, openSample } = useStore.getState();
    void (id ? load(id) : openSample());
  }, []);

  // A different project starts with a clean editor and a fitted view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the open project changes
  useEffect(() => useEditor.getState().reset(), [projectId]);

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <Palette />
        <main className={`panel stage stage-${viewMode}`}>
          <Notice />
          <div className="stage-views">
            {viewMode !== '3d' && <PlanCanvas />}
            {viewMode !== 'plan' && <Viewport key={projectId} />}
          </div>
        </main>
        <Inspector />
      </div>
      <h1 className="visually-hidden">{name} · Dream Home Designer</h1>
    </div>
  );
}
