import type { ElecKind, Level, OpeningKind, Variant } from '@dhd/core';
import { create } from 'zustand';
import type { View } from './plan/view';
import { DEFAULT_OPENING_WIDTH } from './presets';
import { track } from './telemetry';

/**
 * Editor state that is never saved with the project: the active tool, the selection,
 * the 2D camera and each tool's work in progress.
 */
export type Tool =
  | 'select'
  | 'comment'
  | 'wall'
  | 'room'
  | 'door'
  | 'window'
  | 'passage'
  | 'measure'
  | 'calibrate'
  | 'furniture'
  | 'electrical';

export type Selection =
  | { kind: 'vertex'; id: string }
  | { kind: 'wall'; id: string }
  | { kind: 'opening'; id: string }
  | { kind: 'room'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'point'; id: string };

export type ViewMode = 'plan' | 'split' | '3d';
export type SingleView = Exclude<ViewMode, 'split'>;

/**
 * The view the stage shows. A phone has room for one view: with Split on, it shows the last
 * single view chosen, and Split comes back when the screen widens again.
 */
export const shownView = (mode: ViewMode, last: SingleView, oneView: boolean): ViewMode =>
  oneView && mode === 'split' ? last : mode;

export interface EditorState {
  tool: Tool;
  selection: Selection | null;
  hover: Selection | null;
  view: View | null;
  viewMode: ViewMode;
  /** The last single view chosen (Plan or 3D): what a phone shows when Split is on. */
  lastSingle: SingleView;
  /** Set to fit the plan to the canvas on its next render. */
  fitRequested: boolean;
  /** True once the user pans or zooms; until then the plan refits when its pane resizes. */
  viewAdjusted: boolean;
  /** Thickness for walls the Wall tool draws, in metres; 0 draws room boundaries. */
  wallThickness: number;
  setWallThickness: (t: number) => void;
  /** Width for new doors, windows and openings, in metres. */
  openingWidths: Record<OpeningKind, number>;
  setOpeningWidth: (kind: OpeningKind, width: number) => void;
  /** The catalogue piece the Furniture tool places. */
  furnitureKind: string;
  setFurnitureKind: (id: string) => void;
  /** The kind of point the Electrical tool places. */
  elecKind: ElecKind;
  setElecKind: (k: ElecKind) => void;
  /**
   * An aircon unit whose trunking is being run (Electrical tool): each tap is a bend, a tap
   * on a compressor ends it. `key` makes the run one undo step.
   */
  trunking: { id: string; key: string } | null;
  setTrunking: (t: { id: string; key: string } | null) => void;
  /** Bumped to focus the selected room's name field. */
  renameToken: number;
  requestRename: () => void;
  /** Bumped to open the plan details at which way the plan faces (the plan's compass). */
  directionToken: number;
  revealDirection: () => void;
  setTool: (tool: Tool) => void;
  select: (s: Selection | null) => void;
  setHover: (s: Selection | null) => void;
  /** `byUser` marks a pan or zoom, which stops automatic refitting. */
  setView: (v: View, byUser?: boolean) => void;
  setViewMode: (m: ViewMode) => void;
  /** `padding`: pixels to spare round the plan (a designer's sheet asks for more). */
  requestFit: (padding?: number) => void;
  /** The padding the fit asked for uses. */
  fitPadding: number;
  fitDone: () => void;
  /** Called when another project opens. */
  reset: () => void;
  /** First-person walk in the 3D view; remembers the view mode to return to. */
  walking: { returnTo: ViewMode } | null;
  startWalk: () => void;
  stopWalk: () => void;
  /** The 3D view's time of day, in hours on the site's clock (not saved with the plan). */
  sunHour: number;
  setSunHour: (h: number) => void;
  /** Which version of the flat is shown and edited, when the plan has a renovation. */
  variant: Variant;
  setVariant: (v: Variant) => void;
  /**
   * A designer's version shown in place of the plan, read-only (not in the plan yet), or
   * null. `side` 'before' shows the flat as it is, for comparing.
   */
  preview: DesignPreview | null;
  setPreview: (p: DesignPreview | null) => void;
}

export interface DesignPreview {
  level: Level;
  before: Level;
  /** "V2". */
  label: string;
  side: 'before' | 'version';
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

/**
 * What the Wall and Room tools draw for a palette choice: a thickness of 0 is the
 * "Boundary" choice, a room edge with no wall.
 */
export const newWallOptions = (thickness: number) =>
  thickness > 0 ? { thickness } : { thickness: 0.1, kind: 'boundary' as const };

export const useEditor = create<EditorState>((set) => ({
  tool: 'select',
  selection: null,
  hover: null,
  view: null,
  viewMode: initialViewMode(),
  lastSingle: initialViewMode() === '3d' ? '3d' : 'plan',
  fitRequested: true,
  viewAdjusted: false,
  wallThickness: 0.1,
  setWallThickness: (wallThickness) => set({ wallThickness }),
  openingWidths: { ...DEFAULT_OPENING_WIDTH },
  setOpeningWidth: (kind, width) =>
    set((s) => ({ openingWidths: { ...s.openingWidths, [kind]: width } })),
  furnitureKind: 'sofa-3',
  setFurnitureKind: (furnitureKind) => set({ furnitureKind }),
  elecKind: 'socket-double',
  setElecKind: (elecKind) => set({ elecKind, trunking: null }),
  trunking: null,
  setTrunking: (trunking) => set({ trunking }),
  renameToken: 0,
  requestRename: () => set((s) => ({ renameToken: s.renameToken + 1 })),
  directionToken: 0,
  revealDirection: () =>
    set((s) => ({ selection: null, tool: 'select', directionToken: s.directionToken + 1 })),
  setTool: (tool) => set({ tool, hover: null, trunking: null }),
  select: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setView: (view, byUser) => set(byUser ? { view, viewAdjusted: true } : { view }),
  setViewMode: (viewMode) => {
    rememberViewMode(viewMode);
    set({
      viewMode,
      ...(viewMode !== 'split' && { lastSingle: viewMode }),
      fitRequested: true,
      viewAdjusted: false,
      walking: null,
    });
  },
  walking: null,
  sunHour: 15,
  setSunHour: (sunHour) => set({ sunHour }),
  variant: 'before',
  preview: null,
  // A version shown can't be edited: the tools go back to Select; nothing stays selected.
  setPreview: (preview) =>
    set((s) =>
      preview && !s.preview
        ? { preview, tool: 'select', selection: null, hover: null, trunking: null }
        : preview
          ? { preview }
          : { preview: null, selection: null, hover: null },
    ),
  // The other version may not have what's selected or half-drawn.
  setVariant: (variant) =>
    set((s) =>
      s.variant === variant ? {} : { variant, selection: null, hover: null, trunking: null },
    ),
  // Walking takes the whole stage (and isn't remembered as the view mode).
  startWalk: () => {
    track('walk');
    set((s) => ({ walking: { returnTo: s.viewMode }, viewMode: '3d' }));
  },
  stopWalk: () => set((s) => (s.walking ? { viewMode: s.walking.returnTo, walking: null } : {})),
  fitPadding: 48,
  requestFit: (padding = 48) =>
    set({ fitRequested: true, viewAdjusted: false, fitPadding: padding }),
  fitDone: () => set({ fitRequested: false }),
  reset: () =>
    set((s) => ({
      tool: 'select',
      selection: null,
      hover: null,
      trunking: null,
      preview: null,
      fitRequested: true,
      viewAdjusted: false,
      ...(s.walking ? { viewMode: s.walking.returnTo, walking: null } : {}),
    })),
}));

export const sameSelection = (a: Selection | null, b: Selection | null) =>
  a?.kind === b?.kind && a?.id === b?.id;
