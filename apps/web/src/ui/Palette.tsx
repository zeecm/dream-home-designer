import type { ReactNode } from 'react';
import { type Tool, useEditor } from '../editor';
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
  { id: 'measure', label: 'Measure', key: 'M', icon: icons.measure },
];

export function Palette() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
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
    </nav>
  );
}
