import { FURNITURE, type FurnitureKind, type OpeningKind, customKind } from '@dhd/core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Tool, useEditor } from '../editor';
import { addModelFile } from '../models';
import { TOOL_HINTS } from '../plan/tools';
import { OPENING_PRESETS, type Preset, THICKNESS_PRESETS } from '../presets';
import { useStore } from '../store';
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
  { id: 'furniture', label: 'Furniture', key: 'I', icon: icons.furniture },
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
  // Where the chips scroll sideways (phones), keep the picked one in view.
  const list = useRef<HTMLUListElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new pick
  useEffect(() => {
    const ul = list.current;
    const on = ul?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!ul || !on || ul.scrollWidth <= ul.clientWidth) return;
    ul.scrollLeft = on.offsetLeft - ul.offsetLeft - (ul.clientWidth - on.offsetWidth) / 2;
  }, [value]);
  return (
    <section className="tool-options" aria-labelledby={id}>
      <h3 id={id} className="panel-heading">
        {title}
      </h3>
      <ul className="choice-list" ref={list}>
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

export function ToolOptions({ tool, idPrefix = '' }: { tool: Tool; idPrefix?: string }) {
  const thickness = useEditor((s) => s.wallThickness);
  const widths = useEditor((s) => s.openingWidths);
  const { setWallThickness, setOpeningWidth } = useEditor.getState();
  if (tool === 'wall' || tool === 'room') {
    return (
      <Choices
        id={`${idPrefix}wall-opts`}
        title="New walls"
        presets={THICKNESS_PRESETS}
        value={thickness}
        onPick={setWallThickness}
      />
    );
  }
  if (tool === 'furniture') return <Catalogue idPrefix={idPrefix} />;
  if (tool === 'door' || tool === 'window' || tool === 'passage') {
    return (
      <Choices
        id={`${idPrefix}opening-opts`}
        title={OPENING_TITLES[tool]}
        presets={OPENING_PRESETS[tool]}
        value={widths[tool]}
        onPick={(w) => setOpeningWidth(tool, w)}
      />
    );
  }
  return null;
}

/** The furniture to place, by room, with a filter. */
function Catalogue({ idPrefix }: { idPrefix: string }) {
  const picked = useEditor((s) => s.furnitureKind);
  const pick = useEditor.getState().setFurnitureKind;
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  // The piece that is armed stays in view, so a filter never hides what a tap will place.
  const matches = (k: FurnitureKind) =>
    !q ||
    k.id === picked ||
    k.name.toLowerCase().includes(q) ||
    k.category.toLowerCase().includes(q);
  const shown = FURNITURE.filter(matches);
  const models = useStore((s) => s.editor.doc.models);
  const viewer = useStore((s) => s.role === 'viewer');
  const own = Object.values(models ?? {})
    .map(customKind)
    .filter((k) => matches(k) || (q && 'your models'.includes(q)));
  const groups = [...new Set(shown.map((k) => k.category))];
  const cm = (m: number) => Math.round(m * 100);
  const piece = (k: FurnitureKind, thumb: ReactNode) => (
    <li key={k.id}>
      <button type="button" aria-pressed={picked === k.id} onClick={() => pick(k.id)}>
        {thumb}
        <span className="catalogue-name">{k.name}</span>
        <span className="choice-note num">
          {cm(k.size.w)} × {cm(k.size.d)}
        </span>
      </button>
    </li>
  );
  return (
    <section className="tool-options catalogue" aria-labelledby={`${idPrefix}catalogue`}>
      <h3 id={`${idPrefix}catalogue`} className="panel-heading">
        Pick a piece
      </h3>
      <input
        className="input"
        type="search"
        placeholder="Find, e.g. bed or sofa"
        aria-label="Find furniture"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="catalogue-list">
        <div className="catalogue-group">
          <p className="catalogue-heading">Your models</p>
          <ul className="choice-list">
            {own.map((k) =>
              piece(
                k,
                <span className="catalogue-thumb catalogue-thumb-own" aria-hidden="true">
                  <CubeIcon />
                </span>,
              ),
            )}
            {!viewer && (
              <li>
                <UploadModel />
              </li>
            )}
          </ul>
        </div>
        {groups.map((g) => (
          <div key={g} className="catalogue-group">
            <p className="catalogue-heading">{g}</p>
            <ul className="choice-list">
              {shown
                .filter((k) => k.category === g)
                .map((k) =>
                  piece(
                    k,
                    // Rendered by tools/models/thumbs.mjs from the 3D view's own pieces.
                    <img
                      className="catalogue-thumb"
                      src={`/models/thumbs/${k.id}.webp`}
                      alt=""
                      width={36}
                      height={36}
                      loading="lazy"
                    />,
                  ),
                )}
            </ul>
          </div>
        ))}
      </div>
      {q && !shown.some((k) => k.id !== picked) && (
        <p className="field-hint">Nothing called that yet.</p>
      )}
    </section>
  );
}

/** A furniture model of your own (.glb): picked from the device, then placed like any piece. */
function UploadModel() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>
        <span className="catalogue-thumb catalogue-thumb-own" aria-hidden="true">
          +
        </span>
        <span className="catalogue-name">{busy ? 'Reading the model…' : 'Upload a model'}</span>
        <span className="choice-note">.glb, up to 20 MB</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".glb,model/gltf-binary"
        hidden
        aria-label="Model file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          setBusy(true);
          const problem = await addModelFile(file).catch(() => 'That model couldn’t be added.');
          setBusy(false);
          if (problem) useStore.setState({ notice: problem });
        }}
      />
    </>
  );
}

function CubeIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    >
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </svg>
  );
}

/**
 * On phones and tablets the palette is a bar of icons, so the active tool's name, options
 * and hint show at the top of the details panel instead (and Set scale's plan-image
 * controls with them).
 */
export function ToolPanel() {
  const tool = useEditor((s) => s.tool);
  const only3d = useEditor((s) => s.viewMode === '3d');
  const viewer = useStore((s) => s.role === 'viewer');
  if (tool === 'select' || only3d || viewer) return null;
  const def = TOOLS.find((t) => t.id === tool);
  return (
    <section className="tool-panel" aria-label={`${def?.label ?? 'Tool'} tool`}>
      <p className="tool-panel-title">{def?.label}</p>
      {/* Options first: on a phone the panel is short, and the hint can wait below. */}
      <ToolOptions tool={tool} idPrefix="panel-" />
      <p className="tool-panel-hint">{TOOL_HINTS[tool]}</p>
      {tool === 'calibrate' && <PlanImagePanel />}
    </section>
  );
}

export function Palette() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const only3d = useEditor((s) => s.viewMode === '3d');
  const viewer = useStore((s) => s.role === 'viewer');
  const locked = only3d || viewer;
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
              disabled={locked}
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
        {viewer
          ? 'This is a view-only link. Make your own copy to change the plan.'
          : only3d
            ? 'Switch to Plan or Split to draw and edit.'
            : TOOL_HINTS[tool]}
      </p>
    </nav>
  );
}
