import { type AgeingChoice, type AgeingSetting, parseAgeingSetting } from '@dhd/core';
import { create } from 'zustand';

/**
 * The ageing parents check's choices, per browser and per project (slice 1: view choices,
 * like "From" in My furniture; slice 2 moves them into the project): who it is for, the
 * bedroom and bathroom to check, the flat type for EASE. Plus the list's state, never saved.
 */
export const ageingKey = (projectId: string) => `dhd-ageing-${projectId}`;
const INTRO_KEY = 'dhd-ageing-intro';

export function loadSetting(projectId: string): AgeingSetting {
  try {
    return parseAgeingSetting(window.localStorage.getItem(ageingKey(projectId)));
  } catch {
    return { profile: 'off' };
  }
}

function saveSetting(projectId: string, s: AgeingSetting) {
  try {
    if (s.profile === 'off' && !s.bedroomId && !s.bathroomId && !s.flatType) {
      window.localStorage.removeItem(ageingKey(projectId));
    } else {
      window.localStorage.setItem(ageingKey(projectId), JSON.stringify(s));
    }
  } catch {
    // Not remembered; used for this visit.
  }
}

/** The choice the check runs with, or null when it is off. */
export const choiceOf = (s: AgeingSetting): AgeingChoice | null =>
  s.profile === 'off'
    ? null
    : {
        profile: s.profile,
        ...(s.bedroomId ? { bedroomId: s.bedroomId } : {}),
        ...(s.bathroomId ? { bathroomId: s.bathroomId } : {}),
      };

export interface AgeingState {
  projectId: string | null;
  setting: AgeingSetting;
  /** The list of results shows in the details panel. */
  listOpen: boolean;
  /** The key of the line last shown (Show next, or a tap on it). */
  shown: string | null;
  /** The intro shows: the first time the check is turned on in this browser. */
  intro: boolean;
  /** When the list opened on a phone: the plan refits above the sheet. */
  fitAll: number;
  /** Reads this project's setting (another project opened). */
  load: (projectId: string) => void;
  set: (patch: Partial<AgeingSetting>) => void;
  openList: () => void;
  closeList: () => void;
}

const narrow = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 720px)').matches;

export const useAgeing = create<AgeingState>((set, get) => ({
  projectId: null,
  setting: { profile: 'off' },
  listOpen: false,
  shown: null,
  intro: false,
  fitAll: 0,
  load: (projectId) => {
    if (get().projectId === projectId) return;
    set({ projectId, setting: loadSetting(projectId), listOpen: false, shown: null });
  },
  set: (patch) => {
    const { projectId, setting } = get();
    const next: AgeingSetting = { ...setting, ...patch };
    for (const k of ['bedroomId', 'bathroomId', 'flatType'] as const) {
      if (next[k] === undefined) delete next[k];
    }
    let intro = get().intro;
    if (setting.profile === 'off' && next.profile !== 'off') {
      try {
        if (!window.localStorage.getItem(INTRO_KEY)) {
          intro = true;
          window.localStorage.setItem(INTRO_KEY, 'seen');
        }
      } catch {
        intro = true;
      }
    }
    if (projectId) saveSetting(projectId, next);
    set({
      setting: next,
      intro: next.profile === 'off' ? false : intro,
      ...(next.profile === 'off' ? { listOpen: false, shown: null } : {}),
    });
  },
  openList: () => set({ listOpen: true, fitAll: narrow() ? Date.now() : 0 }),
  closeList: () => set({ listOpen: false, intro: false }),
}));
