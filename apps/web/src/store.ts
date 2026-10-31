import {
  type Command,
  type DispatchOptions,
  type EditorDoc,
  FURNITURE,
  type Level,
  type Project,
  blankProject,
  canRedo,
  canUndo,
  dispatch as coreDispatch,
  redo as coreRedo,
  undo as coreUndo,
  customModelFile,
  emptyHistory,
  furnitureKind,
  loadProject,
  newId,
  sampleFlatProject,
  setProjectModels,
  touchedVariant,
  variantLevels,
} from '@dhd/core';
import type { Patch } from 'immer';
import { create } from 'zustand';
import { forgetWithAccount, keepWithAccount } from './account';
import { getAsset, putAsset } from './assets';
import {
  type Backend,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type Role,
  apiAvailable,
  localBackend,
  remoteBackend,
  storedLocally,
} from './backend';
import { useEditor } from './editor';
import { startGuide } from './guide';
import { keysFor } from './keys';
import {
  type RecentProject,
  deletable,
  forgetRecent,
  keptSample,
  recentProjects,
  rememberRecent,
} from './recent';
import { track } from './telemetry';

export type SyncStatus =
  | { kind: 'loading' }
  | { kind: 'saved'; version: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict'; serverVersion: number }
  | { kind: 'error'; message: string }
  /** The server couldn't be reached to open `id`; nothing is forgotten, and Retry tries again. */
  | { kind: 'unreachable'; id: string }
  /**
   * `id` could not be opened (a newer format, a bad document, a server error). The editor
   * still holds whatever was open before, which must not be edited or saved in its place.
   */
  | { kind: 'failed'; id: string; message: string };

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
  /** What this browser may do with the open project; a viewer can't change it. */
  role: Role;
  /** Opens a copy of the open project as a new plan of this browser's own. */
  copyProject: () => Promise<void>;
  /** Opens a project file (from Download → Project file) as a new plan of this browser's. */
  importProject: (text: string) => Promise<void>;
  /**
   * Makes this browser the owner of a plan from before sharing (role `open`). Asked for, not
   * automatic: anyone with such a plan's link could otherwise take it from its creator.
   */
  claim: () => Promise<boolean>;
  dispatch: (cmd: Command, opts?: DispatchOptions) => void;
  undo: () => void;
  redo: () => void;
  load: (id: string) => Promise<void>;
  /** Probes the server again and reopens the plan that couldn't be reached. */
  retry: () => Promise<void>;
  /** Creates a blank project, stores it and opens it. */
  createProject: (name?: string) => Promise<void>;
  /** Opens a fresh copy of the reference plan, so every visitor edits their own. */
  openSample: () => Promise<void>;
  /**
   * Deletes plans this browser owns and takes plans shared with it off its list; sample
   * copies are kept. If the open plan goes, the newest one left (or a new sample) opens.
   * Resolves to the names that couldn't be deleted.
   */
  deletePlans: (ids: string[]) => Promise<string[]>;
  save: () => Promise<void>;
  /** Resolves a save conflict: reload the server's version, or overwrite it with ours. */
  resolveConflict: (keep: 'theirs' | 'mine') => Promise<void>;
}

const AUTOSAVE_MS = 2000;
const RETRY_MAX_MS = 30_000;

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retries = 0;
/** The save in flight, if any; only one runs at a time. */
let inflight: Promise<void> | null = null;
/** Set when the document changed (or a save was asked for) while a save was in flight. */
let saveAgain = false;

let backendPromise: Promise<Backend> | undefined;
let usingFallback = false;
let probedAt = 0;

const localNotice =
  'The server can’t be reached right now, so this plan is saved in this browser only.';

/**
 * Probes the API (once, unless the last probe failed over a minute ago or `fresh` is set).
 * Without an API, projects live in this browser.
 */
function resolveBackend(fresh = false): Promise<Backend> {
  if (fresh || (usingFallback && Date.now() - probedAt > 60_000)) backendPromise = undefined;
  backendPromise ??= (async () => {
    probedAt = Date.now();
    // A sleeping API container takes a few seconds to wake, so be patient here.
    const ok = await apiAvailable(20_000);
    usingFallback = !ok;
    return ok ? remoteBackend : localBackend();
  })();
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

/**
 * Whether this browser may delete a plan rather than just take it off its list: it holds
 * the plan's owner key, or the plan lives only in this browser. Decided per plan, not by
 * where the open plan happens to be stored.
 */
export const ownsPlan = (id: string) => !!keysFor(id).owner || storedLocally(id);

/** Usage events from edits: the steps of a first plan, and the big features. */
function countUsage(label: string, before: EditorDoc, after: EditorDoc) {
  const count = (d: EditorDoc, k: 'walls' | 'rooms' | 'items') =>
    d.doc.levels.reduce((n, l) => n + Object.keys(l[k]).length, 0);
  if (count(before, 'walls') === 0 && count(after, 'walls') > 0) track('first-wall');
  if (count(before, 'rooms') === 0 && count(after, 'rooms') > 0) track('first-room');
  if (count(after, 'items') > count(before, 'items')) track('furnish');
  if (label === 'Calibrate plan image') track('calibrate');
  else if (label === 'Plan a renovation') track('renovation');
  else if (label === 'Restore an earlier version') track('restore-version');
}

/** Commands that remove things get an Undo toast; this is its text, or null for none. */
function toastFor(label: string): string | null {
  if (label === 'Discard the renovation') return 'Renovation discarded';
  if (label === 'Make the renovation the plan') return 'The renovation is now the plan';
  if (label === 'Restore an earlier version') return 'Earlier version restored';
  if (!label.startsWith('Delete ')) return null;
  const what = label.slice('Delete '.length);
  return `${what[0]?.toUpperCase()}${what.slice(1)} deleted`;
}

/** States in which the open document may be edited. */
const EDITABLE = new Set<SyncStatus['kind']>(['saved', 'dirty', 'saving', 'conflict', 'error']);

/** Whether the open document may be edited now: a real project is open, not view-only. */
export const canEdit = (s: { sync: SyncStatus; role: Role }) =>
  EDITABLE.has(s.sync.kind) && s.role !== 'viewer';

export const useStore = create<State>((set, get) => {
  const commit = (editor: EditorDoc) => {
    set({ editor, canUndo: canUndo(editor), canRedo: canRedo(editor) });
    if (get().sync.kind === 'conflict') return;
    if (get().sync.kind !== 'saving') set({ sync: { kind: 'dirty' } });
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void get().save(), AUTOSAVE_MS);
  };

  const open = (doc: Project, sample = false) => {
    clearTimeout(retryTimer);
    retries = 0;
    const backend = get().backend;
    const role = backend?.role?.(doc.id) ?? 'owner';
    set({
      editor: { doc, history: emptyHistory() },
      sync: { kind: 'saved', version: doc.version },
      canUndo: false,
      canRedo: false,
      role,
      // A viewer is just looking: don't put the plan in this browser's project list.
      recent: role === 'viewer' ? get().recent : rememberRecent(doc, undefined, sample),
    });
    rememberProject(doc.id);
    // Signed in, the plan is kept with the account, keys and all, for the person's other devices.
    if (role !== 'viewer') keepWithAccount({ id: doc.id, name: doc.name, sample });
    // A plan with a renovation opens on it: that is the version being worked on.
    useEditor.getState().setVariant(doc.renovation ? 'after' : 'before');
  };

  /** Finishes any save in flight and saves pending edits before leaving the open project. */
  const flush = async () => {
    clearTimeout(autosaveTimer);
    clearTimeout(retryTimer);
    while (inflight) await inflight;
    if (get().sync.kind === 'dirty') await get().save();
    while (inflight) await inflight;
  };

  /**
   * After an undo or redo, shows the version of the flat it changed, so it never changes
   * one out of sight.
   */
  const showChanged = (patches: readonly Patch[]) => {
    const touched = touchedVariant(patches);
    const has = !!get().editor.doc.renovation;
    if (!has) useEditor.getState().setVariant('before');
    else if (touched) useEditor.getState().setVariant(touched);
  };

  /** Where a missing plan leads: the sample this browser keeps, or a new copy of it. */
  const fallBack = () => {
    const kept = keptSample(get().recent);
    return kept ? get().load(kept) : get().openSample();
  };

  const createFrom = async (doc: Project, sample = false) => {
    await flush();
    set({ sync: { kind: 'loading' } });
    try {
      const backend = await resolveBackend();
      set({ backend });
      if (backend.kind === 'local' && !get().notice) set({ notice: localNotice });
      open(await backend.create(doc), sample);
    } catch (e) {
      // The server's daily cap for this network (an office or school shares one address):
      // keep this plan in the browser instead of opening nothing.
      if (e instanceof Error && /^429 /.test(e.message) && get().backend?.kind === 'remote') {
        try {
          const local = localBackend();
          set({
            backend: local,
            notice:
              'A lot of new plans have come from your network today, so this one is kept in this browser for now.',
          });
          open(await local.create(doc), sample);
          return;
        } catch {
          // Fall through to the error below.
        }
      }
      set({ sync: { kind: 'error', message: errorMessage('Could not create a project', e) } });
    }
  };

  return {
    backend: null,
    editor: { doc: sampleFlatProject(), history: emptyHistory() },
    sync: { kind: 'loading' },
    canUndo: false,
    canRedo: false,
    recent: recentProjects(),
    notice: null,
    dismissNotice: () => set({ notice: null }),
    toast: null,
    role: 'owner',

    dispatch: (cmd, opts) => {
      // Nothing is edited until a real project is open (not while loading or unreachable).
      if (!canEdit(get())) return;
      const editorBefore = get().editor;
      const next = coreDispatch(editorBefore, cmd, opts);
      if (next === get().editor) return;
      commit(next);
      countUsage(cmd.label, editorBefore, next);
      const text = toastFor(cmd.label);
      if (text) set({ toast: { text, at: Date.now() } });
    },
    undo: () => {
      if (!canEdit(get())) return;
      const step = get().editor.history.past.at(-1);
      const next = coreUndo(get().editor);
      if (next === get().editor) return;
      commit(next);
      showChanged(step?.inverse ?? []);
    },
    redo: () => {
      if (!canEdit(get())) return;
      const step = get().editor.history.future[0];
      const next = coreRedo(get().editor);
      if (next === get().editor) return;
      commit(next);
      showChanged(step?.patches ?? []);
    },

    load: async (id) => {
      if (!VALID_ID.test(id)) {
        set({
          notice: 'That link doesn’t point to a plan, so the sample flat opened instead.',
        });
        return fallBack();
      }
      if (get().editor.doc.id !== id) await flush();
      set({ sync: { kind: 'loading' } });
      try {
        const backend = await resolveBackend();
        set({ backend });
        try {
          open(await backend.get(id));
          if (backend.kind === 'local' && usingFallback && !get().notice)
            set({ notice: localNotice });
          return;
        } catch (e) {
          if (!(e instanceof NotFoundError)) throw e;
        }
        if (backend.kind === 'local' && usingFallback) {
          // The server may well have it; never forget a plan because we couldn't reach it.
          set({ sync: { kind: 'unreachable', id } });
          return;
        }
        // Created in this browser while the server was down? Then it is only here.
        try {
          const local = localBackend();
          const doc = await local.get(id);
          set({
            backend: local,
            notice:
              'This plan was saved in this browser while the server was unreachable, so it is only here.',
          });
          open(doc);
          return;
        } catch {
          // not here either
        }
        set({
          recent: forgetRecent(id),
          notice: 'That project isn’t saved here, so the sample flat opened instead.',
        });
        return fallBack();
      } catch (e) {
        set({
          sync: { kind: 'failed', id, message: errorMessage('Could not open the project', e) },
        });
      }
    },

    retry: async () => {
      const s = get().sync;
      await resolveBackend(true);
      if (s.kind === 'unreachable' || s.kind === 'failed') return get().load(s.id);
      if (s.kind === 'error') return get().save();
    },

    createProject: async (name) => {
      const doc = blankProject(name);
      track('new-plan');
      // A first plan of one's own gets the getting-started guide.
      startGuide(doc.id);
      await createFrom(doc);
      // A blank plan is drawn in the plan view; 3D has nothing to show yet.
      useEditor.getState().setViewMode('plan');
    },
    openSample: () => {
      track('open-sample');
      return createFrom(sampleFlatProject(newId('prj')), true);
    },
    deletePlans: async (ids) => {
      const list = get().recent;
      const doomed = list.filter((r) => ids.includes(r.id) && deletable(r, list));
      if (doomed.length === 0) return [];
      const gone = new Set(doomed.map((r) => r.id));
      // Move off the open plan first, so nothing saves it back as it goes.
      if (gone.has(get().editor.doc.id)) {
        const next = get().recent.find((r) => !gone.has(r.id));
        if (next) await get().load(next.id);
        else await get().openSample();
        // Couldn't get off it (the server is away): delete nothing rather than the open plan.
        if (gone.has(get().editor.doc.id)) return doomed.map((r) => r.name);
      }
      const failed: string[] = [];
      for (const r of doomed) {
        try {
          if (keysFor(r.id).owner) await remoteBackend.remove(r.id);
          if (storedLocally(r.id)) await localBackend().remove(r.id);
        } catch (e) {
          if (!(e instanceof NotFoundError)) {
            failed.push(r.name);
            continue;
          }
        }
        set({ recent: forgetRecent(r.id) });
        forgetWithAccount(r.id);
      }
      return failed;
    },
    claim: async () => {
      const { backend, editor } = get();
      const id = editor.doc.id;
      if (!backend?.claim) return false;
      const claimed = await backend.claim(id);
      // Not claimed: someone else got there first, so this browser can only look.
      if (get().editor.doc.id === id) set({ role: claimed ? 'owner' : 'viewer' });
      return claimed;
    },
    importProject: async (text) => {
      let project: Project;
      try {
        project = loadProject(JSON.parse(text)).project;
      } catch (e) {
        set({ notice: errorMessage('That file isn’t a Dream Home project', e) });
        return;
      }
      await createFrom({ ...project, id: newId('prj'), version: 0 });
    },
    copyProject: async () => {
      const doc = get().editor.doc;
      // The copy uploads its models from this browser: fetch any it doesn't hold yet.
      const backend = get().backend;
      await Promise.all(
        Object.values(doc.models ?? {}).map(async (m) => {
          const key = customModelFile(m.hash);
          if (await getAsset(key).catch(() => undefined)) return;
          const blob = await backend?.getModel?.(doc.id, m.hash).catch(() => undefined);
          if (blob) await putAsset(key, blob).catch(() => {});
        }),
      );
      const name = doc.name.replace(/ \(sample\)$/, '');
      await createFrom({ ...doc, id: newId('prj'), version: 0, name: `${name} (copy)` });
    },

    save: () => {
      clearTimeout(autosaveTimer);
      clearTimeout(retryTimer);
      if (inflight) {
        saveAgain = true;
        return inflight;
      }
      const backend = get().backend;
      const kind = get().sync.kind;
      if (
        !backend ||
        kind === 'conflict' ||
        kind === 'loading' ||
        kind === 'unreachable' ||
        kind === 'failed'
      ) {
        return Promise.resolve();
      }
      const sent = get().editor.doc;
      set({ sync: { kind: 'saving' } });
      inflight = (async () => {
        try {
          const version = await backend.save(sent);
          retries = 0;
          const live = get().editor;
          if (live.doc.id !== sent.id) return; // another project opened meanwhile
          set({ editor: { ...live, doc: { ...live.doc, version } } });
          const changedSince = live.doc !== sent;
          set({ sync: changedSince ? { kind: 'dirty' } : { kind: 'saved', version } });
          if (changedSince) saveAgain = true;
          if (sent.name !== get().recent.find((r) => r.id === sent.id)?.name) {
            set({ recent: rememberRecent(sent) });
            keepWithAccount({ id: sent.id, name: sent.name });
          }
        } catch (e) {
          if (get().editor.doc.id !== sent.id) return;
          if (e instanceof ConflictError) {
            set({ sync: { kind: 'conflict', serverVersion: e.serverVersion } });
            return;
          }
          if (e instanceof ForbiddenError) {
            // The edit link was turned off or reset while this tab was open.
            set({
              role: 'viewer',
              sync: { kind: 'saved', version: sent.version },
              notice:
                'This plan’s edit link no longer works, so the latest changes weren’t saved. Make your own copy to keep them.',
            });
            return;
          }
          // Rate limits, a waking server or a dropped connection: try again, backing off.
          const delay = Math.min(RETRY_MAX_MS, 2000 * 2 ** retries++);
          set({
            sync: {
              kind: 'error',
              message: `${(e as Error).message}. Retrying in ${Math.round(delay / 1000)} s.`,
            },
          });
          retryTimer = setTimeout(() => {
            if (get().editor.doc.id === sent.id && get().sync.kind === 'error') void get().save();
          }, delay);
        }
      })().finally(() => {
        inflight = null;
        if (saveAgain) {
          saveAgain = false;
          if (get().sync.kind === 'dirty') void get().save();
        }
      });
      return inflight;
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
  };
});

/**
 * Local saves are synchronous under the hood, so flushing on pagehide keeps the last
 * edit. For the API, warn instead: a request started during unload may not finish.
 */
// The open project's uploaded models join the catalogue as soon as its document changes,
// before anything renders from it (this listener was subscribed before any component's).
let shownModels: Project['models'] | null = null;
const followModels = (doc: Project) => {
  if (doc.models === shownModels) return;
  shownModels = doc.models;
  setProjectModels(doc.models);
  // A model removed (or undone away) while the Furniture tool held it: arm a catalogue piece.
  const armed = useEditor.getState().furnitureKind;
  if (!furnitureKind(armed)) useEditor.getState().setFurnitureKind(FURNITURE[0]?.id ?? armed);
};
followModels(useStore.getState().editor.doc);
useStore.subscribe((s) => followModels(s.editor.doc));

window.addEventListener('pagehide', () => {
  const { sync, backend, save } = useStore.getState();
  if (sync.kind === 'dirty' && backend?.kind === 'local') void save();
});
window.addEventListener('beforeunload', (e) => {
  const { sync, backend } = useStore.getState();
  const unsaved = ['dirty', 'saving', 'conflict', 'error'].includes(sync.kind);
  if (backend?.kind === 'remote' && unsaved) e.preventDefault();
});

export const useProject = () => useStore((s) => s.editor.doc);

/** The level shown and edited: the plan's, or its renovation's when viewing "after". */
export function useLevel(): Level | undefined {
  const variant = useEditor((s) => s.variant);
  return useStore((s) => variantLevels(s.editor.doc, variant)[0]);
}

/** useLevel outside React, as it is now. */
export const currentLevel = (): Level | undefined =>
  variantLevels(useStore.getState().editor.doc, useEditor.getState().variant)[0];
