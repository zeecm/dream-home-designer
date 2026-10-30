import type { ReactNode } from 'react';
import { type Tool, useEditor } from '../editor';
import { TOOL_HINTS } from '../plan/tools';
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

const THICKNESSES = [
  { value: 0.1, label: '100 mm', note: 'inside walls' },
  { value: 0.15, label: '150 mm', note: '' },
  { value: 0.2, label: '200 mm', note: 'outer walls' },
];

function WallOptions() {
  const thickness = useEditor((s) => s.wallThickness);
  const set = useEditor((s) => s.setWallThickness);
  return (
    <section className="tool-options" aria-labelledby="wall-opts">
      <h3 id="wall-opts" className="panel-heading">
        New walls
      </h3>
      <ul className="choice-list">
        {THICKNESSES.map((t) => (
          <li key={t.value}>
            <button type="button" aria-pressed={thickness === t.value} onClick={() => set(t.value)}>
              <span className="num">{t.label}</span>
              {t.note && <span className="choice-note">{t.note}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
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
      {(tool === 'wall' || tool === 'room') && <WallOptions />}
      <PlanImagePanel />
      <p className="tool-hint">
        {only3d ? 'Switch to Plan or Split to draw and edit.' : TOOL_HINTS[tool]}
      </p>
    </nav>
  );
}
