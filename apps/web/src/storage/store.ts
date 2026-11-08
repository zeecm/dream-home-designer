import {
  DEFAULT_STORAGE,
  type People,
  type StorageAmount,
  type StorageSetting,
  isDefaultStorage,
  parseStorageSetting,
  withRoomPeople,
} from '@dhd/core';
import { create } from 'zustand';

/**
 * The storage meter's household, per browser and per project (slice 1: a view choice; slice 2
 * moves it into the project): who sleeps where, who else lives here, how much they own and
 * whether the shelter counts. A key apart from the ageing check's (`dhd-ageing-…`): that one's
 * schema strips keys it doesn't know. Plus the panel's state, never saved.
 */
export const storageKey = (projectId: string) => `dhd-storage-${projectId}`;
/** Set once the panel has been opened in this browser: the intro and the open household go. */
export const STORAGE_SEEN_KEY = 'dhd-storage-seen';

export function loadStorage(projectId: string): StorageSetting {
  try {
    return parseStorageSetting(window.localStorage.getItem(storageKey(projectId)));
  } catch {
    return structuredClone(DEFAULT_STORAGE);
  }
}

let read: { projectId: string; raw: string | null; setting: StorageSetting } | null = null;

/**
 * The meter's setting for a project, as the designer's lens reads it: the store's when it holds
 * that project, else what this browser kept (read once per change, never written).
 */
export function meterSetting(projectId: string): StorageSetting {
  const s = useStorage.getState();
  if (s.projectId === projectId) return s.setting;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey(projectId));
  } catch {
    raw = null;
  }
  if (read?.projectId !== projectId || read.raw !== raw) {
    read = { projectId, raw, setting: parseStorageSetting(raw) };
  }
  return read.setting;
}

/**
 * How much they own, set from the designer's "How much do you own?" (one value with the
 * meter's own setting): the meter reads it at once, and it is kept for the project.
 */
export function setMeterAmount(projectId: string, amount: StorageAmount) {
  const s = useStorage.getState();
  if (s.projectId !== projectId) s.load(projectId);
  if (useStorage.getState().setting.amount !== amount) useStorage.getState().set({ amount });
}

function saveStorage(projectId: string, s: StorageSetting) {
  try {
    if (isDefaultStorage(s)) window.localStorage.removeItem(storageKey(projectId));
    else window.localStorage.setItem(storageKey(projectId), JSON.stringify(s));
  } catch {
    // Not remembered; used for this visit.
  }
}

function firstVisit(): boolean {
  try {
    if (window.localStorage.getItem(STORAGE_SEEN_KEY)) return false;
    window.localStorage.setItem(STORAGE_SEEN_KEY, 'seen');
    return true;
  } catch {
    return true;
  }
}

/** A phone, upright or on its side: the panel is a sheet over (or beside) the plan. */
export const narrow = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(max-width: 720px), (max-height: 500px) and (pointer: coarse)').matches;

export interface StorageState {
  projectId: string | null;
  setting: StorageSetting;
  /** The panel shows in the details (a half-height sheet on a phone). */
  open: boolean;
  /** The first time it opens in this browser: the intro, and who lives here unfolded. */
  intro: boolean;
  /** The room whose card was tapped: outlined on the plan. */
  highlight: string | null;
  /** When the panel opened on a phone: the plan refits above the sheet. */
  fitAll: number;
  /** A piece armed from an Add link, to place on the plan; the panel comes back after. */
  adding: { kindId: string; what: string } | null;
  /** A piece opened from a card: where the panel was, to go back to. */
  returnTo: { scroll: number; roomId: string | null } | null;
  load: (projectId: string) => void;
  set: (patch: Partial<StorageSetting>) => void;
  /**
   * A room's people, or null to go back to its beds; kept under its room in the flat as it is
   * when `alias` matches one, dropping rooms not in `known` (`withRoomPeople`).
   */
  setPeople: (
    roomId: string,
    people: People | null,
    alias?: ReadonlyMap<string, string>,
    known?: ReadonlySet<string>,
  ) => void;
  /** Every room back to its beds, nobody else. */
  resetPeople: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setHighlight: (roomId: string | null) => void;
  setAdding: (adding: StorageState['adding']) => void;
  setReturnTo: (returnTo: StorageState['returnTo']) => void;
}

export const useStorage = create<StorageState>((set, get) => ({
  projectId: null,
  setting: structuredClone(DEFAULT_STORAGE),
  open: false,
  intro: false,
  highlight: null,
  fitAll: 0,
  adding: null,
  returnTo: null,
  load: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, setting: loadStorage(projectId), open: false, highlight: null });
  },
  set: (patch) => {
    const next: StorageSetting = { ...get().setting, ...patch };
    const { projectId } = get();
    if (projectId) saveStorage(projectId, next);
    set({ setting: next });
  },
  setPeople: (roomId, people, alias, known) =>
    get().set({ people: withRoomPeople(get().setting.people, roomId, people, alias, known) }),
  resetPeople: () => get().set({ people: {}, others: { adults: 0, children: 0 } }),
  openPanel: () =>
    set({
      open: true,
      intro: firstVisit(),
      fitAll: narrow() ? Date.now() : 0,
      returnTo: null,
      adding: null,
    }),
  closePanel: () => set({ open: false, highlight: null, adding: null, returnTo: null }),
  setHighlight: (highlight) => set({ highlight }),
  setAdding: (adding) => set({ adding }),
  setReturnTo: (returnTo) => set({ returnTo }),
}));
