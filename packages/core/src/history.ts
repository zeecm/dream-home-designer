import { type Draft, type Patch, applyPatches, enablePatches, produceWithPatches } from 'immer';
import type { Project } from './schema';

enablePatches();

/**
 * Every mutation of a project is a Command. Applying one records Immer patches and
 * their inverse, so undo/redo never needs hand-written inverse logic.
 */
export interface Command {
  label: string;
  recipe: (draft: Draft<Project>) => void;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Entries with the same key dispatched back to back merge into one (e.g. a drag). */
  coalesceKey?: string;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export interface EditorDoc {
  doc: Project;
  history: History;
}

export const HISTORY_LIMIT = 200;

export function emptyHistory(): History {
  return { past: [], future: [] };
}

export interface DispatchOptions {
  coalesceKey?: string;
  /**
   * False for bookkeeping the user didn't do (renaming a stored file, say): the change is
   * kept but is not an undo step, and the redo stack stays.
   */
  record?: boolean;
}

export function dispatch(state: EditorDoc, cmd: Command, opts: DispatchOptions = {}): EditorDoc {
  const [doc, patches, inverse] = produceWithPatches(state.doc, cmd.recipe);
  if (patches.length === 0) return state;
  if (opts.record === false) return { doc, history: state.history };

  const past = state.history.past.slice();
  const last = past[past.length - 1];
  if (opts.coalesceKey && last?.coalesceKey === opts.coalesceKey) {
    past[past.length - 1] = {
      ...last,
      patches: [...last.patches, ...patches],
      inverse: [...inverse, ...last.inverse],
    };
  } else {
    past.push({ label: cmd.label, patches, inverse, coalesceKey: opts.coalesceKey });
    if (past.length > HISTORY_LIMIT) past.shift();
  }
  return { doc, history: { past, future: [] } };
}

export function canUndo(state: EditorDoc): boolean {
  return state.history.past.length > 0;
}

export function canRedo(state: EditorDoc): boolean {
  return state.history.future.length > 0;
}

export function undo(state: EditorDoc): EditorDoc {
  const entry = state.history.past[state.history.past.length - 1];
  if (!entry) return state;
  return {
    doc: applyPatches(state.doc, entry.inverse),
    history: {
      past: state.history.past.slice(0, -1),
      // A redone entry must never coalesce with a later edit.
      future: [{ ...entry, coalesceKey: undefined }, ...state.history.future],
    },
  };
}

export function redo(state: EditorDoc): EditorDoc {
  const [entry, ...future] = state.history.future;
  if (!entry) return state;
  return {
    doc: applyPatches(state.doc, entry.patches),
    history: { past: [...state.history.past, entry], future },
  };
}
