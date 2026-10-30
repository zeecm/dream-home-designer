import type { OpeningKind } from '@dhd/core';
import { create } from 'zustand';
import type { View } from './plan/view';
import { DEFAULT_OPENING_WIDTH } from './presets';

/**
 * Editor state that is never saved with the project: the active tool, the selection,
 * the 2D camera and each tool's work in progress.
 */
export type Tool =
  | 'select'
  | 'wall'
  | 'room'
  | 'door'
  | 'window'
  | 'passage'
  | 'measure'
  | 'calibrate';

export type Selection =
  | { kind: 'vertex'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'room'; id: string };

export type ViewMode = 'plan' | 'split' | '3d';

export interface EditorState {
  tool: Tool;
  selection: Selection | null;
  hover: Selection | null;
  view: View | null;
  viewMode: ViewMode;
  /** Set to fit the plan to the canvas on its next render. */
  fitRequested: boolean;
  /** True once the user pans or zooms; until then the plan refits when its pane resizes. */
  viewAdjusted: boolean;
  /** Thickness for walls the Wall tool draws, in metres. */
  wallThickness: number;
  setWallThickness: (t: number) => void;
  /** Width for new doors, windows and openings, in metres. */
  openingWidths: Record<OpeningKind, number>;
  setOpeningWidth: (kind: OpeningKind, width: number) => void;
  /** Bumped to focus the selected room's name field. */
  renameToken: number;
  requestRename: () => void;
  setTool: (tool: Tool) => void;
  select: (s: Selection | null) => void;
  setHover: (s: Selection | null) => void;
  /** `byUser` marks a pan or zoom, which stops automatic refitting. */
  setView: (v: View, byUser?: boolean) => void;
  setViewMode: (m: ViewMode) => void;
  requestFit: () => void;
  fitDone: () => void;
  /** Called when another project opens. */
  reset: () => void;
}

const VIEW_KEY = 'dhd:view';

/** The last view mode used in this browser, or a sensible default for the screen. */
const initialViewMode = (): ViewMode => {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === 'plan' || saved === 'split' || saved === '3d') return saved;
  } catch {
    // storage disabled
  }
  return typeof window !== 'undefined' && window.innerWidth < 900 ? 'plan' : 'split';
};

const rememberViewMode = (m: ViewMode) => {
  try {
    window.localStorage.setItem(VIEW_KEY, m);
  } catch {
    // storage disabled
  }
};

export const useEditor = create<EditorState>((set) => ({
  tool: 'select',
  selection: null,
  hover: null,
  view: null,
  viewMode: initialViewMode(),
  fitRequested: true,
  viewAdjusted: false,
  wallThickness: 0.1,
  setWallThickness: (wallThickness) => set({ wallThickness }),
  openingWidths: { ...DEFAULT_OPENING_WIDTH },
  setOpeningWidth: (kind, width) =>
    set((s) => ({ openingWidths: { ...s.openingWidths, [kind]: width } })),
  renameToken: 0,
  requestRename: () => set((s) => ({ renameToken: s.renameToken + 1 })),
  setTool: (tool) => set({ tool, hover: null }),
  select: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setView: (view, byUser) => set(byUser ? { view, viewAdjusted: true } : { view }),
  setViewMode: (viewMode) => {
    rememberViewMode(viewMode);
    set({ viewMode, fitRequested: true, viewAdjusted: false });
  },
  requestFit: () => set({ fitRequested: true, viewAdjusted: false }),
  fitDone: () => set({ fitRequested: false }),
  reset: () =>
    set({ tool: 'select', selection: null, hover: null, fitRequested: true, viewAdjusted: false }),
}));

export const sameSelection = (a: Selection | null, b: Selection | null) =>
  a?.kind === b?.kind && a?.id === b?.id;
