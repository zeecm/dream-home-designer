import type { OpeningKind } from '@dhd/core';
import type { ReactNode } from 'react';
import { type Tool, useEditor } from '../editor';
import { TOOL_HINTS } from '../plan/tools';
import { OPENING_PRESETS, type Preset, THICKNESS_PRESETS } from '../presets';
import { PlanImagePanel } from './PlanImage';
import { icons } from './icons';

export interface ToolDef {
  id: Tool;
  label: string;
  key: string;
  icon: ReactNode;
}

/** Tools in the order people use them: look, draw, cut openings, check. */
export const TOOLS: ToolDef[] = [
  { id: 'select', label: 'Select', key: 'V', icon: icons.select },
  { id: 'wall', label: 'Wall', key: 'W', icon: icons.wall },
  { id: 'room', label: 'Room', key: 'R', icon: icons.room },
  { id: 'door', label: 'Door', key: 'D', icon: icons.door },
  { id: 'window', label: 'Window', key: 'N', icon: icons.window },
  { id: 'passage', label: 'Opening', key: 'O', icon: icons.passage },
  { id: 'measure', label: 'Measure', key: 'M', icon: icons.measure },
  { id: 'calibrate', label: 'Set scale', key: 'C', icon: icons.calibrate },
];

function Choices({
  id,
  title,
  presets,
  value,
  onPick,
}: {
  id: string;
  title: string;
  presets: Preset[];
  value: number;
  onPick: (v: number) => void;
}) {
  return (
    <section className="tool-options" aria-labelledby={id}>
      <h3 id={id} className="panel-heading">
        {title}
      </h3>
      <ul className="choice-list">
        {presets.map((t) => (
          <li key={t.value}>
            <button type="button" aria-pressed={value === t.value} onClick={() => onPick(t.value)}>
              <span className="num">{t.label}</span>
              {t.note && <span className="choice-note">{t.note}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const OPENING_TITLES: Record<OpeningKind, string> = {
  door: 'Door width',
  window: 'Window width',
  passage: 'Opening width',
};

function ToolOptions({ tool }: { tool: Tool }) {
  const thickness = useEditor((s) => s.wallThickness);
  const widths = useEditor((s) => s.openingWidths);
  const { setWallThickness, setOpeningWidth } = useEditor.getState();
  if (tool === 'wall' || tool === 'room') {
    return (
      <Choices
        id="wall-opts"
        title="New walls"
        presets={THICKNESS_PRESETS}
        value={thickness}
        onPick={setWallThickness}
      />
    );
  }
  if (tool === 'door' || tool === 'window' || tool === 'passage') {
    return (
      <Choices
        id="opening-opts"
        title={OPENING_TITLES[tool]}
        presets={OPENING_PRESETS[tool]}
        value={widths[tool]}
        onPick={(w) => setOpeningWidth(tool, w)}
      />
    );
  }
  return null;
}

export function Palette() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const only3d = useEditor((s) => s.viewMode === '3d');
  return (
    <nav className="panel palette" aria-label="Tools">
      <h2 className="panel-heading">Tools</h2>
      <ul className="tool-list">
        {TOOLS.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="tool"
              aria-pressed={tool === t.id}
              disabled={only3d}
              onClick={() => setTool(t.id)}
              title={`${t.label} (${t.key})`}
            >
              <span className="tool-icon">{t.icon}</span>
              <span className="tool-label">{t.label}</span>
              <kbd className="tool-key">{t.key}</kbd>
            </button>
          </li>
        ))}
      </ul>
      <ToolOptions tool={tool} />
      <PlanImagePanel />
      <p className="tool-hint">
        {only3d ? 'Switch to Plan or Split to draw and edit.' : TOOL_HINTS[tool]}
      </p>
    </nav>
  );
}
