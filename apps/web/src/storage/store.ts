import {
  DEFAULT_STORAGE,
  type People,
  type StorageSetting,
  isDefaultStorage,
  parseStorageSetting,
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

const narrow = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 720px)').matches;

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
  load: (projectId: string) => void;
  set: (patch: Partial<StorageSetting>) => void;
  /** A room's people, or null to go back to its beds. */
  setPeople: (roomId: string, people: People | null) => void;
  /** Every room back to its beds, nobody else. */
  resetPeople: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setHighlight: (roomId: string | null) => void;
}

export const useStorage = create<StorageState>((set, get) => ({
  projectId: null,
  setting: structuredClone(DEFAULT_STORAGE),
  open: false,
  intro: false,
  highlight: null,
  fitAll: 0,
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
  setPeople: (roomId, people) => {
    const all = { ...get().setting.people };
    if (people) all[roomId] = { ...people };
    else delete all[roomId];
    get().set({ people: all });
  },
  resetPeople: () => get().set({ people: {}, others: { adults: 0, children: 0 } }),
  openPanel: () => set({ open: true, intro: firstVisit(), fitAll: narrow() ? Date.now() : 0 }),
  closePanel: () => set({ open: false, highlight: null }),
  setHighlight: (highlight) => set({ highlight }),
}));
