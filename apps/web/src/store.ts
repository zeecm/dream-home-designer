import {
  type Command,
  type DispatchOptions,
  type EditorDoc,
  type Project,
  blankProject,
  canRedo,
  canUndo,
  dispatch as coreDispatch,
  redo as coreRedo,
  undo as coreUndo,
  emptyHistory,
  hdb4RoomProject,
  newId,
} from '@dhd/core';
import { create } from 'zustand';
import {
  type Backend,
  ConflictError,
  NotFoundError,
  apiAvailable,
  localBackend,
  remoteBackend,
} from './backend';
import { type RecentProject, forgetRecent, recentProjects, rememberRecent } from './recent';

export type SyncStatus =
  | { kind: 'loading' }
  | { kind: 'saved'; version: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict'; serverVersion: number }
  | { kind: 'error'; message: string };

interface State {
  backend: Backend | null;
  editor: EditorDoc;
  sync: SyncStatus;
  canUndo: boolean;
  canRedo: boolean;
  recent: RecentProject[];
  /** A one-off message for the user, e.g. why a different project opened. */
  notice: string | null;
  dismissNotice: () => void;
  /** A short confirmation after a destructive edit, offering Undo. */
  toast: { text: string; at: number } | null;
  /** Resolves a save conflict: reload the server's version, or overwrite it with ours. */
  resolveConflict: (keep: 'theirs' | 'mine') => Promise<void>;
  dispatch: (cmd: Command, opts?: DispatchOptions) => void;
  undo: () => void;
  redo: () => void;
  load: (id: string) => Promise<void>;
  /** Creates a blank project, stores it and opens it. */
  createProject: (name?: string) => Promise<void>;
  /** Opens a fresh copy of the reference plan, so every visitor edits their own. */
  openSample: () => Promise<void>;
  save: () => Promise<void>;
}

const AUTOSAVE_MS = 2000;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let backendPromise: Promise<Backend> | undefined;

const localNotice =
  'The server can’t be reached right now, so this plan is saved in this browser only.';

/** Probes the API once; without one, projects live in this browser. */
function resolveBackend(): Promise<Backend> {
  // A sleeping API container takes a few seconds to wake, so be patient here.
  backendPromise ??= apiAvailable(20_000).then((ok) => (ok ? remoteBackend : localBackend()));
  return backendPromise;
}

/** Puts the open project in the URL (?p=id) so reloads and links reopen it. */
function rememberProject(id: string) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('p') !== id) {
    url.searchParams.set('p', id);
    window.history.replaceState(null, '', url);
  }
  try {
    window.localStorage.setItem('dhd:last', id);
  } catch {
    // Storage can be disabled; the URL still works.
  }
}

/** The project to open on startup, or null to start from a copy of the sample. */
export function initialProjectId(): string | null {
  const fromUrl = new URL(window.location.href).searchParams.get('p');
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem('dhd:last');
  } catch {
    return null;
  }
}

const errorMessage = (prefix: string, e: unknown) => `${prefix}: ${(e as Error).message}`;

/** The API's id rule; anything else can't be a project of ours. */
const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Commands that remove things get an Undo toast. */
const DESTRUCTIVE = /^Delete /;

export const useStore = create<State>((set, get) => {
  const commit = (editor: EditorDoc) => {
    set({ editor, canUndo: canUndo(editor), canRedo: canRedo(editor) });
    if (get().sync.kind === 'conflict') return;
    set({ sync: { kind: 'dirty' } });
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void get().save(), AUTOSAVE_MS);
  };

  const open = (doc: Project) => {
    set({
      editor: { doc, history: emptyHistory() },
      sync: { kind: 'saved', version: doc.version },
      canUndo: false,
      canRedo: false,
      recent: rememberRecent(doc),
    });
    rememberProject(doc.id);
  };

  /** Saves pending edits before switching away from the open project. */
  const flush = async () => {
    clearTimeout(autosaveTimer);
    if (get().sync.kind === 'dirty') await get().save();
  };

  const createFrom = async (doc: Project) => {
    await flush();
    set({ sync: { kind: 'loading' } });
    try {
      const backend = await resolveBackend();
      set({ backend });
      if (backend.kind === 'local' && !get().notice) set({ notice: localNotice });
      open(await backend.create(doc));
    } catch (e) {
      set({ sync: { kind: 'error', message: errorMessage('Could not create a project', e) } });
    }
  };

  return {
    backend: null,
    editor: { doc: hdb4RoomProject(), history: emptyHistory() },
    sync: { kind: 'loading' },
    canUndo: false,
    canRedo: false,
    recent: recentProjects(),
    notice: null,
    dismissNotice: () => set({ notice: null }),
    toast: null,

    dispatch: (cmd, opts) => {
      const next = coreDispatch(get().editor, cmd, opts);
      if (next === get().editor) return;
      commit(next);
      if (DESTRUCTIVE.test(cmd.label)) {
        const what = cmd.label.replace('Delete ', '');
        set({
          toast: { text: `${what[0]?.toUpperCase()}${what.slice(1)} deleted`, at: Date.now() },
        });
      }
    },

    resolveConflict: async (keep) => {
      const { backend, editor } = get();
      if (!backend) return;
      if (keep === 'theirs') return get().load(editor.doc.id);
      try {
        const server = await backend.get(editor.doc.id);
        // Re-base our document on the server's version, then save over it.
        set({
          editor: { ...editor, doc: { ...editor.doc, version: server.version } },
          sync: { kind: 'dirty' },
        });
        await get().save();
      } catch (e) {
        set({ sync: { kind: 'error', message: errorMessage('Could not save', e) } });
      }
    },
    undo: () => {
      const next = coreUndo(get().editor);
      if (next !== get().editor) commit(next);
    },
    redo: () => {
      const next = coreRedo(get().editor);
      if (next !== get().editor) commit(next);
    },

    load: async (id) => {
      if (!VALID_ID.test(id)) {
        set({
          notice:
            'That link doesn’t point to a plan, so a fresh copy of the sample opened instead.',
        });
        return get().openSample();
      }
      if (get().editor.doc.id !== id) await flush();
      clearTimeout(autosaveTimer);
      set({ sync: { kind: 'loading' } });
      try {
        const backend = await resolveBackend();
        set({ backend });
        if (backend.kind === 'local' && !get().notice) {
          set({ notice: localNotice });
        }
        open(await backend.get(id));
      } catch (e) {
        if (e instanceof NotFoundError) {
          // A stale link, or a project saved in another browser.
          set({
            recent: forgetRecent(id),
            notice: 'That project isn’t saved here, so a fresh copy of the sample opened instead.',
          });
          return get().openSample();
        }
        set({ sync: { kind: 'error', message: errorMessage('Could not open the project', e) } });
      }
    },

    createProject: async (name) => {
      await createFrom(blankProject(name));
      // A blank plan is drawn in the plan view; 3D has nothing to show yet.
      const { useEditor } = await import('./editor');
      useEditor.getState().setViewMode('plan');
    },
    openSample: () => createFrom({ ...hdb4RoomProject(newId('prj')), name: '4-room HDB (sample)' }),

    save: async () => {
      clearTimeout(autosaveTimer);
      const backend = get().backend;
      if (!backend) return;
      const sent = get().editor.doc;
      set({ sync: { kind: 'saving' } });
      try {
        const version = await backend.save(sent);
        // Stamp the new version onto the live doc without touching undo history.
        const live = get().editor;
        set({ editor: { ...live, doc: { ...live.doc, version } } });
        const changedSince = live.doc !== sent;
        set({ sync: changedSince ? { kind: 'dirty' } : { kind: 'saved', version } });
        if (changedSince) autosaveTimer = setTimeout(() => void get().save(), AUTOSAVE_MS);
        if (sent.name !== get().recent.find((r) => r.id === sent.id)?.name) {
          set({ recent: rememberRecent(sent) });
        }
      } catch (e) {
        if (e instanceof ConflictError) {
          set({ sync: { kind: 'conflict', serverVersion: e.serverVersion } });
        } else {
          set({ sync: { kind: 'error', message: (e as Error).message } });
        }
      }
    },
  };
});

/**
 * Local saves are synchronous under the hood, so flushing on pagehide keeps the last
 * edit. For the API, warn instead: a request started during unload may not finish.
 */
window.addEventListener('pagehide', () => {
  const { sync, backend, save } = useStore.getState();
  if (sync.kind === 'dirty' && backend?.kind === 'local') void save();
});
window.addEventListener('beforeunload', (e) => {
  const { sync, backend } = useStore.getState();
  const unsaved = ['dirty', 'saving', 'conflict', 'error'].includes(sync.kind);
  if (backend?.kind === 'remote' && unsaved) {
    e.preventDefault();
  }
});

export const useProject = () => useStore((s) => s.editor.doc);
