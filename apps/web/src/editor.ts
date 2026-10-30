import type { Vec2 } from '@dhd/core';
import { create } from 'zustand';
import type { View } from './plan/view';

/**
 * Editor state that is never saved with the project: the active tool, the selection,
 * the 2D camera and each tool's work in progress.
 */
export type Tool = 'select' | 'wall' | 'door' | 'window' | 'passage' | 'measure' | 'calibrate';

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
  /** World position of the pointer over the plan, for the status line. */
  pointer: Vec2 | null;
  /** Thickness for walls the Wall tool draws, in metres. */
  wallThickness: number;
  setWallThickness: (t: number) => void;
  setTool: (tool: Tool) => void;
  select: (s: Selection | null) => void;
  setHover: (s: Selection | null) => void;
  setView: (v: View) => void;
  setViewMode: (m: ViewMode) => void;
  requestFit: () => void;
  fitDone: () => void;
  setPointer: (p: Vec2 | null) => void;
  /** Called when another project opens. */
  reset: () => void;
}

const initialViewMode = (): ViewMode =>
  typeof window !== 'undefined' && window.innerWidth < 900 ? 'plan' : 'split';

export const useEditor = create<EditorState>((set) => ({
  tool: 'select',
  selection: null,
  hover: null,
  view: null,
  viewMode: initialViewMode(),
  fitRequested: true,
  pointer: null,
  wallThickness: 0.1,
  setWallThickness: (wallThickness) => set({ wallThickness }),
  setTool: (tool) => set({ tool, hover: null }),
  select: (selection) => set({ selection }),
  setHover: (hover) => set({ hover }),
  setView: (view) => set({ view }),
  setViewMode: (viewMode) => set({ viewMode, fitRequested: true }),
  requestFit: () => set({ fitRequested: true }),
  fitDone: () => set({ fitRequested: false }),
  setPointer: (pointer) => set({ pointer }),
  reset: () => set({ tool: 'select', selection: null, hover: null, fitRequested: true }),
}));

export const sameSelection = (a: Selection | null, b: Selection | null) =>
  a?.kind === b?.kind && a?.id === b?.id;
