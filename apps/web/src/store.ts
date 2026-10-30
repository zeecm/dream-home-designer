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

export const SAMPLE_ID = 'prj_demo';

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
  dispatch: (cmd: Command, opts?: DispatchOptions) => void;
  undo: () => void;
  redo: () => void;
  load: (id: string) => Promise<void>;
  /** Creates a blank project, stores it and opens it. */
  createProject: (name?: string) => Promise<void>;
  save: () => Promise<void>;
}

const AUTOSAVE_MS = 2000;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let backendPromise: Promise<Backend> | undefined;

/** Probes the API once; without one, projects live in this browser. */
function resolveBackend(): Promise<Backend> {
  backendPromise ??= apiAvailable().then((ok) => (ok ? remoteBackend : localBackend()));
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

export function initialProjectId(): string {
  const fromUrl = new URL(window.location.href).searchParams.get('p');
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem('dhd:last') ?? SAMPLE_ID;
  } catch {
    return SAMPLE_ID;
  }
}

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
    });
    rememberProject(doc.id);
  };

  return {
    backend: null,
    editor: { doc: hdb4RoomProject(), history: emptyHistory() },
    sync: { kind: 'loading' },
    canUndo: false,
    canRedo: false,

    dispatch: (cmd, opts) => {
      const next = coreDispatch(get().editor, cmd, opts);
      if (next !== get().editor) commit(next);
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
      clearTimeout(autosaveTimer);
      set({ sync: { kind: 'loading' } });
      try {
        const backend = await resolveBackend();
        set({ backend });
        let doc: Project;
        try {
          doc = await backend.get(id);
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
          if (id !== SAMPLE_ID) {
            // A stale link or a project from another browser: fall back to the sample.
            return get().load(SAMPLE_ID);
          }
          try {
            doc = await backend.create(hdb4RoomProject(id));
          } catch (createErr) {
            // Another tab (or React StrictMode's double effect) created it first.
            if (!(createErr instanceof ConflictError)) throw createErr;
            doc = await backend.get(id);
          }
        }
        open(doc);
      } catch (e) {
        set({
          sync: { kind: 'error', message: `Could not open the project: ${(e as Error).message}` },
        });
      }
    },

    createProject: async (name) => {
      clearTimeout(autosaveTimer);
      if (get().sync.kind === 'dirty') await get().save();
      set({ sync: { kind: 'loading' } });
      try {
        const backend = await resolveBackend();
        open(await backend.create(blankProject(name)));
      } catch (e) {
        set({
          sync: { kind: 'error', message: `Could not create a project: ${(e as Error).message}` },
        });
      }
    },

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
  if (backend?.kind === 'remote' && (sync.kind === 'dirty' || sync.kind === 'saving')) {
    e.preventDefault();
  }
});

export const useProject = () => useStore((s) => s.editor.doc);
