import {
  type Command,
  type DispatchOptions,
  type EditorDoc,
  type Project,
  canRedo,
  canUndo,
  dispatch as coreDispatch,
  emptyHistory,
  hdb4RoomProject,
  redo as coreRedo,
  undo as coreUndo,
} from '@dhd/core';
import { create } from 'zustand';
import { ConflictError, NotFoundError, createProject, getProject, saveProject } from './api';

export type SyncStatus =
  | { kind: 'loading' }
  | { kind: 'offline'; message: string }
  | { kind: 'saved'; version: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict'; serverVersion: number }
  | { kind: 'error'; message: string };

interface State {
  editor: EditorDoc;
  sync: SyncStatus;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: (cmd: Command, opts?: DispatchOptions) => void;
  undo: () => void;
  redo: () => void;
  load: (id: string) => Promise<void>;
  save: () => Promise<void>;
}

const AUTOSAVE_MS = 2000;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => {
  const commit = (editor: EditorDoc) => {
    set({ editor, canUndo: canUndo(editor), canRedo: canRedo(editor) });
    const s = get().sync;
    if (s.kind === 'offline' || s.kind === 'conflict') return;
    set({ sync: { kind: 'dirty' } });
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void get().save(), AUTOSAVE_MS);
  };

  const replace = (doc: Project, sync: SyncStatus) =>
    set({ editor: { doc, history: emptyHistory() }, sync, canUndo: false, canRedo: false });

  return {
    editor: { doc: hdb4RoomProject(), history: emptyHistory() },
    sync: { kind: 'loading' },
    canUndo: false,
    canRedo: false,

    dispatch: (cmd, opts) => {
      const next = coreDispatch(get().editor, cmd, opts);
      if (next !== get().editor) commit(next);
    },
    undo: () => commit(coreUndo(get().editor)),
    redo: () => commit(coreRedo(get().editor)),

    load: async (id) => {
      clearTimeout(autosaveTimer);
      set({ sync: { kind: 'loading' } });
      try {
        let doc: Project;
        try {
          doc = await getProject(id);
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
          try {
            doc = await createProject(hdb4RoomProject(id));
          } catch (createErr) {
            // Another tab (or React StrictMode's double effect) created it first.
            if (!(createErr instanceof ConflictError)) throw createErr;
            doc = await getProject(id);
          }
        }
        replace(doc, { kind: 'saved', version: doc.version });
      } catch (e) {
        replace(hdb4RoomProject(id), {
          kind: 'offline',
          message: `API unreachable, working locally (${(e as Error).message})`,
        });
      }
    },

    save: async () => {
      clearTimeout(autosaveTimer);
      const sent = get().editor.doc;
      set({ sync: { kind: 'saving' } });
      try {
        const version = await saveProject(sent);
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

export const useProject = () => useStore((s) => s.editor.doc);
